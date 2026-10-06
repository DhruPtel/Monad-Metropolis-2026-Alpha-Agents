import { z } from "zod";

/**
 * The web provider behind web_search and read_url (D-214). Tavily in the
 * running service; a fake in tests. The API key is sent only as Tavily's
 * bearer header and appears in no error, log or result.
 */
export interface SearchHit {
  readonly title: string;
  readonly url: string;
  readonly content: string;
}

export interface PageText {
  readonly url: string;
  readonly content: string;
}

export interface WebProvider {
  readonly name: string;
  search(query: string, maxResults: number): Promise<SearchHit[]>;
  /** The page's text, or null when the provider could not read it. */
  extract(url: string): Promise<PageText | null>;
}

/** An upstream failure, already classified; never carries the request's headers. */
export class UpstreamError extends Error {
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;
  readonly status: number | null;

  constructor(
    message: string,
    retryable: boolean,
    status: number | null,
    retryAfter: number | null,
  ) {
    super(message);
    this.name = "UpstreamError";
    this.retryable = retryable;
    this.status = status;
    this.retryAfterSeconds = retryAfter;
  }
}

const SearchResponse = z.object({
  results: z.array(
    z.object({ title: z.string().nullish(), url: z.string(), content: z.string().nullish() }),
  ),
});

const ExtractResponse = z.object({
  results: z.array(z.object({ url: z.string(), raw_content: z.string().nullish() })),
});

export const TAVILY_URL = "https://api.tavily.com";

export class TavilyProvider implements WebProvider {
  readonly name = "tavily";
  private readonly key: string;
  private readonly base: string;
  private readonly timeoutMs: number;

  constructor(key: string, options: { base?: string; timeoutMs?: number } = {}) {
    if (key.length === 0) throw new Error("TAVILY_API_KEY is not set");
    this.key = key;
    this.base = options.base ?? TAVILY_URL;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      throw new UpstreamError(
        timedOut ? "the web provider timed out" : "the web provider was unreachable",
        true,
        null,
        null,
      );
    }
    if (!res.ok) {
      await res.body?.cancel();
      const after = Number(res.headers.get("retry-after"));
      const retryable = res.status === 429 || res.status >= 500;
      throw new UpstreamError(
        `the web provider answered ${res.status}`,
        retryable,
        res.status,
        Number.isFinite(after) && after > 0 ? after : null,
      );
    }
    return res.json();
  }

  async search(query: string, maxResults: number): Promise<SearchHit[]> {
    const raw = await this.post("/search", {
      query,
      search_depth: "basic",
      max_results: maxResults,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
    });
    const parsed = SearchResponse.safeParse(raw);
    if (!parsed.success)
      throw new UpstreamError("the web provider's answer was malformed", true, null, null);
    return parsed.data.results.map((r) => ({
      title: r.title ?? "",
      url: r.url,
      content: r.content ?? "",
    }));
  }

  async extract(url: string): Promise<PageText | null> {
    const raw = await this.post("/extract", { urls: [url], extract_depth: "basic" });
    const parsed = ExtractResponse.safeParse(raw);
    if (!parsed.success)
      throw new UpstreamError("the web provider's answer was malformed", true, null, null);
    const hit = parsed.data.results[0];
    if (!hit?.raw_content) return null;
    return { url: hit.url, content: hit.raw_content };
  }
}
