// @ts-check
// Deploys AgentNFT (P1-U3).
//
//   pnpm deploy:agent-nft            the local fork (default; needs pnpm dev:up)
//   pnpm deploy:agent-nft testnet    Monad testnet, if MONAD_TESTNET_RPC_URL and
//                                    TESTNET_DEPLOYER_PRIVATE_KEY are set in .env
//
// Mainnet is refused: no unit has authorized a mainnet deployment.
import { NotLocalForkError } from "@alpha-agents/devenv";
import { deployLocal, deployTestnet } from "./lib/agent-nft.js";
import { loadRootEnv } from "./lib/config.js";

const target = process.argv[2] ?? "local";
loadRootEnv();
try {
  if (target === "local") await deployLocal();
  else if (target === "testnet") await deployTestnet();
  else {
    console.error(`error: unknown target "${target}"; use local or testnet (mainnet is refused)`);
    process.exit(1);
  }
} catch (err) {
  if (err instanceof NotLocalForkError) {
    console.error(`error: ${err.message} Start it with pnpm dev:up.`);
    process.exit(1);
  }
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
