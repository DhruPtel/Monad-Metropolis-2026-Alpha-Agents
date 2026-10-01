/**
 * The dev console is local-only. It refuses to start unless APP_ENV is local
 * (or unset, which means local), it binds only to 127.0.0.1, and it answers
 * only requests addressed to 127.0.0.1 or localhost, which also blocks DNS
 * rebinding from a web page.
 */
export const CONSOLE_HOST = "127.0.0.1";
export const CONSOLE_PORT = 3001;

export class ConsoleRefusedError extends Error {
  constructor(reason: string) {
    super(`The dev console only runs in the local environment: ${reason}.`);
    this.name = "ConsoleRefusedError";
  }
}

export function assertConsoleEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const raw = env.APP_ENV;
  if (raw === undefined) return;
  const value = raw.trim();
  if (value !== "local") {
    throw new ConsoleRefusedError(
      value === "" ? "APP_ENV is set but empty" : `APP_ENV is ${value}, not local`,
    );
  }
}

/** The Next.js command line for the console. The host is always 127.0.0.1. */
export function consoleNextArgs(mode: "dev" | "start", port: number = CONSOLE_PORT): string[] {
  return [mode, "--hostname", CONSOLE_HOST, "--port", String(port)];
}

/** True for a Host header naming this machine: 127.0.0.1 or localhost, any port. */
export function isLocalHostHeader(host: string | null | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, "").toLowerCase();
  return name === CONSOLE_HOST || name === "localhost";
}
