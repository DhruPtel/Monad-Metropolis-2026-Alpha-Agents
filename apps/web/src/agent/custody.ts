import { PRICE_FEEDS, readableDuration } from "@alpha-agents/domain";
import {
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  isAddressEqual,
  parseAbi,
} from "viem";

/**
 * The custody calls the owner's wallet makes from the portfolio page (P2-U7):
 * open the PersonalAccount, approve exactly the deposit, deposit, withdraw and
 * claim credits. The ABIs carry the contracts' custom errors, so a revert the
 * wallet reports is named and shown in the owner's words.
 */
export const FACTORY_ABI = parseAbi([
  "function createPersonalAccount(uint256 agentId) returns (address account)",
  "function createVault(uint256 agentId) returns (address vault)",
  "error VaultExists(address vault)",
  "error VaultCapExceeded(uint256 principalAfter, uint256 cap)",
  "error PublicDepositsDisabled(address depositor)",
  "error NotAgentOwner(address caller, address agentOwner)",
  "error AccountExists(address account)",
  "error NotAllowlisted(address depositor)",
  "error PersonalCapExceeded(uint256 principalAfter, uint256 cap)",
  "error PlatformCapExceeded(uint256 totalAfter, uint256 cap)",
]);

export const ACCOUNT_ABI = parseAbi([
  "function deposit(address token, uint256 amount)",
  "function withdraw(address token, uint256 amount, address to)",
  "function withdrawAll(address to)",
  "function claim(address token, address to)",
  "error ZeroAmount()",
  "error NotHeldAsset(address token)",
  "error DepositsPaused()",
  "error DepositsAreClosed()",
  "error NotAgentOwner(address currentOwner)",
  "error NotOwner(address caller)",
  "error OracleUnset()",
  "error OracleUnavailable(address asset, uint8 reason)",
  "error NotAllowlisted(address depositor)",
  "error PersonalCapExceeded(uint256 principalAfter, uint256 cap)",
  "error PlatformCapExceeded(uint256 totalAfter, uint256 cap)",
  "error TransferNotExact(address token, uint256 received, uint256 amount)",
  "error BadRecipient(address to)",
  "error NothingToClaim(address token)",
]);

/**
 * P7-U4: the calls a wallet makes on the agent's StrategyVaultV3: deposit
 * (the leader's stake when the owner sends it), redeem for USDC, redeem in
 * kind, claim a credit, and the leader's deposits switch; with the vault's
 * errors, so a refusal is named in the holder's words.
 */
export const VAULT_ABI = parseAbi([
  "function deposit(uint256 assets, uint256 minSharesOut) returns (uint256 shares)",
  "function redeem(uint256 shares, address receiver, uint256 minAssetsOut, uint64 deadline)",
  "function redeemInKind(uint256 shares, address receiver)",
  "function claim(address token, address to)",
  "function setDepositsOpen(bool open)",
  "error ZeroAmount()",
  "error InHandover()",
  "error WindingDown()",
  "error DepositsPaused()",
  "error DepositsAreClosed()",
  "error DepositsNotOpen()",
  "error SharesTooFew(uint256 shares, uint256 minSharesOut)",
  "error LeaderStakeTooLow(uint256 leaderShares, uint256 supply)",
  "error SeedTooSmall(uint256 supply, uint256 minimum)",
  "error OutsideBand(uint256 live, uint256 ref)",
  "error InsufficientShares(uint256 held, uint256 wanted)",
  "error SharesLocked(uint256 free, uint64 unlockAt)",
  "error UseInKind(uint256 owed, uint256 usdcAboveTheFloor)",
  "error AssetsTooFew(uint256 assets, uint256 minAssetsOut)",
  "error Expired(uint64 deadline)",
  "error NotManager(address caller)",
  "error NotAllowlisted(address depositor)",
  "error VaultCapExceeded(uint256 principalAfter, uint256 cap)",
  "error PlatformCapExceeded(uint256 totalAfter, uint256 cap)",
  "error PublicDepositsDisabled(address depositor)",
  "error UsdcDepegged(uint256 priceE18)",
  "error UsdcFeedUnusable(uint8 reason)",
  "error UnpricedToken(address token)",
  "error OracleUnset()",
  "error TransferNotExact(uint256 received, uint256 amount)",
  "error BadRecipient(address to)",
  "error NothingToClaim(address token)",
]);

/**
 * F-U12: the owner's own calls on the v3 PersonalAccount: the screened-lane
 * opt-in (D-351) and the unpause after a Sentinel pause (P4-U2 follow-up).
 */
export const PERSONAL_ACCOUNT_ABI = parseAbi([
  "function setScreenedOptIn(bool optIn)",
  "function screenedOptIn() view returns (bool)",
  "function unpause()",
  "error NotOwner(address caller)",
]);

export const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address who) view returns (uint256)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
]);

/** The Executor's grant calls, with its errors, so a refused grant is named (Phase 2 tuning). */
export const GRANT_ABI = parseAbi([
  "function registerSession(uint256 agentId, address key, uint64 validUntil)",
  "function registerVaultSession(uint256 agentId, address key)",
  "function revokeSession(uint256 agentId)",
  "error NotAgentOwner(address caller)",
  "error BadSession()",
]);

/** Owner-facing text for each custody revert. */
export const CUSTODY_REVERT_MESSAGES: Readonly<Record<string, string>> = {
  NotAgentOwner: "This wallet does not own the agent.",
  AccountExists: "This agent already has a trading account for this wallet.",
  NotAllowlisted: "This wallet is not on the beta deposit allowlist yet.",
  PersonalCapExceeded: "The deposit would take the account past its beta cap.",
  PlatformCapExceeded: "The deposit would take the platform past its beta cap.",
  ZeroAmount: "Enter an amount greater than zero.",
  NotHeldAsset: "The account holds USDC and WMON only.",
  DepositsPaused: "The account is paused, so it takes no deposits. Withdrawals still work.",
  DepositsAreClosed: "Deposits to this account are closed. Withdrawals still work.",
  NotOwner: "Only the account's owner can do this.",
  OracleUnset: "The account has no price oracle, so it takes no deposits.",
  OracleUnavailable:
    "The price check failed (a stale price or USDC away from $1), so the deposit was refused. Withdrawals need no price.",
  TransferNotExact: "The token moved a different amount than asked, so the deposit was refused.",
  BadRecipient: "Withdrawals go to your own wallet.",
  NothingToClaim: "There is nothing to claim for this token.",
  BadSession:
    "The Executor refused the trading permission: its key is empty or its expiry is not within 30 days of the chain's time.",
  ERC20InsufficientBalance: "Your wallet does not hold that much.",
  VaultExists: "This agent already has a vault.",
  VaultCapExceeded: "The deposit would take the vault past its beta cap.",
  PublicDepositsDisabled:
    "Vault deposits are open to allowlisted wallets only until the launch decision.",
  InHandover:
    "The agent changed hands: the vault takes no deposits until the new owner accepts management.",
  WindingDown: "The vault is winding down and takes no deposits. Withdrawals still work.",
  DepositsNotOpen: "The leader has not opened deposits yet.",
  SharesTooFew: "The vault's value moved while you were depositing; try again.",
  LeaderStakeTooLow:
    "The leader's stake would fall below 5% of the vault; the vault can take less from you now.",
  SeedTooSmall: "Stake at least 1 USDC before opening deposits.",
  OutsideBand:
    "The vault's share price moved outside its reference band; deposits and USDC exits wait until it settles. Redeeming in kind still works.",
  InsufficientShares: "You do not hold that many shares.",
  SharesLocked: "Your shares are still locked.",
  UseInKind:
    "The vault's USDC cannot cover this exit right now. Redeem in kind instead: it always works.",
  AssetsTooFew: "The vault's value moved while you were withdrawing; try again.",
  Expired: "The withdrawal took too long to confirm; try again.",
  UsdcDepegged:
    "USDC is away from $1 right now, so the vault takes no deposits. Withdrawals still work.",
  UsdcFeedUnusable:
    "The USDC price feed is unusable right now, so the vault takes no deposits. Withdrawals still work.",
  UnpricedToken:
    "A token the vault holds has no usable price right now, so the vault takes no deposits and pays no USDC exits. Redeeming in kind still works.",
  NotManager: "Only the agent's owner can do this.",
};

/** The custody error name inside a viem error, if any. */
export function custodyRevertName(error: unknown): string | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
  return reverted instanceof ContractFunctionRevertedError ? reverted.data?.errorName : undefined;
}

/** OracleReason's STALE, the Solidity enum's index (packages/policy ORACLE_REASONS). */
const ORACLE_STALE_INDEX = 8;

/**
 * A deposit refused for a stale feed names the feed (L-145): the account asks
 * the oracle about USDC only for the depeg guard (USDC/USD) and about WMON for
 * its price (MON/USD). Without the feed's time it cannot say how late it is.
 */
export function staleFeedRevertMessage(
  error: unknown,
  usdc: Address | undefined,
): string | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(reverted instanceof ContractFunctionRevertedError)) return undefined;
  if (reverted.data?.errorName !== "OracleUnavailable") return undefined;
  const [asset, reason] = (reverted.data.args ?? []) as readonly [Address?, number?];
  if (reason !== ORACLE_STALE_INDEX || !asset) return undefined;
  const feed = usdc && isAddressEqual(asset, usdc) ? PRICE_FEEDS.USDC_USD : PRICE_FEEDS.MON_USD;
  return `Deposits are refused because the ${feed.label} price feed (${feed.guards}) is stale. It normally updates about every ${readableDuration(feed.heartbeatSeconds)}, so try again shortly. Withdrawals need no price and still work.`;
}
