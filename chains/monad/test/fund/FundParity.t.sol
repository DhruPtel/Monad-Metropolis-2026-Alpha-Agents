// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {
    FeedConfig,
    FeedLeg,
    IPoolRegistry,
    ITokenRegistry,
    PoolStatus,
    PriceClass,
    PriceReason,
    TokenStatus
} from "../../src/interfaces/IFund.sol";
import {IUniswapV4StateView} from "../../src/interfaces/IOracle.sol";
import {OracleAdapterV3} from "../../src/fund/OracleAdapterV3.sol";
import {ProtocolRegistryV3} from "../../src/fund/ProtocolRegistryV3.sol";
import {RouteAdapter} from "../../src/fund/RouteAdapter.sol";
import {TokenRegistry} from "../../src/fund/TokenRegistry.sol";
import {MockToken} from "../mocks/CustodyMocks.sol";
import {MockFeed} from "../mocks/OracleMocks.sol";
import {MockFundAccount, RevertingAccount} from "../mocks/FundMocks.sol";
import {FundBase} from "./FundBase.sol";

/// The fund parity fixture (F-U2, D-343): packages/policy wrote down what its
/// rules answer for each case; these tests make the v3 contracts answer the
/// same. packages/policy's fund test fails if the fixture is not what its code
/// builds now, so a change to either side alone fails one of them.
contract FundParityTest is FundBase {
    string internal constant PATH = "../../packages/policy/fixtures/fund-parity.json";

    struct LegCase {
        string name;
        uint256 legDecimals;
        uint256 maxAge;
        bool reverts;
        uint256 decimals;
        uint256 roundId;
        int256 answer;
        uint256 updatedAt;
        uint256 answeredInRound;
        uint256 time;
        uint256 reason;
        uint256 valueE18;
        uint256 updatedAtOut;
    }

    struct PriceCase {
        string name;
        uint256 usdAnswer;
        uint256 usdUpdatedAt;
        bool hasRate;
        uint256 rateAnswer;
        uint256 rateUpdatedAt;
        uint256 time;
        uint256 reason;
        uint256 priceE18;
        uint256 updatedAtOut;
    }

    struct BuyCase {
        uint256 lane;
        uint256 status;
        string account;
        bool buyable;
        bool sellable;
    }

    struct MoveCase {
        uint256 current;
        uint256 next;
        bool canTighten;
        bool canRestore;
    }

    struct RouteCase {
        string tokenIn;
        string tokenOut;
        string[] hops;
        uint256[] poolStatuses;
        bool ok;
        string failure;
        uint256 hop;
    }

    string internal json;

    function setUp() public override {
        super.setUp();
        json = vm.readFile(PATH);
    }

    // ---- feed legs ----

    function test_FeedLegsMatchThePolicyPackage() public {
        LegCase[] memory cases = abi.decode(
            vm.parseJsonTypeArray(
                json,
                ".legCases",
                "LegCase(string name,uint256 legDecimals,uint256 maxAge,bool reverts,uint256 decimals,uint256 roundId,int256 answer,uint256 updatedAt,uint256 answeredInRound,uint256 time,uint256 reason,uint256 valueE18,uint256 updatedAtOut)"
            ),
            (LegCase[])
        );
        assertEq(cases.length, vm.parseJsonUint(json, ".legCaseCount"));
        for (uint256 i = 0; i < cases.length; ++i) {
            LegCase memory c = cases[i];
            MockFeed f = new MockFeed(uint8(c.decimals));
            if (c.reverts) f.setFailure(MockFeed.Failure.RevertRound);
            // forge-lint: disable-next-line(unsafe-typecast)
            f.setRound(uint80(c.roundId), c.answer, c.updatedAt, uint80(c.answeredInRound));
            vm.warp(c.time);
            (
                uint256 value,
                uint256 updated,
                PriceReason reason
                // forge-lint: disable-next-line(unsafe-typecast)
            ) = oracle.readLeg(FeedLeg(address(f), uint8(c.legDecimals), uint32(c.maxAge)));
            assertEq(uint256(reason), c.reason, c.name);
            assertEq(value, c.valueE18, c.name);
            assertEq(updated, c.updatedAtOut, c.name);
        }
    }

    // ---- composite prices ----

    function test_CompositePricesMatchThePolicyPackage() public {
        PriceCase[] memory cases = abi.decode(
            vm.parseJsonTypeArray(
                json,
                ".priceCases",
                "PriceCase(string name,uint256 usdAnswer,uint256 usdUpdatedAt,bool hasRate,uint256 rateAnswer,uint256 rateUpdatedAt,uint256 time,uint256 reason,uint256 priceE18,uint256 updatedAtOut)"
            ),
            (PriceCase[])
        );
        assertEq(cases.length, vm.parseJsonUint(json, ".priceCaseCount"));
        for (uint256 i = 0; i < cases.length; ++i) {
            PriceCase memory c = cases[i];
            MockFeed usdFeed = new MockFeed(8);
            // forge-lint: disable-next-line(unsafe-typecast)
            usdFeed.setRound(7, int256(c.usdAnswer), c.usdUpdatedAt, 7);
            MockFeed rateFeed = new MockFeed(18);
            // forge-lint: disable-next-line(unsafe-typecast)
            rateFeed.setRound(7, int256(c.rateAnswer), c.rateUpdatedAt, 7);
            MockToken t = new MockToken("T", 18);
            FeedLeg memory rateLeg;
            if (c.hasRate) rateLeg = FeedLeg(address(rateFeed), 18, 90_000);
            TokenRegistry.CoreSeed[] memory seeds = new TokenRegistry.CoreSeed[](1);
            seeds[0] = TokenRegistry.CoreSeed(
                address(t), PriceClass.F, 1_000, FeedConfig(FeedLeg(address(usdFeed), 8, 300), rateLeg)
            );
            TokenRegistry reg = new TokenRegistry(ADMIN, GUARDIAN, SCREENER, seeds);
            OracleAdapterV3 o = new OracleAdapterV3(
                ITokenRegistry(address(reg)),
                IPoolRegistry(address(pools)),
                IUniswapV4StateView(address(stateView)),
                address(usdc),
                address(wmon),
                200
            );
            vm.warp(c.time);
            (uint256 p, uint256 updated, PriceReason reason) = o.price(address(t));
            assertEq(uint256(reason), c.reason, c.name);
            assertEq(p, c.priceE18, c.name);
            assertEq(updated, c.updatedAtOut, c.name);
        }
    }

    // ---- lanes, statuses and accounts ----

    function _account(string memory kind) internal returns (address) {
        bytes32 k = keccak256(bytes(kind));
        if (k == keccak256("eoa")) return OWNER_ACCOUNT_EOA;
        if (k == keccak256("reverts")) return address(new RevertingAccount());
        MockFundAccount a = new MockFundAccount();
        if (k == keccak256("opted in")) a.set(true, false);
        else if (k == keccak256("not opted in")) a.set(false, false);
        else a.set(true, true);
        return address(a);
    }

    /// A fresh token in a lane, moved to a status the instant way.
    function _token(uint256 lane, uint256 status) internal returns (address) {
        MockToken t = new MockToken("T", 18);
        if (lane == 1) {
            bytes memory data =
                abi.encode(TokenRegistry.CoreSeed(address(t), PriceClass.A, 1_000, FeedConfig(_noLeg(), _noLeg())));
            uint8 addCore = tokens.ADD_CORE();
            vm.prank(ADMIN);
            tokens.propose(addCore, data);
            vm.warp(block.timestamp + 9 days);
            tokens.execute(addCore, data);
        } else {
            vm.prank(SCREENER);
            tokens.addScreened(address(t), 1_000, bytes32(0), uint64(block.timestamp));
        }
        if (status >= uint256(TokenStatus.SELL_ONLY)) {
            vm.prank(SCREENER);
            tokens.setSellOnly(address(t));
        }
        if (status == uint256(TokenStatus.FROZEN)) {
            vm.prank(SCREENER);
            tokens.freeze(address(t));
        }
        return address(t);
    }

    function test_LanesStatusesAndAccountsMatchThePolicyPackage() public {
        BuyCase[] memory cases = abi.decode(
            vm.parseJsonTypeArray(
                json, ".buyCases", "BuyCase(uint256 lane,uint256 status,string account,bool buyable,bool sellable)"
            ),
            (BuyCase[])
        );
        assertEq(cases.length, vm.parseJsonUint(json, ".buyCaseCount"));
        for (uint256 i = 0; i < cases.length; ++i) {
            BuyCase memory c = cases[i];
            address t = _token(c.lane, c.status);
            assertEq(tokens.buyableFor(t, _account(c.account)), c.buyable, c.account);
            assertEq(tokens.sellable(t), c.sellable);
        }
    }

    function test_InstantMovesAndRestoresMatchThePolicyPackage() public {
        MoveCase[] memory cases = abi.decode(
            vm.parseJsonTypeArray(
                json, ".moveCases", "MoveCase(uint256 current,uint256 next,bool canTighten,bool canRestore)"
            ),
            (MoveCase[])
        );
        assertEq(cases.length, vm.parseJsonUint(json, ".moveCaseCount"));
        for (uint256 i = 0; i < cases.length; ++i) {
            MoveCase memory c = cases[i];
            address t = _token(2, c.current);
            bool tightened;
            vm.startPrank(SCREENER);
            if (c.next == uint256(TokenStatus.SELL_ONLY)) {
                try tokens.setSellOnly(t) {
                    tightened = true;
                } catch {}
            } else if (c.next == uint256(TokenStatus.FROZEN)) {
                try tokens.freeze(t) {
                    tightened = true;
                } catch {}
            }
            vm.stopPrank();
            assertEq(tightened, c.canTighten, "instant move");
            // A restore proposal is checked when made: from the case's current status.
            address r = _token(2, c.current);
            bool proposed;
            uint8 restore = tokens.RESTORE();
            vm.prank(ADMIN);
            try tokens.propose(restore, abi.encode(r, TokenStatus(c.next))) {
                proposed = true;
            } catch {}
            assertEq(proposed, c.canRestore, "restore proposal");
        }
    }

    // ---- routes ----

    function _tokenNamed(string memory n) internal view returns (address) {
        bytes32 k = keccak256(bytes(n));
        if (k == keccak256("USDC")) return address(usdc);
        if (k == keccak256("WMON")) return address(wmon);
        if (k == keccak256("A")) return address(tokA);
        if (k == keccak256("B")) return address(tokB);
        return address(tokC);
    }

    function _poolNamed(string memory n) internal view returns (bytes32) {
        bytes32 k = keccak256(bytes(n));
        if (k == keccak256("usdcWmon")) return idUsdcWmon;
        if (k == keccak256("aWmon")) return idAWmon;
        if (k == keccak256("monC")) return idMonC;
        return idBUsdc;
    }

    function _fund(address token, uint256 amount) internal {
        if (token == address(wmon)) _wmonTo(address(adapter), amount);
        else MockToken(token).mint(address(adapter), amount);
    }

    function test_RoutesMatchThePolicyPackage() public {
        RouteCase[] memory cases = abi.decode(
            vm.parseJsonTypeArray(
                json,
                ".routeCases",
                "RouteCase(string tokenIn,string tokenOut,string[] hops,uint256[] poolStatuses,bool ok,string failure,uint256 hop)"
            ),
            (RouteCase[])
        );
        assertEq(cases.length, vm.parseJsonUint(json, ".routeCaseCount"));
        bytes32[4] memory order = [idUsdcWmon, idAWmon, idMonC, idBUsdc];
        for (uint256 i = 0; i < cases.length; ++i) {
            RouteCase memory c = cases[i];
            uint256 snap = vm.snapshotState();
            for (uint256 j = 0; j < order.length; ++j) {
                vm.startPrank(GUARDIAN);
                if (c.poolStatuses[j] == uint256(PoolStatus.EXIT_ONLY)) pools.setPoolExitOnly(order[j]);
                if (c.poolStatuses[j] == uint256(PoolStatus.PAUSED)) pools.pausePool(order[j]);
                vm.stopPrank();
            }
            bytes32[] memory route = new bytes32[](c.hops.length);
            for (uint256 j = 0; j < c.hops.length; ++j) {
                route[j] = _poolNamed(c.hops[j]);
            }
            address tin = _tokenNamed(c.tokenIn);
            uint256 amount = tin == address(usdc) ? 1e6 : tin == address(tokB) ? 1e8 : 1e18;
            _fund(tin, amount);
            try adapter.swapRoute(tin, _tokenNamed(c.tokenOut), amount, 0, address(0xACC7), route, false) {
                assertTrue(c.ok, "the contracts accepted a route the policy refuses");
            } catch (bytes memory err) {
                assertFalse(c.ok, "the contracts refused a route the policy accepts");
                bytes32 e = keccak256(bytes(c.failure));
                if (e == keccak256("BadRoute")) {
                    assertEq(err, abi.encodeWithSelector(RouteAdapter.BadRoute.selector));
                } else if (e == keccak256("BrokenRoute")) {
                    assertEq(err, abi.encodeWithSelector(RouteAdapter.BrokenRoute.selector, c.hop));
                } else {
                    assertEq(err, abi.encodeWithSelector(ProtocolRegistryV3.PoolUnusable.selector, route[c.hop]));
                }
            }
            vm.revertToState(snap);
        }
    }
}
