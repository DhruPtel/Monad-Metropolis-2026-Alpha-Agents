// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {StrategyVaultV3} from "../../src/fund/StrategyVaultV3.sol";
import {AccountMode, IAgentNFTView} from "../../src/interfaces/ICustody.sol";
import {SwapParamsV3} from "../../src/interfaces/ICustodyV3.sol";
import {ITokenRegistry} from "../../src/interfaces/IFund.sol";
import {TokenRegistry} from "../../src/fund/TokenRegistry.sol";
import {FeedConfig, PriceClass} from "../../src/interfaces/IFund.sol";
import {MockToken} from "../mocks/CustodyMocks.sol";
import {MockFeed} from "../mocks/OracleMocks.sol";
import {VaultHarnessFactory} from "../mocks/VaultMocks.sol";
import {CustodyV3Base} from "./CustodyV3Base.sol";

/// Shared setup for the StrategyVaultV3 tests (P7-U1): CustodyV3Base's
/// registry, oracle, feeds, tokens and mock Executor, a harness factory in
/// the real factory's place (its sv side is P7-U4's), and one sv for
/// agent 7 whose owner (`owner`) is the leader. Alice, Bob and the buyer hold
/// USDC and have approved the sv. The sv's lockup is the default day.
abstract contract StrategyVaultV3Base is CustodyV3Base {
    uint256 internal constant SEED = 100e6;
    uint256 internal constant ONE_SHARE_PER_USDC = 1e12;

    VaultHarnessFactory internal vaultFactory;
    StrategyVaultV3 internal sv; // the StrategyVault (FundBase names its mock account `vault`)
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal buyer = makeAddr("buyer");
    address internal sink = makeAddr("sink");

    function setUp() public virtual override {
        super.setUp();
        vaultFactory = new VaultHarnessFactory(
            IAgentNFTView(address(nft)),
            address(usdc),
            ITokenRegistry(address(tokens)),
            address(oracle),
            guardian,
            sentinel
        );
        vm.prank(owner);
        sv = StrategyVaultV3(vaultFactory.createVault(AGENT));
        address[4] memory wallets = [owner, alice, bob, buyer];
        for (uint256 i = 0; i < wallets.length; ++i) {
            usdc.mint(wallets[i], 1_000_000e6);
            vm.prank(wallets[i]);
            usdc.approve(address(sv), type(uint256).max);
        }
    }

    // ----- deposits -----

    function depositAs(address who, uint256 assets) internal returns (uint256 shares) {
        vm.prank(who);
        shares = sv.deposit(assets, 0);
    }

    /// The leader's seed and deposits opened.
    function seedAndOpen() internal {
        depositAs(owner, SEED);
        vm.prank(owner);
        sv.setDepositsOpen(true);
    }

    /// A sv with the leader's 100 USDC, Alice's 100 and Bob's 100.
    function threeDepositors() internal {
        seedAndOpen();
        depositAs(alice, 100e6);
        depositAs(bob, 100e6);
    }

    // ----- exits -----

    function redeemAs(address who, uint256 shares) internal returns (uint256 assets) {
        vm.prank(who);
        assets = sv.redeem(shares, who, 0, uint64(block.timestamp + 60));
    }

    function redeemInKindAs(address who, uint256 shares) internal {
        vm.prank(who);
        sv.redeemInKind(shares, who);
    }

    // ----- time -----

    /// Time passes and every feed answers again with its current price (a
    /// price a test moved stays moved; CustodyV3Base's refresh resets them).
    function warp(uint256 seconds_) internal {
        vm.warp(block.timestamp + seconds_);
        keepFeedsFresh();
    }

    function keepFeedsFresh() internal {
        MockFeed[4] memory feeds = [monUsd, usdcUsd, aUsd, bRate];
        for (uint256 i = 0; i < feeds.length; ++i) {
            feeds[i].push(feeds[i].answer());
        }
        for (uint256 i = 0; i < extraFeeds.length; ++i) {
            extraFeeds[i].push(extraFeeds[i].answer());
        }
    }

    function warpDays(uint256 d) internal {
        warp(d * 1 days);
    }

    /// Past the lockup of every bucket set so far.
    function passLockup() internal {
        warp(sv.lockup() + 1);
    }

    // ----- trading, through the mock Executor -----

    function setVaultExecutor() internal {
        vaultFactory.setExecutor(address(executor));
    }

    /// The Executor buys `usdcIn` worth of `token` for the sv, in trades of
    /// at most a tenth of the value each (the core's 12% trade cap).
    function vaultBuys(address token, uint256 usdcIn) internal {
        if (vaultFactory.executor() == address(0)) setVaultExecutor();
        while (usdcIn >= 1e4) {
            uint256 chunk = sv.navUsdc() / 10;
            if (chunk > usdcIn) chunk = usdcIn;
            executor.swap(sv, params(address(usdc), token, chunk));
            usdcIn -= chunk;
        }
    }

    /// The Executor sells `amount` of `token` back to USDC for the sv.
    function vaultSells(address token, uint256 amount) internal {
        if (vaultFactory.executor() == address(0)) setVaultExecutor();
        executor.swap(sv, params(token, address(usdc), amount));
    }

    /// Moves A's USD feed (8 decimals) with a fresh round; the executor's quotes follow.
    function setA(int256 answer) internal {
        aUsd.push(answer);
        executor.setPrice(address(tokA), uint256(answer) * 1e10);
    }

    /// Registers an existing token (18 decimals, 1 USDC) in the core lane
    /// through the registry's timelock, priced for the executor with a stash.
    function registerCore(MockToken t) internal {
        MockFeed f = new MockFeed(8);
        f.push(1e8);
        extraFeeds.push(f);
        bytes memory payload = abi.encode(
            TokenRegistry.CoreSeed(address(t), PriceClass.F, 4_500, FeedConfig(_feed(f, 8, 3_900), _noLeg()))
        );
        uint8 addCore = tokens.ADD_CORE();
        vm.prank(ADMIN);
        tokens.propose(addCore, payload);
        vm.warp(block.timestamp + 9 days);
        tokens.execute(addCore, payload);
        refreshFeeds();
        executor.setPrice(address(t), 1e18);
        t.mint(address(executor), 1e30);
    }

    // ----- reads -----

    function vaultMode() internal view returns (AccountMode) {
        return sv.mode();
    }

    function sharesOf(address who) internal view returns (uint256) {
        return sv.sharesOf(who);
    }

    function vaultBal(address token) internal view returns (uint256) {
        return MockToken(token).balanceOf(address(sv));
    }

    /// The share price at the last prices the vault cached (what `sharePriceE18` answers).
    function sharePrice() internal view returns (uint256) {
        return sv.sharePriceE18();
    }

    /// The share price at the feeds' prices now, as the next priced action sees it.
    function livePrice() internal view returns (uint256) {
        uint256 supply = sv.totalSupply();
        return supply == 0 ? 0 : Math.mulDiv(sv.navUsdc(), 1e30, supply);
    }

    function assertVaultMode(AccountMode expected) internal view {
        assertEq(uint8(sv.mode()), uint8(expected));
    }

    function assertVaultMode(AccountMode expected, string memory why) internal view {
        assertEq(uint8(sv.mode()), uint8(expected), why);
    }
}
