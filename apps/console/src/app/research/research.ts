import type { FigureWarningCode } from "@alpha-agents/ui";

/** The research sources view's data and words (P3-U9), apart from the TSX so they can be tested. */
export interface ResearchCallJson {
  readonly callId: string;
  readonly agentId: number;
  readonly server: string;
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly status: string;
  readonly errorCode: string | null;
  readonly chargeUsdcE6: string;
  readonly cacheHit: boolean;
  readonly summary: Record<string, unknown> | null;
  readonly at: string;
}

export interface ResearchJson {
  readonly sources: { readonly x: boolean; readonly dune: boolean; readonly lookup: boolean };
  readonly usage: {
    readonly xPostsRead: number;
    readonly xPostsLimit: number;
    readonly duneResultReads: number;
    readonly duneResultReadsLimit: number;
    readonly duneQueryRuns: number;
    readonly duneQueryRunsLimit: number;
  };
  readonly recent: readonly ResearchCallJson[];
  readonly cachedX: readonly {
    readonly topic: string;
    readonly windowHours: number;
    readonly query: string;
    readonly searchedAt: string;
    readonly expiresAt: string;
    readonly posts: readonly {
      readonly url: string;
      readonly createdAt: string;
      readonly text: string;
      readonly likes: number;
      readonly reposts: number;
    }[];
  }[];
  readonly cachedDune: readonly {
    readonly name: string;
    readonly title: string;
    readonly executedAt: string;
    readonly ageHours: number;
    readonly executed: boolean;
    readonly warnings: readonly { readonly code: FigureWarningCode; readonly message: string }[];
    readonly columns: readonly string[];
    readonly rows: readonly Record<string, number | string | null>[];
    readonly expiresAt: string;
  }[];
}

export const LOOKUP_TOOLS: ReadonlySet<string> = new Set(["read_contract", "balance", "get_code"]);

/** A micro-USDC charge as USDC text. */
export function usdc(e6: string): string {
  const n = Number(e6) / 1_000_000;
  return n === 0 ? "Free" : `${n.toFixed(4)} USDC`;
}

/** The one line that says what a call asked for. */
export function callSubject(c: ResearchCallJson): string {
  const i = c.input;
  const s = c.summary ?? {};
  if (c.tool === "x_search") return `${String(i.topic)}, ${String(i.windowHours ?? 24)} h`;
  if (c.tool === "dune_query") return `${String(i.query)}, ${String(i.days ?? 30)} days`;
  if (c.tool === "read_contract") return `${String(i.function)} on ${String(i.target)}`;
  if (c.tool === "balance") return `${String(i.asset)} of ${String(i.target)}`;
  if (c.tool === "get_code")
    return `${String(i.target)}${s.hasCode === false ? ", no code" : s.proxy ? `, ${String(s.proxy)}` : ""}`;
  return c.tool;
}
