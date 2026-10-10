// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {AccountFactoryV3} from "../../src/fund/AccountFactoryV3.sol";
import {PersonalAccountV3} from "../../src/fund/PersonalAccountV3.sol";
import {TokenRegistry} from "../../src/fund/TokenRegistry.sol";
import {AccountMode, IAgentNFTView} from "../../src/interfaces/ICustody.sol";
import {SwapParamsV3} from "../../src/interfaces/ICustodyV3.sol";
import {FeedConfig, FeedLeg, ITokenRegistry, PriceClass} from "../../src/interfaces/IFund.sol";
import {MockAgentNFT, MockToken} from "../mocks/CustodyMocks.sol";
import {MockAttestor, MockExecutorV3} from "../mocks/CustodyV3Mocks.sol";
import {MockFeed} from "../mocks/OracleMocks.sol";
import {FundBase} from "./FundBase.sol";

/// Shared setup for the custody core v3 tests (F-U3): FundBase's registry and
/// real OracleAdapterV3 over mock feeds, an AccountFactoryV3 with the oracle
/// from deployment (D-235) and the Executor unset, one PersonalAccountV3, a
/// mock Executor v3 with every misbehaviour, and a mock attestor set as the
/// registry's verifier. Prices (USDC per whole token): USDC 1, WMON 2, A 6,
/// B 40 (composite), C 0.40 (class A, core), D 2, E 0.50 and F 10 (class A,
/// screened lane). Caps are 1,000 USDC per account and 20,000 across the platform.
abstract contract CustodyV3Base is FundBase {
    uint256 internal constant PERSONAL_CAP = 1_000e6;
    uint256 internal constant PLATFORM_CAP = 20_000e6;
    uint256 internal constant AGENT = 7;
    uint64 internal constant ATTESTATION_LIFE = 60;

    uint256 internal constant PX_USDC = 1e18;
    uint256 internal constant PX_WMON = 2e18;
    uint256 internal constant PX_A = 6e18;
    uint256 internal constant PX_B = 40e18;
    uint256 internal constant PX_C = 0.4e18;
    uint256 internal constant PX_D = 2e18;
    uint256 internal constant PX_E = 0.5e18;
    uint256 internal constant PX_F = 10e18;

    MockAgentNFT internal nft;
    AccountFactoryV3 internal factory;
    PersonalAccountV3 internal account;
    MockExecutorV3 internal executor;
    MockAttestor internal attestor;
    MockToken internal tokD; // class A, screened lane, 6 decimals
    MockToken internal tokE; // class A, screened lane, 18 decimals
    MockToken internal tokF; // class A, screened lane, 18 decimals

    /// Feeds of core tokens added by `coreTokens`, refreshed with the rest.
    MockFeed[] internal extraFeeds;

    address internal admin = ADMIN;
    address internal guardian = GUARDIAN;
    address internal sentinel = makeAddr("sentinel");
    address internal owner;
    address internal stranger = makeAddr("stranger");

    function setUp() public virtual override {
        super.setUp();
        owner = _makeOwner();
        attestor = new MockAttestor();
        timelockedRegistry(tokens.SET_VERIFIER(), abi.encode(address(attestor)));

        nft = new MockAgentNFT();
        address[] memory allow = new address[](1);
        allow[0] = owner;
        factory = new AccountFactoryV3(
            AccountFactoryV3.Deployment({
                admin: admin,
                guardian: guardian,
                sentinel: sentinel,
                oracle: address(oracle),
                executor: address(0),
                agentNft: IAgentNFTView(address(nft)),
                usdc: address(usdc),
                tokenRegistry: ITokenRegistry(address(tokens)),
                personalCap: PERSONAL_CAP,
                platformCap: PLATFORM_CAP,
                allowlist: allow
            })
        );
        nft.setOwner(AGENT, owner);
        vm.prank(owner);
        account = PersonalAccountV3(factory.createPersonalAccount(AGENT));

        executor = new MockExecutorV3();
        tokD = new MockToken("TOKD", 6);
        tokE = new MockToken("TOKE", 18);
        tokF = new MockToken("TOKF", 18);
        vm.startPrank(SCREENER);
        tokens.addScreened(address(tokD), 1_500, keccak256("d"), uint64(block.timestamp));
        tokens.addScreened(address(tokE), 1_500, keccak256("e"), uint64(block.timestamp));
        tokens.addScreened(address(tokF), 1_500, keccak256("f"), uint64(block.timestamp));
        vm.stopPrank();

        executor.setPrice(address(usdc), PX_USDC);
        executor.setPrice(address(wmon), PX_WMON);
        executor.setPrice(address(tokA), PX_A);
        executor.setPrice(address(tokB), PX_B);
        executor.setPrice(address(tokC), PX_C);
        executor.setPrice(address(tokD), PX_D);
        executor.setPrice(address(tokE), PX_E);
        executor.setPrice(address(tokF), PX_F);
        MockToken[7] memory stash = [usdc, tokA, tokB, tokC, tokD, tokE, tokF];
        for (uint256 i = 0; i < stash.length; ++i) {
            stash[i].mint(address(executor), 1e30);
        }
        _wmonTo(address(executor), 1e27);
    }

    /// The owner: a wallet, or a contract in the reentrancy tests.
    function _makeOwner() internal virtual returns (address) {
        return makeAddr("owner");
    }

    // ----- helpers -----

    /// A timelocked registry change: propose, wait 9 days, execute, then fresh feeds.
    function timelockedRegistry(uint8 action, bytes memory data) internal {
        vm.prank(ADMIN);
        tokens.propose(action, data);
        vm.warp(block.timestamp + 9 days);
        tokens.execute(action, data);
        refreshFeeds();
    }

    /// Fresh rounds on every feed, the extra core tokens' included.
    function refreshFeeds() internal {
        _refreshFeeds();
        for (uint256 i = 0; i < extraFeeds.length; ++i) {
            extraFeeds[i].push(extraFeeds[i].answer());
        }
    }

    /// `n` more core-lane class F tokens with 18 decimals at 1 USDC each, added
    /// through the registry's timelock in one wait, priced for the executor.
    function coreTokens(uint256 n) internal returns (MockToken[] memory out) {
        out = new MockToken[](n);
        bytes[] memory payloads = new bytes[](n);
        uint8 addCore = tokens.ADD_CORE();
        for (uint256 i = 0; i < n; ++i) {
            out[i] = new MockToken(string.concat("CORE", vm.toString(i)), 18);
            MockFeed f = new MockFeed(8);
            f.push(1e8);
            extraFeeds.push(f);
            payloads[i] = abi.encode(
                TokenRegistry.CoreSeed(address(out[i]), PriceClass.F, 4_500, FeedConfig(_feed(f, 8, 3_900), _noLeg()))
            );
            vm.prank(ADMIN);
            tokens.propose(addCore, payloads[i]);
            executor.setPrice(address(out[i]), 1e18);
            out[i].mint(address(executor), 1e30);
        }
        vm.warp(block.timestamp + 9 days);
        for (uint256 i = 0; i < n; ++i) {
            tokens.execute(addCore, payloads[i]);
        }
        refreshFeeds();
    }

    /// Gives the owner `amount` of a token and deposits it.
    function deposit(MockToken token, uint256 amount) internal {
        if (address(token) == address(wmon)) _wmonTo(owner, amount);
        else token.mint(owner, amount);
        vm.startPrank(owner);
        token.approve(address(account), amount);
        account.deposit(address(token), amount);
        vm.stopPrank();
    }

    /// A deposit of WMON (MockWMON is not a MockToken).
    function depositWmon(uint256 amount) internal {
        _wmonTo(owner, amount);
        vm.startPrank(owner);
        wmon.approve(address(account), amount);
        account.deposit(address(wmon), amount);
        vm.stopPrank();
    }

    /// Passes a timelocked factory change: propose, wait, execute.
    function timelocked(AccountFactoryV3.Action action, bytes32 value) internal {
        vm.prank(admin);
        factory.propose(action, value);
        vm.warp(block.timestamp + factory.RISK_TIMELOCK());
        factory.execute(action, value);
        refreshFeeds();
    }

    function setExecutor() internal {
        timelocked(AccountFactoryV3.Action.SetExecutor, bytes32(uint256(uint160(address(executor)))));
    }

    /// A funded account with the Executor live: 600 USDC and 50 A (300 USDC), NAV 900.
    function tradingAccount() internal {
        setExecutor();
        deposit(usdc, 600e6);
        deposit(tokA, 50e18);
    }

    function isClassA(address token) internal view returns (bool) {
        return tokens.tokenRecord(token).priceClass == PriceClass.A;
    }

    function params(address tokenIn, address tokenOut, uint256 amountIn) internal view returns (SwapParamsV3 memory) {
        return SwapParamsV3({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minAmountOut: 1,
            routeHash: bytes32(0),
            deadline: uint64(block.timestamp + 120),
            ownershipEpoch: nft.ownerEpoch(AGENT),
            configEpoch: 0,
            attestationIn: "",
            attestationOut: ""
        });
    }

    /// Fresh attestations, at the executor's reference prices, for each class A side.
    function attest(SwapParamsV3 memory p) internal returns (SwapParamsV3 memory) {
        if (isClassA(p.tokenIn)) p.attestationIn = attestation(p.tokenIn, executor.priceE18(p.tokenIn));
        if (isClassA(p.tokenOut)) p.attestationOut = attestation(p.tokenOut, executor.priceE18(p.tokenOut));
        return p;
    }

    /// One attestation for a token at a price, valid for a minute.
    function attestation(address token, uint256 priceE18) internal returns (bytes memory) {
        attestor.set(token, priceE18, uint64(block.timestamp + ATTESTATION_LIFE));
        return abi.encode(token);
    }

    function attested(address tokenIn, address tokenOut, uint256 amountIn) internal returns (SwapParamsV3 memory) {
        return attest(params(tokenIn, tokenOut, amountIn));
    }

    function swap(SwapParamsV3 memory p) internal {
        executor.swap(account, p);
    }

    function optIn() internal {
        vm.prank(owner);
        account.setScreenedOptIn(true);
    }

    function bal(address token, address who) internal view returns (uint256) {
        return MockToken(token).balanceOf(who);
    }

    function usdcBal(address who) internal view returns (uint256) {
        return usdc.balanceOf(who);
    }

    function assertMode(AccountMode expected) internal view {
        assertEq(uint8(account.mode()), uint8(expected));
    }

    function assertHeld(address[] memory expected) internal view {
        address[] memory held = account.heldTokens();
        assertEq(held.length, expected.length, "held count");
        for (uint256 i = 0; i < expected.length; ++i) {
            assertEq(held[i], expected[i], string.concat("held ", vm.toString(i)));
        }
    }

    function two(address a, address b) internal pure returns (address[] memory out) {
        out = new address[](2);
        (out[0], out[1]) = (a, b);
    }

    function one(address a) internal pure returns (address[] memory out) {
        out = new address[](1);
        out[0] = a;
    }
}
