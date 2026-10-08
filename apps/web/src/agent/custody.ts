import { BaseError, ContractFunctionRevertedError, parseAbi } from "viem";

/**
 * The custody calls the owner's wallet makes from the portfolio page (P2-U7):
 * open the PersonalAccount, approve exactly the deposit, deposit, withdraw and
 * claim credits. The ABIs carry the contracts' custom errors, so a revert the
 * wallet reports is named and shown in the owner's words.
 */
export const FACTORY_ABI = parseAbi([
  "function createPersonalAccount(uint256 agentId) returns (address account)",
  "error NotAgentOwner(address caller, address agentOwner)",
  "error AccountExists(address account)",
  "error NotAllowlisted(address depositor)",
  "error PersonalCapExceeded(uint256 principalAfter, uint256 cap)",
  "error PlatformCapExceeded(uint256 totalAfter, uint256 cap)",
]);

export const ACCOUNT_ABI = parseAbi([
  "function deposit(address token, uint256 amount)",
  "function withdraw(address token, uint256 amount, address to)",
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

export const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
]);

/** Owner-facing text for each custody revert. */
export const CUSTODY_REVERT_MESSAGES: Readonly<Record<string, string>> = {
  NotAgentOwner: "This wallet no longer owns the agent.",
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
  ERC20InsufficientBalance: "Your wallet does not hold that much.",
};

/** The custody error name inside a viem error, if any. */
export function custodyRevertName(error: unknown): string | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
  return reverted instanceof ContractFunctionRevertedError ? reverted.data?.errorName : undefined;
}
