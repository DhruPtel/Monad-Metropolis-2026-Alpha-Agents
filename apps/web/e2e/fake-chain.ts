import { LOCAL_FORK_CHAIN_ID } from "@alpha-agents/config";
import { AGENT_MAX_SUPPLY, SPECIES } from "@alpha-agents/domain";
import type { Page, Route } from "@playwright/test";
import {
  type Address,
  type Hex,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  zeroAddress,
} from "viem";
import { AGENT_NFT_ABI, agentNftDeployment } from "../src/agent/agent-nft";

/**
 * A stand-in for the local fork's JSON-RPC, for the screenshot suite, which
 * runs in the pinned Playwright image where no fork is reachable. It answers
 * exactly the reads the portal and the mint page make of AgentNFT (Transfer
 * and AgentMinted logs, ownerOf, speciesOf, tbaOf, ownerEpoch, hasMinted,
 * totalMinted, MAX_SUPPLY, remainingOf) from an in-memory set of agents,
 * which a test changes to move ownership or reveal an agent. It also takes a
 * `mintWithClaim` sent by the mock wallet, and can hold the receipt so a test
 * sees the mint in flight. The live suite (live.spec.ts) runs the same pages
 * against the real fork.
 */
export interface FakeAgent {
  readonly id: bigint;
  owner: Address;
  /** 0 until revealed, then 1 to 25. */
  species: number;
  readonly tba: Address;
  ownerEpoch: bigint;
  /** Every wallet the agent was ever transferred to, mint first. */
  readonly receivedBy: Address[];
}

const deployment = agentNftDeployment("local");
if (!deployment) throw new Error("AgentNFT has no verified local address in the address book");
export const AGENT_NFT = deployment.address;
const FIRST_BLOCK = deployment.fromBlock;
const HEAD = FIRST_BLOCK + 100n;
const hex = (n: bigint) => `0x${n.toString(16)}` as Hex;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export interface FakeChainOptions {
  /** The latest block. Defaults to just after AgentNFT's deployment block. */
  readonly head?: bigint;
  /** Makes this chain's block hashes differ from another fake chain's. */
  readonly hashSeed?: string;
  /** Whether AgentNFT has code here (false: a chain it was never deployed on). */
  readonly agentNft?: boolean;
}

export class FakeChain {
  readonly agents = new Map<bigint, FakeAgent>();
  /**
   * The supply as a test sets it: the minted count and the deck per species
   * (25 counts). Unset, both follow the agents: every agent is minted, and
   * each revealed one has left the deck.
   */
  supply: { totalMinted: number; remaining: number[] } | null = null;
  /** While true, a sent mint has no receipt yet: the mint stays in flight. */
  holdReceipts = false;
  /**
   * A wallet the fork holds transactions for, numbered ahead of the fork's
   * nonce, as after a fork reset (P2-U1 step 0): anvil's txpool lists them as
   * queued, and a mint sent now carries the lowest of them. Unset, the fake
   * serves no txpool, as a real network would not.
   */
  stuck: { readonly wallet: Address; readonly forkNonce: number; queued: number[] } | null = null;
  private readonly sent = new Map<Hex, bigint>();
  /**
   * P2-U7: any other transaction the mock wallet sends (approve, deposit,
   * withdraw, a grant), recorded and handed to `onSend`, which may refuse it
   * by throwing; its receipt succeeds unless `revertNext` is set.
   */
  readonly transactions: { hash: Hex; from: Address; to: Address; data: Hex; reverted: boolean }[] =
    [];
  /** Every handler sees each sent transaction (trading, credits); one may refuse it by throwing. */
  readonly handlers: ((tx: { from: Address; to: Address; data: Hex }) => void)[] = [];
  set onSend(h: (tx: { from: Address; to: Address; data: Hex }) => void) {
    this.handlers.push(h);
  }
  revertNext = false;
  /** ERC-20 balances the fake answers `balanceOf` with, by token then holder (lowercase). */
  readonly erc20 = new Map<string, Map<string, bigint>>();
  /** The next eth_call to this address reverts with this error data (a named custom error). */
  revertCall: { to: Address; data: Hex } | null = null;
  setBalance(token: Address, holder: Address, amount: bigint) {
    const m = this.erc20.get(token.toLowerCase()) ?? new Map<string, bigint>();
    m.set(holder.toLowerCase(), amount);
    this.erc20.set(token.toLowerCase(), m);
  }
  balanceOf(token: Address, holder: Address): bigint {
    return this.erc20.get(token.toLowerCase())?.get(holder.toLowerCase()) ?? 0n;
  }
  private readonly head: bigint;
  private readonly hashSeed: string;
  private readonly agentNft: boolean;

  constructor(options: FakeChainOptions = {}) {
    this.head = options.head ?? HEAD;
    this.hashSeed = options.hashSeed ?? "f0";
    this.agentNft = options.agentNft ?? true;
  }

  /** Mints an agent to a wallet, revealed as `species` (0 for unrevealed). */
  mint(id: bigint, owner: Address, species: number): FakeAgent {
    const agent: FakeAgent = {
      id,
      owner,
      species,
      tba: `0x${"7ba".padEnd(37, "0")}${id.toString(16).padStart(3, "0")}` as Address,
      ownerEpoch: 0n,
      receivedBy: [owner],
    };
    this.agents.set(id, agent);
    return agent;
  }

  /** Sets the supply: the minted count and the deck per species (25 counts). */
  setSupply(totalMinted: number, remaining: number[]): void {
    if (remaining.length !== SPECIES.length) throw new Error("remaining needs 25 counts");
    this.supply = { totalMinted, remaining };
  }

  private totalMinted(): number {
    return this.supply?.totalMinted ?? this.agents.size;
  }

  private remainingOf(species: number): number {
    if (this.supply) return this.supply.remaining[species - 1] ?? 0;
    const drawn = [...this.agents.values()].filter((a) => a.species === species).length;
    return (SPECIES[species - 1]?.count ?? 0) - drawn;
  }

  /**
   * Answers the page's requests to an RPC on 127.0.0.1 from now on: the fork's
   * port by default, or another port standing in for a wallet's other network.
   */
  async install(page: Page, port = "8545"): Promise<void> {
    await page.route(
      (url) => url.hostname === "127.0.0.1" && url.port === port,
      (route) => this.answer(route),
    );
  }

  /** A block header: the hash depends on this chain's seed and the number. */
  private block(tag: unknown) {
    const number = tag === "latest" ? this.head : BigInt(String(tag));
    if (number > this.head) return null;
    return {
      number: hex(number),
      hash: `0x${this.hashSeed}${number.toString(16).padStart(62, "0")}`,
      timestamp: hex(1_790_000_000n + number),
      baseFeePerGas: "0x1",
      gasLimit: "0x1c9c380",
      transactions: [],
    };
  }

  private async answer(route: Route): Promise<void> {
    const body = route.request().postDataJSON() as RpcRequest | RpcRequest[];
    const reply = Array.isArray(body) ? body.map((r) => this.reply(r)) : this.reply(body);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(reply) });
  }

  private reply(request: RpcRequest) {
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id: request.id, result });
    const fail = (code: number, message: string) => ({
      jsonrpc: "2.0",
      id: request.id,
      error: { code, message },
    });
    switch (request.method) {
      case "eth_chainId":
        return ok(hex(BigInt(LOCAL_FORK_CHAIN_ID)));
      case "eth_blockNumber":
        return ok(hex(this.head));
      case "eth_getBlockByNumber":
        return ok(this.block(request.params[0]));
      case "eth_getCode": {
        const [address] = request.params as [Address];
        // Any non-empty runtime stands in for AgentNFT's.
        return ok(this.agentNft && same(address, AGENT_NFT) ? "0x6080604052" : "0x");
      }
      case "eth_getLogs":
        return ok(this.logs(request.params[0] as LogFilter));
      // What a wallet client asks before it sends: any fee and gas will do.
      case "eth_estimateGas":
        return ok("0x30000");
      case "eth_maxPriorityFeePerGas":
      case "eth_gasPrice":
        return ok("0x1");
      case "eth_getTransactionCount": {
        const [who] = request.params as [Address];
        return ok(
          this.stuck && same(who, this.stuck.wallet) ? hex(BigInt(this.stuck.forkNonce)) : "0x0",
        );
      }
      case "txpool_content": {
        if (!this.stuck) return fail(-32601, "the fake chain does not serve txpool_content");
        const queued = Object.fromEntries(
          this.stuck.queued.map((n) => [
            String(n),
            { nonce: hex(BigInt(n)), hash: `0x${"e".repeat(64)}` },
          ]),
        );
        return ok({ pending: {}, queued: { [this.stuck.wallet]: queued } });
      }
      case "eth_getTransactionByHash": {
        const [hash] = request.params as [Hex];
        if (!this.stuck || !this.sent.has(hash)) return ok(null);
        return ok({ hash, nonce: hex(BigInt(this.stuck.queued[0] ?? 0)), blockNumber: null });
      }
      case "eth_sendTransaction":
        return ok(this.send(request.params[0] as { from: Address; to: Address; data: Hex }));
      case "eth_getTransactionReceipt":
        return ok(this.receipt(request.params[0] as Hex));
      case "eth_call": {
        const call = request.params[0] as { to: Address; data: Hex };
        if (this.revertCall && same(call.to, this.revertCall.to)) {
          const data = this.revertCall.data;
          this.revertCall = null;
          return {
            jsonrpc: "2.0",
            id: request.id,
            error: { code: 3, message: "execution reverted", data },
          };
        }
        // ERC-20 balanceOf(address): the selector 0x70a08231 and one padded address.
        if (!same(call.to, AGENT_NFT) && call.data.startsWith("0x70a08231")) {
          const holder = `0x${call.data.slice(34, 74)}` as Address;
          return ok(`0x${this.balanceOf(call.to, holder).toString(16).padStart(64, "0")}`);
        }
        // D-315: a token-bound account's execute, simulated before the owner sends it.
        if (call.data.startsWith("0x51945447"))
          return ok(encodeAbiParameters([{ type: "bytes" }], ["0x"]));
        if (!same(call.to, AGENT_NFT)) return ok("0x");
        const result = this.call(call.data);
        return result === undefined ? fail(3, "execution reverted") : ok(result);
      }
      default:
        return fail(-32601, `the fake chain does not serve ${request.method}`);
    }
  }

  private call(data: Hex): Hex | undefined {
    const { functionName, args } = decodeFunctionData({ abi: AGENT_NFT_ABI, data });
    const encode = (result: unknown) =>
      encodeFunctionResult({ abi: AGENT_NFT_ABI, functionName, result } as never);
    if (functionName === "totalMinted") return encode(this.totalMinted());
    if (functionName === "MAX_SUPPLY") return encode(BigInt(AGENT_MAX_SUPPLY));
    if (functionName === "remainingOf") return encode(BigInt(this.remainingOf(Number(args[0]))));
    if (functionName === "hasMinted") {
      const wallet = args[0] as Address;
      return encode([...this.agents.values()].some((a) => same(a.receivedBy[0] ?? "", wallet)));
    }
    const agent = this.agents.get(args?.[0] as bigint);
    if (!agent) return undefined;
    switch (functionName) {
      case "ownerOf":
        return encode(agent.owner);
      case "speciesOf":
        return encode(agent.species);
      case "tbaOf":
        return encode(agent.tba);
      case "ownerEpoch":
        return encode(agent.ownerEpoch);
      default:
        return undefined;
    }
  }

  /** A mint from the mock wallet: a new unrevealed agent for the sender; any other call is recorded. */
  private send(tx: { from: Address; to: Address; data: Hex }): Hex {
    if (!same(tx.to, AGENT_NFT)) {
      const reverted = this.revertNext;
      this.revertNext = false;
      if (!reverted) for (const h of this.handlers) h(tx);
      const hash = `0x${(this.transactions.length + 1).toString(16).padStart(64, "d")}` as Hex;
      this.transactions.push({ hash, ...tx, reverted });
      return hash;
    }
    const { functionName } = decodeFunctionData({ abi: AGENT_NFT_ABI, data: tx.data });
    if (functionName !== "mintWithClaim") {
      throw new Error(`the fake chain does not take ${functionName}`);
    }
    const id = BigInt(this.agents.size + 1);
    this.mint(id, tx.from, 0);
    const hash = `0x${id.toString(16).padStart(64, "c")}` as Hex;
    this.sent.set(hash, id);
    return hash;
  }

  private receipt(hash: Hex) {
    const other = this.transactions.find((x) => x.hash === hash);
    if (other)
      return this.holdReceipts
        ? null
        : {
            blockNumber: hex(this.head),
            blockHash: `0x${"b".repeat(64)}`,
            transactionHash: hash,
            transactionIndex: "0x0",
            from: other.from,
            to: other.to,
            contractAddress: null,
            cumulativeGasUsed: "0x30000",
            gasUsed: "0x30000",
            effectiveGasPrice: "0x1",
            logsBloom: `0x${"0".repeat(512)}`,
            status: other.reverted ? "0x0" : "0x1",
            type: "0x2",
            logs: [],
          };
    const id = this.sent.get(hash);
    const agent = id === undefined ? undefined : this.agents.get(id);
    if (!agent || this.holdReceipts) return null;
    const block = { blockNumber: hex(this.head), blockHash: `0x${"b".repeat(64)}` };
    return {
      ...block,
      transactionHash: hash,
      transactionIndex: "0x0",
      from: agent.receivedBy[0],
      to: AGENT_NFT,
      contractAddress: null,
      cumulativeGasUsed: "0x30000",
      gasUsed: "0x30000",
      effectiveGasPrice: "0x1",
      logsBloom: `0x${"0".repeat(512)}`,
      status: "0x1",
      type: "0x2",
      logs: this.agentLogs(agent, 0).map((log, i) => ({
        ...log,
        ...block,
        transactionHash: hash,
        logIndex: hex(BigInt(i)),
      })),
    };
  }

  /** An agent's Transfer events (mint first) and its AgentMinted event. */
  private agentLogs(agent: FakeAgent, first: number) {
    const logs = [];
    let from: Address = zeroAddress;
    let index = first;
    const entry = (topics: (Hex | Hex[] | null)[], data: Hex) => ({
      address: AGENT_NFT,
      topics,
      data,
      blockNumber: hex(FIRST_BLOCK + BigInt(index)),
      blockHash: `0x${(index + 1).toString(16).padStart(64, "0")}`,
      transactionHash: `0x${(index + 1).toString(16).padStart(64, "a")}`,
      transactionIndex: "0x0",
      logIndex: hex(BigInt(index)),
      removed: false,
    });
    for (const holder of agent.receivedBy) {
      logs.push(
        entry(
          encodeEventTopics({
            abi: AGENT_NFT_ABI,
            eventName: "Transfer",
            args: { from, to: holder, tokenId: agent.id },
          }),
          "0x",
        ),
      );
      if (from === zeroAddress) {
        logs.push(
          entry(
            encodeEventTopics({
              abi: AGENT_NFT_ABI,
              eventName: "AgentMinted",
              args: { agentId: agent.id, owner: holder },
            }),
            encodeAbiParameters([{ type: "address" }], [agent.tba]),
          ),
        );
      }
      from = holder;
      index++;
    }
    return logs;
  }

  /** Every log matching the filter's topics (null matches anything). */
  private logs(filter: LogFilter) {
    const wanted = filter.topics ?? [];
    const matches = (topics: (Hex | Hex[] | null)[]) =>
      wanted.every((w, i) => {
        if (w === null || w === undefined) return true;
        const t = topics[i];
        return typeof t === "string" && same(t, w);
      });
    let index = 0;
    const all = [];
    for (const agent of this.agents.values()) {
      const logs = this.agentLogs(agent, index);
      index += agent.receivedBy.length;
      all.push(...logs);
    }
    return all.filter((log) => matches(log.topics));
  }
}

interface RpcRequest {
  readonly id: number;
  readonly method: string;
  readonly params: unknown[];
}

interface LogFilter {
  readonly topics?: (string | null)[];
}
