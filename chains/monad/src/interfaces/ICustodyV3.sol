// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {FeedLeg, PriceReason} from "./IFund.sol";

/// Shared types of the custody core v3 (FINAL_PLAN 0.4, F-U3). The v2 types in
/// ICustody.sol stay as the v1 and v2 sets use them; AccountMode, IAgentNFTView
/// and IDepositLedger are shared with them. Written clean-room from the plan.

/// One trade through the custody core v3. The Executor v3 (F-U4) builds it from
/// a signed intent; the core checks it again after the swap. A class A token's
/// side carries the price attestation the Executor verified (F-U12); a class F
/// side's attestation is empty, since its feed prices it.
struct SwapParamsV3 {
    address tokenIn;
    address tokenOut;
    uint256 amountIn;
    uint256 minAmountOut;
    /// The route the Executor took, hashed, for the event trail only.
    bytes32 routeHash;
    uint64 deadline;
    uint64 ownershipEpoch;
    uint64 configEpoch;
    bytes attestationIn;
    bytes attestationOut;
}

/// The Executor v3 as the custody core calls it: inside `executeSwap` the core
/// calls back here; the Executor pulls exactly `amountIn` with `pullForSwap`
/// and pays `tokenOut` to the account.
interface ISwapExecutorV3 {
    function onSwap(SwapParamsV3 calldata params) external;
}

/// What a custody account v3 reads from AccountFactoryV3: the platform's
/// current references. Changing any of them is timelocked in the factory,
/// except the instant tightenings it documents. The token list is the
/// TokenRegistry, an immutable of the account itself.
interface ICustodyConfigV3 {
    function executor() external view returns (address);
    function oracle() external view returns (address);
    function guardian() external view returns (address);
    function sentinel() external view returns (address);
}

/// The parts of OracleAdapterV3 the custody core reads. Every price is the USDC
/// value of one whole token scaled by 1e18, with USDC exactly 1.
interface IOracleV3 {
    /// A class F token's price after the feed checks; reverts when unusable.
    function priceE18(address token) external view returns (uint256);

    /// A class A token's price from an attestation, through the registry's verifier; reverts when invalid.
    function attestedPriceE18(address token, bytes calldata attestation) external view returns (uint256);

    /// One feed leg, read without reverting: the core reads USDC/USD this way for the depeg guard.
    function readLeg(FeedLeg calldata leg)
        external
        view
        returns (uint256 valueE18, uint256 updatedAt, PriceReason reason);
}
