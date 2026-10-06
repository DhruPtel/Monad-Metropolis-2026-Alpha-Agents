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
import { resetAgentAction, runNoopTaskAction, taskAction } from "./actions";
import type { TaskView } from "./extension";
import { noopFields } from "./task-fields";

/**
 * The agents panel's controls (P1-U5): run the no-op task on one agent and
 * watch it finish, or reset an agent's runtime. The task's result shows in one
 * TaskResult card under the table, polled every two seconds until it ends.
 */
interface Shown {
  readonly name: string;
  readonly task: TaskView;
}

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
          title={`No-op task, ${shown.name}`}
          description="Starts the agent's sandbox, runs one trivial Hermes task through the gate and LiteLLM, then stops the sandbox."
          status={shown.task.status}
          fields={noopFields(shown.task.result)}
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
}: {
  agentId: string;
  name: string;
  runtime: RuntimeStatus;
  enabled: boolean;
}) {
  const ctx = useContext(TasksContext);
  const [pending, start] = useTransition();
  const ready = enabled && runtime === "ready";

  const run = () =>
    start(async () => {
      const r = await runNoopTaskAction(agentId);
      if (!r.ok) {
        toast.error("The no-op task did not start", { description: r.error });
        return;
      }
      ctx?.show({
        name,
        task: { taskId: r.value, agentId, status: "queued", result: null, error: null },
      });
    });

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
