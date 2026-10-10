// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PriceReason} from "../../src/interfaces/IFund.sol";
import {OracleAdapterV3} from "../../src/fund/OracleAdapterV3.sol";
import {MockVerifier} from "../mocks/FundMocks.sol";
import {FundBase} from "./FundBase.sol";

/// One feed per class F token, each with its own staleness bound (F-U2, FINAL_PLAN 0.2).
contract OracleAdapterV3Test is FundBase {
    function _price(address t) internal view returns (uint256 p, PriceReason r) {
        (p,, r) = oracle.price(t);
    }

    function test_PricesUsdcAtOneAndEachClassFTokenByItsOwnFeed() public view {
        (uint256 p, PriceReason r) = _price(address(usdc));
        assertEq(p, 1e18);
        assertEq(uint8(r), uint8(PriceReason.OK));
        (p, r) = _price(address(wmon));
        assertEq(p, 2e18);
        (p, r) = _price(address(tokA));
        assertEq(p, 6e18);
        // Composite: 20 MON per B times 2 USD per MON.
        (p, r) = _price(address(tokB));
        assertEq(p, 40e18);
        assertEq(uint8(r), uint8(PriceReason.OK));
    }

    function test_AStaleFeedBlocksOnlyTheTokensItPrices() public {
        vm.warp(block.timestamp + 300);
        (, PriceReason r) = _price(address(wmon));
        assertEq(uint8(r), uint8(PriceReason.STALE), "MON/USD: 300 s bound");
        (, r) = _price(address(tokB));
        assertEq(uint8(r), uint8(PriceReason.STALE), "the composite needs MON/USD too");
        (, r) = _price(address(tokA));
        assertEq(uint8(r), uint8(PriceReason.OK), "A's feed keeps its own 3,900 s bound");
        vm.warp(block.timestamp + 3_600);
        (, r) = _price(address(tokA));
        assertEq(uint8(r), uint8(PriceReason.STALE));
    }

    function test_EachLegHasItsOwnBoundToTheSecond() public {
        vm.warp(block.timestamp + 299);
        (, PriceReason r) = _price(address(wmon));
        assertEq(uint8(r), uint8(PriceReason.OK));
        vm.warp(block.timestamp + 1);
        (, r) = _price(address(wmon));
        assertEq(uint8(r), uint8(PriceReason.STALE));
    }

    function test_AStaleRateLegBlocksTheCompositeAlone() public {
        // The rate leg's bound is a day; MON/USD stays fresh by pushing again.
        vm.warp(block.timestamp + 90_000);
        monUsd.push(2e8);
        (, PriceReason r) = _price(address(tokB));
        assertEq(uint8(r), uint8(PriceReason.STALE));
        (, r) = _price(address(wmon));
        assertEq(uint8(r), uint8(PriceReason.OK));
    }

    function test_ClassAAndUnknownTokensHaveNoFeedPrice() public view {
        (, PriceReason r) = _price(address(tokC));
        assertEq(uint8(r), uint8(PriceReason.ATTESTATION_REQUIRED));
        (, r) = _price(address(0x1234));
        assertEq(uint8(r), uint8(PriceReason.UNKNOWN_ASSET));
    }

    function test_AChangedDecimalsIsRefused() public {
        aUsd.setDecimals(18);
        (, PriceReason r) = _price(address(tokA));
        assertEq(uint8(r), uint8(PriceReason.DECIMALS_MISMATCH));
    }

    function test_TheRevertingFormNamesTheReason() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                OracleAdapterV3.PriceUnavailable.selector, address(tokC), PriceReason.ATTESTATION_REQUIRED
            )
        );
        oracle.priceE18(address(tokC));
    }

    function test_AnAttestationNeedsTheRegistrysVerifierTheTokenAndATimeInTheFuture() public {
        vm.expectRevert(OracleAdapterV3.NoVerifier.selector);
        oracle.attestedPriceE18(address(tokC), "");
        MockVerifier v = new MockVerifier();
        bytes memory data = abi.encode(address(v));
        uint8 setVerifier = tokens.SET_VERIFIER();
        vm.prank(ADMIN);
        tokens.propose(setVerifier, data);
        vm.warp(block.timestamp + 9 days);
        tokens.execute(setVerifier, data);
        v.set(address(tokC), 3e17, uint64(block.timestamp + 60));
        assertEq(oracle.attestedPriceE18(address(tokC), ""), 3e17);
        v.set(address(tokA), 3e17, uint64(block.timestamp + 60));
        vm.expectRevert(abi.encodeWithSelector(OracleAdapterV3.BadAttestation.selector, address(tokC)));
        oracle.attestedPriceE18(address(tokC), "");
        v.set(address(tokC), 3e17, uint64(block.timestamp - 1));
        vm.expectRevert(abi.encodeWithSelector(OracleAdapterV3.BadAttestation.selector, address(tokC)));
        oracle.attestedPriceE18(address(tokC), "");
    }

    // ---- the pool deviation rule ----

    /// sqrtPriceX96 for a raw price of `num` token1 per `den` token0.
    function _sqrt(uint256 num, uint256 den) internal pure returns (uint160) {
        return uint160(Math.sqrt(Math.mulDiv(num, 2 ** 192, den)));
    }

    function _setUsdcWmonPool(uint256 usdcPerWmonE6) internal {
        // usdcPerWmonE6 raw USDC per 1e18 raw WMON.
        if (poolUsdcWmon.token0() == address(wmon)) {
            poolUsdcWmon.setPrice(usdcPerWmonE6, 1e18, _sqrt(usdcPerWmonE6, 1e18));
        } else {
            poolUsdcWmon.setPrice(1e18, usdcPerWmonE6, _sqrt(1e18, usdcPerWmonE6));
        }
    }

    function test_APoolWithinTwoPercentOfTheOracleIsTradable() public {
        _setUsdcWmonPool(2_030_000); // 2.03 USDC per WMON: 1.5% away
        (uint256 pool, PriceReason r) = oracle.poolPrice(address(wmon), idUsdcWmon);
        assertEq(uint8(r), uint8(PriceReason.OK));
        assertApproxEqRel(pool, 2.03e18, 1e12);
        (uint256 bps, PriceReason d) = oracle.poolDeviationBps(address(wmon), idUsdcWmon);
        assertEq(uint8(d), uint8(PriceReason.OK));
        assertEq(bps, 149, "rounded down from about 1.5%");
        assertEq(oracle.tradablePriceE18(address(wmon), idUsdcWmon), 2e18);
    }

    function test_APoolPushedPastTwoPercentIsRefused() public {
        _setUsdcWmonPool(2_050_000); // 2.5% away
        (, PriceReason d) = oracle.poolDeviationBps(address(wmon), idUsdcWmon);
        assertEq(uint8(d), uint8(PriceReason.POOL_DEVIATION));
        vm.expectRevert(
            abi.encodeWithSelector(OracleAdapterV3.PriceUnavailable.selector, address(wmon), PriceReason.POOL_DEVIATION)
        );
        oracle.tradablePriceE18(address(wmon), idUsdcWmon);
    }

    function test_AV4PoolAgainstUsdcIsPricedThroughStateView() public {
        // B (8 decimals) at 40 USDC: raw 40e6 USDC per 1e8 B.
        (address b0,) = _sorted(address(tokB), address(usdc));
        if (b0 == address(tokB)) stateView.setSqrt(idBUsdc, _sqrt(40e6, 1e8));
        else stateView.setSqrt(idBUsdc, _sqrt(1e8, 40e6));
        (uint256 pool, PriceReason r) = oracle.poolPrice(address(tokB), idBUsdc);
        assertEq(uint8(r), uint8(PriceReason.OK));
        assertApproxEqRel(pool, 40e18, 1e12);
    }

    function test_APoolThatDoesNotHoldTheTokenOrAQuoteAssetIsUnsupported() public view {
        (, PriceReason r) = oracle.poolPrice(address(tokA), idUsdcWmon);
        assertEq(uint8(r), uint8(PriceReason.POOL_UNSUPPORTED));
        // C's only pool is against MON, which is a quote asset: supported; A against WMON: supported.
        (, r) = oracle.poolPrice(address(tokC), bytes32(uint256(1)));
        assertEq(uint8(r), uint8(PriceReason.POOL_UNSUPPORTED));
    }
}
