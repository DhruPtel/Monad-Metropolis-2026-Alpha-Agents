/**
 * Upstream hygiene for market data (P3-U2): a timeout on every request, a
 * retry only on 429, 5xx and a dropped connection, `Retry-After` honored in
 * code, and a token bucket per provider so the platform never asks faster
 * than the provider's plan allows. A 4xx other than 429 is final. A timeout is
 * final and reported as UPSTREAM_UNAVAILABLE, retryable.
 */
export type MarketErrorCode = "UPSTREAM_UNAVAILABLE" | "RATE_LIMITED" | "STALE_DATA";

export class MarketError extends Error {
  readonly code: MarketErrorCode;
  readonly retryable: boolean;
  readonly provider: string;
  readonly status: number | null;
  readonly retryAfterSeconds: number | null;

  constructor(
    code: MarketErrorCode,
    provider: string,
    message: string,
    o: { retryable: boolean; status?: number | null; retryAfterSeconds?: number | null },
  ) {
    super(message);
    this.name = "MarketError";
    this.code = code;
    this.provider = provider;
    this.retryable = o.retryable;
    this.status = o.status ?? null;
    this.retryAfterSeconds = o.retryAfterSeconds ?? null;
  }
}

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A token bucket: `capacity` requests at once, refilled at `perMinute`.
 * `take` waits for a token, at most `maxWaitMs`; past that it refuses with
 * RATE_LIMITED rather than queueing without bound.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly capacity: number;
  private readonly perMs: number;
  private readonly now: () => number;
  private readonly sleep: Sleep;

  constructor(o: { capacity: number; perMinute: number; now?: () => number; sleep?: Sleep }) {
    this.capacity = o.capacity;
    this.tokens = o.capacity;
    this.perMs = o.perMinute / 60_000;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? realSleep;
    this.last = this.now();
  }

  private refill() {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + (t - this.last) * this.perMs);
    this.last = t;
  }

  async take(provider: string, maxWaitMs = 10_000): Promise<void> {
    this.refill();
    if (this.tokens < 1) {
      const waitMs = Math.ceil((1 - this.tokens) / this.perMs);
      if (waitMs > maxWaitMs)
        throw new MarketError(
          "RATE_LIMITED",
          provider,
          `${provider}: the platform's request rate for this provider is used up; try again shortly.`,
          { retryable: true, retryAfterSeconds: Math.ceil(waitMs / 1000) },
        );
      await this.sleep(waitMs);
      this.refill();
    }
    this.tokens -= 1;
  }
}

export interface UpstreamRequest {
  readonly provider: string;
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly timeoutMs?: number;
  /** Attempts in all, the first included. */
  readonly attempts?: number;
  /** The longest Retry-After the request will wait out; past it the 429 is returned. */
  readonly maxRetryAfterMs?: number;
}

export interface UpstreamDeps {
  readonly fetch?: typeof fetch;
  readonly sleep?: Sleep;
  readonly bucket?: TokenBucket;
}

/** Retry-After in seconds or as an HTTP date; null when absent or unreadable. */
export function retryAfterSeconds(header: string | null, nowMs = Date.now()): number | null {
  if (!header) return null;
  const n = Number(header);
  if (Number.isFinite(n) && n >= 0) return n;
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - nowMs) / 1000));
}

/** GET a JSON body under the rules above. The URL may carry no secret: keys go in headers. */
export async function getJson(req: UpstreamRequest, deps: UpstreamDeps = {}): Promise<unknown> {
  const f = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? realSleep;
  const attempts = req.attempts ?? 3;
  const maxRetryAfterMs = req.maxRetryAfterMs ?? 20_000;
  const p = req.provider;
  let last: MarketError | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await deps.bucket?.take(p);
    let res: Response;
    try {
      res = await f(req.url, {
        headers: { accept: "application/json", ...req.headers },
        signal: AbortSignal.timeout(req.timeoutMs ?? 15_000),
      });
    } catch (err) {
      const timedOut =
        err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      if (timedOut)
        throw new MarketError("UPSTREAM_UNAVAILABLE", p, `${p} did not answer in time.`, {
          retryable: true,
        });
      last = new MarketError("UPSTREAM_UNAVAILABLE", p, `${p} dropped the connection.`, {
        retryable: true,
      });
      if (attempt < attempts) await sleep(500 * 2 ** (attempt - 1));
      continue;
    }
    if (res.ok) {
      try {
        return (await res.json()) as unknown;
      } catch {
        throw new MarketError(
          "UPSTREAM_UNAVAILABLE",
          p,
          `${p} answered with a body that is not JSON.`,
          {
            retryable: true,
            status: res.status,
          },
        );
      }
    }
    if (res.status === 429) {
      const after = retryAfterSeconds(res.headers.get("retry-after"));
      last = new MarketError(
        "RATE_LIMITED",
        p,
        `${p} is rate limiting the platform; try again shortly.`,
        {
          retryable: true,
          status: 429,
          retryAfterSeconds: after,
        },
      );
      const waitMs = (after ?? 2 ** attempt) * 1000;
      if (attempt < attempts && waitMs <= maxRetryAfterMs) {
        await sleep(waitMs);
        continue;
      }
      throw last;
    }
    if (res.status >= 500) {
      last = new MarketError("UPSTREAM_UNAVAILABLE", p, `${p} answered ${res.status}.`, {
        retryable: true,
        status: res.status,
      });
      if (attempt < attempts) await sleep(500 * 2 ** (attempt - 1));
      continue;
    }
    // Any other answer is about the request: retrying would not change it.
    throw new MarketError("UPSTREAM_UNAVAILABLE", p, `${p} refused the request (${res.status}).`, {
      retryable: false,
      status: res.status,
    });
  }
  throw (
    last ?? new MarketError("UPSTREAM_UNAVAILABLE", p, `${p} is unavailable.`, { retryable: true })
  );
}
