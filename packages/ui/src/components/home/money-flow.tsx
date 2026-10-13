import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * UI-FAST: the home page's centerpiece, a flat map of where the money goes:
 * deposits fan out to the agents, the agents' research fans in, research
 * turns into plans, and plans settle as trades into the portfolios. Edge
 * width follows the real amount or count; an edge with activity carries
 * moving dashes, one without stays a faint dotted line. Presentational: the
 * app gives every number. Reduced motion stops the dashes (styles.css).
 */

export interface FlowAgentNode {
  readonly id: string;
  /** "#2". */
  readonly label: string;
  readonly image: string | null;
  /** The deposit into this agent, in words ("6.00 USDC"), and its weight for the edge. */
  readonly depositText: string;
  readonly deposit: number;
  /** Research runs this agent fed in, for the edge's weight and label. */
  readonly research: number;
  readonly live: boolean;
}

export interface FlowHub {
  readonly label: string;
  /** The figure under the label, as written ("11.00 USDC", "14 runs"). */
  readonly value: string;
}

export interface MoneyFlowMapProps {
  readonly deposits: FlowHub;
  readonly research: FlowHub;
  readonly plans: FlowHub;
  readonly portfolios: FlowHub;
  readonly agents: readonly FlowAgentNode[];
  /** Totals that set the hub-to-hub edges: plans formed, trades settled. */
  readonly planCount: number;
  readonly tradeCount: number;
  /** Agents left off the map, shown as one "+N more" node. */
  readonly moreAgents?: number;
  readonly caption?: ReactNode;
  readonly className?: string;
}

const W = 1000;
const ROW = 64;
const X = { deposits: 100, agents: 330, research: 590, plans: 760, portfolios: 915 } as const;
const HUB_W = 150;
const HUB_H = 54;

const curve = (x1: number, y1: number, x2: number, y2: number) => {
  const mx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
};

function Edge({ d, weight, max }: { d: string; weight: number; max: number }) {
  const active = weight > 0;
  const width = active ? 1.5 + 3.5 * (max > 0 ? weight / max : 0) : 1;
  return (
    <g data-testid="flow-edge" data-active={active ? "" : undefined}>
      <path
        d={d}
        fill="none"
        strokeWidth={width}
        strokeLinecap="round"
        className={active ? "stroke-primary-muted" : "stroke-border"}
        strokeDasharray={active ? undefined : "2 6"}
      />
      {active ? (
        <path
          d={d}
          fill="none"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeDasharray="3 25"
          className="animate-flow-dash stroke-primary"
        />
      ) : null}
    </g>
  );
}

function Hub({ x, y, hub, testId }: { x: number; y: number; hub: FlowHub; testId: string }) {
  return (
    <g data-testid={testId} transform={`translate(${x - HUB_W / 2} ${y - HUB_H / 2})`}>
      <rect
        width={HUB_W}
        height={HUB_H}
        rx={10}
        className="fill-surface-raised stroke-border-strong"
      />
      <text x={HUB_W / 2} y={22} textAnchor="middle" className="fill-foreground-muted text-xs">
        {hub.label}
      </text>
      <text
        x={HUB_W / 2}
        y={42}
        textAnchor="middle"
        className="numeric fill-foreground text-base font-semibold"
      >
        {hub.value}
      </text>
    </g>
  );
}

function MoneyFlowMap({
  deposits,
  research,
  plans,
  portfolios,
  agents,
  planCount,
  tradeCount,
  moreAgents = 0,
  caption,
  className,
}: MoneyFlowMapProps) {
  const rows = agents.length + (moreAgents > 0 ? 1 : 0);
  const H = Math.max(260, rows * ROW + 60);
  const mid = H / 2;
  const top = mid - ((rows - 1) * ROW) / 2;
  const yOf = (i: number) => top + i * ROW;
  const maxDeposit = Math.max(0, ...agents.map((a) => a.deposit));
  const maxResearch = Math.max(0, ...agents.map((a) => a.research));
  const maxHub = Math.max(planCount, tradeCount, 1);
  return (
    <figure className={cn("flex flex-col gap-3", className)} data-testid="money-flow">
      <ol
        className="grid grid-cols-2 gap-2 sm:hidden"
        aria-label="Money flow, step by step"
        data-testid="money-flow-compact"
      >
        {[deposits, research, plans, portfolios].map((h, i) => (
          <li
            key={h.label}
            className={cn(
              "flex flex-col gap-0.5 rounded-lg border bg-surface-raised p-3",
              i === 3 && "border-primary",
            )}
          >
            <span className="text-xs text-foreground-muted">
              {i + 1}. {h.label}
            </span>
            <span className="numeric text-base font-semibold">{h.value}</span>
          </li>
        ))}
      </ol>
      <div
        role="region"
        aria-label="Money flow map"
        tabIndex={0}
        className="hidden overflow-x-auto rounded-lg border bg-surface outline-none is-focus:focus-ring sm:block"
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="block h-auto w-full"
          role="img"
          aria-label={`Deposits ${deposits.value} to ${agents.length + moreAgents} agents; research ${research.value}; plans ${plans.value}; portfolios ${portfolios.value}.`}
        >
          <defs>
            {agents.map((a) => (
              <clipPath key={a.id} id={`flow-clip-${a.id}`}>
                <circle r={20} />
              </clipPath>
            ))}
          </defs>
          {agents.map((a, i) => (
            <Edge
              key={`d-${a.id}`}
              d={curve(X.deposits + HUB_W / 2, mid, X.agents - 24, yOf(i))}
              weight={a.deposit}
              max={maxDeposit}
            />
          ))}
          {agents.map((a, i) => (
            <Edge
              key={`r-${a.id}`}
              d={curve(X.agents + 125, yOf(i), X.research - HUB_W / 2, mid)}
              weight={a.research}
              max={maxResearch}
            />
          ))}
          <Edge
            d={curve(X.research + HUB_W / 2, mid, X.plans - 60, mid)}
            weight={planCount}
            max={maxHub}
          />
          <Edge
            d={curve(X.plans + 60, mid, X.portfolios - HUB_W / 2, mid)}
            weight={tradeCount}
            max={maxHub}
          />
          <Hub x={X.deposits} y={mid} hub={deposits} testId="flow-deposits" />
          <Hub x={X.research} y={mid} hub={research} testId="flow-research" />
          <g transform={`translate(${X.plans - 60} ${mid - HUB_H / 2})`} data-testid="flow-plans">
            <rect
              width={120}
              height={HUB_H}
              rx={10}
              className="fill-surface-raised stroke-border-strong"
            />
            <text x={60} y={22} textAnchor="middle" className="fill-foreground-muted text-xs">
              {plans.label}
            </text>
            <text
              x={60}
              y={42}
              textAnchor="middle"
              className="numeric fill-foreground text-base font-semibold"
            >
              {plans.value}
            </text>
          </g>
          <g
            transform={`translate(${X.portfolios - HUB_W / 2} ${mid - HUB_H / 2})`}
            data-testid="flow-portfolios"
          >
            <rect
              width={HUB_W}
              height={HUB_H}
              rx={10}
              className="fill-surface-raised stroke-primary"
            />
            <text
              x={HUB_W / 2}
              y={22}
              textAnchor="middle"
              className="fill-foreground-muted text-xs"
            >
              {portfolios.label}
            </text>
            <text
              x={HUB_W / 2}
              y={42}
              textAnchor="middle"
              className="numeric fill-foreground text-base font-semibold"
            >
              {portfolios.value}
            </text>
          </g>
          {agents.map((a, i) => (
            <g
              key={a.id}
              transform={`translate(${X.agents} ${yOf(i)})`}
              data-testid="flow-agent"
              data-agent={a.id}
            >
              <circle r={22} className="fill-surface-raised stroke-border-strong" />
              {a.image ? (
                <image
                  href={a.image}
                  x={-20}
                  y={-20}
                  width={40}
                  height={40}
                  clipPath={`url(#flow-clip-${a.id})`}
                  preserveAspectRatio="xMidYMid slice"
                />
              ) : (
                <text textAnchor="middle" y={5} className="fill-foreground-muted text-sm">
                  ?
                </text>
              )}
              {a.live ? (
                <circle cx={16} cy={-16} r={4.5} className="fill-positive stroke-surface" />
              ) : null}
              <text x={30} y={-2} className="numeric fill-foreground text-sm font-semibold">
                {a.label}
              </text>
              <text x={30} y={14} className="numeric fill-foreground-muted text-2xs">
                {a.depositText}
              </text>
            </g>
          ))}
          {moreAgents > 0 ? (
            <text
              x={X.agents}
              y={yOf(agents.length) + 5}
              textAnchor="middle"
              className="fill-foreground-muted text-xs"
            >
              +{moreAgents} more
            </text>
          ) : null}
        </svg>
      </div>
      {caption ? (
        <figcaption className="text-xs text-foreground-muted sm:line-clamp-1">{caption}</figcaption>
      ) : null}
    </figure>
  );
}

export { MoneyFlowMap };
