// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// The canonical account mode (FINAL_PLAN 4.12, D-137). The order matches
/// ACCOUNT_MODES in packages/domain/src/modes.ts (a domain test checks it).
/// HANDOVER and WIND_DOWN exist only on a StrategyVault.
enum AccountMode {
    NORMAL,
    REDUCE_ONLY,
    PAUSED,
    HANDOVER,
    WIND_DOWN
}

/// One trade through the custody core (FINAL_PLAN 4.1.6). The Executor builds
/// it from a signed intent; the core checks it again after the swap.
struct SwapParams {
    address tokenIn;
    address tokenOut;
    uint256 amountIn;
    uint256 minAmountOut;
    bytes32 poolId;
    uint64 deadline;
    uint64 ownershipEpoch;
    uint64 configEpoch;
}

/// The parts of AgentNFT the custody contracts read.
interface IAgentNFTView {
    function ownerOf(uint256 agentId) external view returns (address);
    function ownerEpoch(uint256 agentId) external view returns (uint64);
}

/// The Executor (P2-U2) as the custody core calls it: inside `executeSwap`,
/// the core calls back here; the Executor pulls exactly `amountIn` with
/// `pullForSwap` and swaps with the account as the recipient.
interface ISwapExecutor {
    function onSwap(SwapParams calldata params) external;
}

/// What a custody account reads from AccountFactory: the platform's current
/// references and lists. Changing any of them is timelocked in the factory,
/// except the instant tightenings it documents.
interface ICustodyConfig {
    function executor() external view returns (address);
    function oracle() external view returns (address);
    function guardian() external view returns (address);
    function sentinel() external view returns (address);
    function isBuyable(address token) external view returns (bool);
}

/// The factory's deposit bookkeeping, callable only by the accounts it deployed.
interface IDepositLedger {
    /// Checks the allowlist and both caps for a deposit worth `value` (USDC,
    /// 6 decimals) that brings the account's principal to `principalAfter`,
    /// and records it in the platform total. Reverts when any check fails.
    function recordDeposit(address depositor, uint256 principalAfter, uint256 value) external;

    /// Lowers the platform total after a withdrawal. Never reverts for a
    /// registered account; an account calls it without depending on it.
    function recordWithdrawal(uint256 principalReduced) external;
}
