import type { Hex } from "viem";

/**
 * 2026-10-18 (owner): an ntfy alarm when a testnet stack's working wallets run
 * low: the deployer (gas top-ups and the pool recycler) below 2 MON, the reveal
 * keeper below 0.5 MON. A wallet below its floor is reported once, again every
 * `repeatMs` while it stays low, and once more when it is back above.
 */
export interface Watched {
  readonly label: string;
  readonly address: Hex;
  readonly floorWei: bigint;
}

export interface BalanceAlarmOptions {
  readonly watched: readonly Watched[];
  readonly balance: (address: Hex) => Promise<bigint>;
  readonly notify: (title: string, body: string, priority: "high" | "default") => Promise<void>;
  readonly chainLabel: string;
  readonly repeatMs?: number;
  readonly now?: () => number;
  readonly log: (line: string) => void;
}

export const DEPLOYER_FLOOR_WEI = 2n * 10n ** 18n;
export const KEEPER_FLOOR_WEI = 5n * 10n ** 17n;

const mon = (w: bigint) => (Number(w) / 1e18).toFixed(3);

export class BalanceAlarm {
  private readonly lowSince = new Map<Hex, number>();
  private readonly lastSent = new Map<Hex, number>();

  private readonly o: BalanceAlarmOptions;

  constructor(o: BalanceAlarmOptions) {
    this.o = o;
  }

  /** One check of every watched wallet; returns the alerts it sent. */
  async check(): Promise<string[]> {
    const now = this.o.now?.() ?? Date.now();
    const repeat = this.o.repeatMs ?? 6 * 3_600_000;
    const sent: string[] = [];
    for (const w of this.o.watched) {
      let have: bigint;
      try {
        have = await this.o.balance(w.address);
      } catch (err) {
        this.o.log(
          `balance alarm: could not read ${w.label}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      const low = have < w.floorWei;
      if (low) {
        if (!this.lowSince.has(w.address)) this.lowSince.set(w.address, now);
        const last = this.lastSent.get(w.address);
        if (last !== undefined && now - last < repeat) continue;
        const body = `${this.o.chainLabel}: the ${w.label} ${w.address} holds ${mon(have)} MON, below its ${mon(w.floorWei)} MON floor. Send it MON.`;
        if (await this.send(`Vivarium: ${w.label} low on MON`, body, "high")) {
          this.lastSent.set(w.address, now);
          sent.push(body);
        }
      } else if (this.lowSince.has(w.address)) {
        const body = `${this.o.chainLabel}: the ${w.label} ${w.address} is back to ${mon(have)} MON, above its ${mon(w.floorWei)} MON floor.`;
        if (await this.send(`Vivarium: ${w.label} refilled`, body, "default")) {
          this.lowSince.delete(w.address);
          this.lastSent.delete(w.address);
          sent.push(body);
        }
      }
    }
    return sent;
  }

  private async send(title: string, body: string, priority: "high" | "default"): Promise<boolean> {
    try {
      await this.o.notify(title, body, priority);
      this.o.log(`balance alarm: ${body}`);
      return true;
    } catch (err) {
      this.o.log(
        `balance alarm: could not reach ntfy: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }
}

/** Posts to an ntfy topic; the topic is a secret, so a failure names only the status. */
export function ntfyNotifier(server: string, topic: string) {
  return async (title: string, body: string, priority: "high" | "default") => {
    const res = await fetch(`${server.replace(/\/$/, "")}/${topic}`, {
      method: "POST",
      body,
      headers: { Title: title, Priority: priority },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
  };
}
