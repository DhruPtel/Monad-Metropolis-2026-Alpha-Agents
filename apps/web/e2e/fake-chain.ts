import { LOCAL_FORK_CHAIN_ID } from "@alpha-agents/config";
import type { Page, Route } from "@playwright/test";
import {
  type Address,
  type Hex,
  decodeFunctionData,
  encodeEventTopics,
  encodeFunctionResult,
  zeroAddress,
} from "viem";
import { AGENT_NFT_ABI, agentNftDeployment } from "../src/agent/agent-nft";

/**
 * A stand-in for the local fork's JSON-RPC, for the screenshot suite, which
 * runs in the pinned Playwright image where no fork is reachable. It answers
 * exactly the reads the portal makes of AgentNFT (Transfer logs, ownerOf,
 * speciesOf, tbaOf, ownerEpoch, hasMinted, totalMinted) from an in-memory
 * set of agents, which a test changes to move ownership. The live suite
 * (live.spec.ts) runs the same pages against the real fork.
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

export class FakeChain {
  readonly agents = new Map<bigint, FakeAgent>();

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

  /** Answers the page's requests to the fork's RPC from now on. */
  async install(page: Page): Promise<void> {
    await page.route(
      (url) => url.hostname === "127.0.0.1" && url.port === "8545",
      (route) => this.answer(route),
    );
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
        return ok(hex(HEAD));
      case "eth_getLogs":
        return ok(this.transferLogs(request.params[0] as LogFilter));
      case "eth_call": {
        const call = request.params[0] as { to: Address; data: Hex };
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
    if (functionName === "totalMinted") return encode(this.agents.size);
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

  private transferLogs(filter: LogFilter) {
    const to = filter.topics?.[2];
    const logs = [];
    let index = 0;
    for (const agent of this.agents.values()) {
      let from: Address = zeroAddress;
      for (const holder of agent.receivedBy) {
        const topics = encodeEventTopics({
          abi: AGENT_NFT_ABI,
          eventName: "Transfer",
          args: { from, to: holder, tokenId: agent.id },
        });
        const toTopic = topics[2];
        if (!to || (typeof toTopic === "string" && same(toTopic, to))) {
          logs.push({
            address: AGENT_NFT,
            topics,
            data: "0x",
            blockNumber: hex(FIRST_BLOCK + BigInt(index)),
            blockHash: `0x${(index + 1).toString(16).padStart(64, "0")}`,
            transactionHash: `0x${(index + 1).toString(16).padStart(64, "a")}`,
            transactionIndex: "0x0",
            logIndex: hex(BigInt(index)),
            removed: false,
          });
        }
        from = holder;
        index++;
      }
    }
    return logs;
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
