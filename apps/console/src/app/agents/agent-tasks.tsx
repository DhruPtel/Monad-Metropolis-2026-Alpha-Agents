"use client";

import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  type RuntimeStatus,
  TaskResult,
  toast,
} from "@alpha-agents/ui";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useTransition,
} from "react";
import {
  fundAgentAction,
  refundAgentAction,
  refundStatusAction,
  resetAgentAction,
  runNoopTaskAction,
  runScanAction,
  taskAction,
} from "./actions";
import type { TaskKind, TaskView } from "./extension";
import { noopFields, scanFields } from "./task-fields";

/**
 * The agents panel's controls (P1-U5): run the no-op task on one agent and
 * watch it finish, or reset an agent's runtime. P1-U7 adds the Scan. The
 * task's result shows in one TaskResult card under the table, polled every two
 * seconds until it ends.
 */
interface Shown {
  readonly name: string;
  readonly kind: TaskKind;
  readonly task: TaskView;
}

const TASK_TEXT: Record<TaskKind, { title: string; description: string }> = {
  noop: {
    title: "No-op task",
    description:
      "Starts the agent's sandbox, runs one trivial Hermes task through the gate and LiteLLM, then stops the sandbox.",
  },
  scan: {
    title: "Scan",
    description:
      "The agent searches the web and reads pages through the metered data tools, saves its notes, and ends with complete_stage; the narrator then writes its activity entry.",
  },
};

const TasksContext = createContext<{ show: (s: Shown) => void } | null>(null);

export function AgentTasks({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState<Shown | null>(null);
  const status = shown?.task.status;
  const taskId = shown?.task.taskId;

  useEffect(() => {
    if (!taskId || (status !== "queued" && status !== "running")) return;
    const timer = setInterval(() => {
      void taskAction(taskId).then((r) => {
        if (r.ok) setShown((s) => (s && s.task.taskId === taskId ? { ...s, task: r.value } : s));
      });
    }, 2_000);
    return () => clearInterval(timer);
  }, [taskId, status]);

  return (
    <TasksContext.Provider value={{ show: setShown }}>
      {children}
      {shown ? (
        <TaskResult
          title={`${TASK_TEXT[shown.kind].title}, ${shown.name}`}
          description={TASK_TEXT[shown.kind].description}
          status={shown.task.status}
          fields={(shown.kind === "scan" ? scanFields : noopFields)(shown.task.result)}
          error={shown.task.error}
        />
      ) : null}
    </TasksContext.Provider>
  );
}

export function AgentActions({
  agentId,
  name,
  runtime,
  enabled,
  restricted = false,
  canScan = false,
}: {
  agentId: string;
  name: string;
  runtime: RuntimeStatus;
  enabled: boolean;
  /** P1-U6: no credits, so LLM tasks are refused (D-129). */
  restricted?: boolean;
  /** P1-U7: enough credits for a Scan (the minimum, D-222). */
  canScan?: boolean;
}) {
  const ctx = useContext(TasksContext);
  const [pending, start] = useTransition();
  const ready = enabled && runtime === "ready" && !restricted;

  const runTask = (kind: TaskKind) =>
    start(async () => {
      const r = await (kind === "scan" ? runScanAction : runNoopTaskAction)(agentId);
      if (!r.ok) {
        toast.error(`The ${TASK_TEXT[kind].title.toLowerCase()} did not start`, {
          description: r.error,
        });
        return;
      }
      ctx?.show({
        name,
        kind,
        task: { taskId: r.value, agentId, status: "queued", result: null, error: null },
      });
    });
  const run = () => runTask("noop");

  const reset = () =>
    start(async () => {
      const r = await resetAgentAction(agentId);
      if (r.ok) toast.success(`${name} is being reset`);
      else toast.error("The reset did not start", { description: r.error });
    });

  return (
    <div className="flex flex-nowrap gap-2">
      <Button
        size="sm"
        variant="secondary"
        disabled={!ready || pending}
        onClick={run}
        loading={pending}
      >
        Run no-op task
      </Button>
      <Button
        size="sm"
        variant="secondary"
        disabled={!ready || !canScan || pending}
        title={canScan ? undefined : "A Scan needs at least 0.15 USDC of credits"}
        onClick={() => runTask("scan")}
      >
        Run Scan
      </Button>
      <Dialog>
        <DialogTrigger asChild>
          <Button
            size="sm"
            variant="danger"
            disabled={!enabled || runtime === "not_provisioned" || pending}
          >
            Reset
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset {name}?</DialogTitle>
            <DialogDescription>
              Stops its sandbox, deletes its LiteLLM key and provisions it again with a new key and
              a fresh config.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <DialogClose asChild>
              <Button variant="danger" onClick={reset}>
                Reset
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * P1-U6: fund the agent with test USDC (sent to its funding address on the
 * local fork, credited by the indexer and orchestrator with no other step),
 * and refund its credits to its current owner, after a confirmation.
 */
export function CreditActions({
  agentId,
  name,
  enabled,
  hasCredits,
}: {
  agentId: string;
  name: string;
  enabled: boolean;
  hasCredits: boolean;
}) {
  const [pending, start] = useTransition();

  const fund = () =>
    start(async () => {
      const r = await fundAgentAction(agentId);
      if (r.ok)
        toast.success(`Sent 5 test USDC to ${name}'s funding address`, {
          description: "It shows as credits once the indexer sees the transfer.",
        });
      else toast.error("Funding failed", { description: r.error });
    });

  const refund = () =>
    start(async () => {
      const r = await refundAgentAction(agentId);
      if (!r.ok) {
        toast.error("The refund did not start", { description: r.error });
        return;
      }
      toast.info(`Refund for ${name} requested`);
      for (let i = 0; i < 60; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const s = await refundStatusAction(r.value);
        if (!s.ok) continue;
        if (s.value.status === "sent") {
          const total = BigInt(s.value.creditsUsdcE6 ?? "0") + BigInt(s.value.heldUsdcE6 ?? "0");
          toast.success(`Refunded ${(Number(total) / 1e6).toFixed(2)} USDC to ${name}'s owner`);
          return;
        }
        if (s.value.status === "refused" || s.value.status === "failed") {
          toast.error(`The refund was ${s.value.status}`, {
            description: s.value.reason ?? undefined,
          });
          return;
        }
      }
      toast.info("The refund is still in progress");
    });

  return (
    <div className="flex flex-nowrap gap-2">
      <Button size="sm" variant="secondary" disabled={!enabled || pending} onClick={fund}>
        Fund 5 USDC
      </Button>
      <Dialog>
        <DialogTrigger asChild>
          <Button size="sm" variant="secondary" disabled={!enabled || !hasCredits || pending}>
            Refund
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Refund {name}&apos;s credits?</DialogTitle>
            <DialogDescription>
              Sends its remaining credits, and any USDC held above the cap, from its funding address
              to its current owner. It stays restricted until it is funded again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <DialogClose asChild>
              <Button onClick={refund}>Refund</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
