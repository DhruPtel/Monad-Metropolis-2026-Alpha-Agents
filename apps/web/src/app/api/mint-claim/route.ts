import { randomBytes } from "node:crypto";
import {
  LOCAL_FORK_RPC_URL,
  appChain,
  loadConfig,
  type Secret,
  webEnvironment,
} from "@alpha-agents/config";
import { sessionVerifier, walletsOf } from "#server-identity";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AGENT_NFT_ABI, agentNftDeployment } from "@/agent/agent-nft";
import { type ClaimSigner, mintClaimResponse } from "@/server/mint-claim";

// Signs a mint claim for the caller's own wallet, on the local fork only (D-194).
export const dynamic = "force-dynamic";

/** The local dev signer from LOCAL_CLAIM_SIGNER_PRIVATE_KEY, read at request time, never bundled. */
function localSigner(): ClaimSigner | null {
  try {
    const config = loadConfig(
      { name: "web claim route", usesChain: false, requires: ["LOCAL_CLAIM_SIGNER_PRIVATE_KEY"] },
      process.env,
    );
    const key = (config.values.LOCAL_CLAIM_SIGNER_PRIVATE_KEY as Secret).reveal() as `0x${string}`;
    return privateKeyToAccount(key);
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<Response> {
  const environment = webEnvironment(process.env.APP_ENV);
  const deployment = environment === "local" ? agentNftDeployment("local") : null;
  // The server reads the fork directly; the browser never sees this client.
  const client = createPublicClient({ transport: http(LOCAL_FORK_RPC_URL) });
  return mintClaimResponse(request, {
    environment,
    verify: environment === "local" ? sessionVerifier() : null,
    walletsOf,
    signer: environment === "local" ? localSigner() : null,
    contract: deployment?.address ?? null,
    chainId: appChain(environment).id,
    hasMinted: (wallet) =>
      deployment
        ? client.readContract({
            address: deployment.address,
            abi: AGENT_NFT_ABI,
            functionName: "hasMinted",
            args: [wallet],
          })
        : Promise.resolve(false),
    now: () => Date.now(),
    randomNonce: () => `0x${randomBytes(32).toString("hex")}`,
  });
}
