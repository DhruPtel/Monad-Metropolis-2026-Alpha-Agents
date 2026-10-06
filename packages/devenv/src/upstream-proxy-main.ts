import { startUpstreamProxy } from "./upstream-proxy.ts";

/**
 * The retrying upstream proxy as a process of its own (L-91): a caller that
 * blocks its event loop (forge through spawnSync) must not stall anvil's
 * requests. The upstream URLs arrive in UPSTREAM_PROXY_URLS (a JSON array),
 * never on the command line; the proxy's URL is printed on stdout once, and
 * its log lines go to stderr. It stops on SIGTERM or when its parent exits.
 */
const upstreams = JSON.parse(process.env.UPSTREAM_PROXY_URLS ?? "[]") as string[];
const proxy = await startUpstreamProxy({
  upstreams,
  log: (line) => process.stderr.write(`${line}\n`),
});
process.stdout.write(`PROXY_URL ${proxy.url}\n`);
const stop = async () => {
  process.stderr.write(`the upstream proxy retried ${proxy.retries()} requests\n`);
  await proxy.stop();
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
// An orphaned proxy ends when its parent does.
process.on("disconnect", () => void stop());
