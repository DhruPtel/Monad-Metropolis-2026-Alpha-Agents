// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AccountFactory} from "../../src/custody/AccountFactory.sol";
import {PersonalAccount} from "../../src/custody/PersonalAccount.sol";
import {Executor} from "../../src/executor/Executor.sol";
import {ProtocolRegistry} from "../../src/executor/ProtocolRegistry.sol";
import {OracleAdapter} from "../../src/oracle/OracleAdapter.sol";
import {AccountMode, IAgentNFTView} from "../../src/interfaces/ICustody.sol";
import {IExecutorFactory, Policy, Reason, SwapIntent} from "../../src/interfaces/IExecutor.sol";
import {IChainlinkFeed, IUniswapV4StateView} from "../../src/interfaces/IOracle.sol";
import {MockAgentNFT, MockToken} from "../mocks/CustodyMocks.sol";
import {MockVenue} from "../mocks/ExecutorMocks.sol";
import {MockFeed, MockStateView} from "../mocks/OracleMocks.sol";

/// The whole trading stack over mocks (P2-U2): AgentNFT, tokens, feeds and
/// the pool are mocks; the oracle adapter, factory, account, registry and
/// Executor are the real contracts. MON is $1.00, so a WMON's value is easy
/// to read (1e18 WMON is 1e6 USDC), and the account starts at 70 USDC and
/// 30 WMON: NAV 100 USDC, 30% WMON. Caps are wide so limits, not caps, bind.
abstract contract ExecutorBase is Test {
    bytes32 internal constant POOL_ID = keccak256("pool");
    bytes32 internal constant VENUE = keccak256("mock venue");
    uint256 internal constant AGENT = 7;
    int256 internal constant ONE_DOLLAR = 1e8;
    uint256 internal constant ONE_E18 = 1e18;

    MockToken internal usdc;
    MockToken internal wmon;
    MockAgentNFT internal nft;
    MockFeed internal monFeed;
    MockFeed internal usdcFeed;
    MockStateView internal stateView;
    OracleAdapter internal oracle;
    Executor internal executor;
    ProtocolRegistry internal registry;
    MockVenue internal venue;
    AccountFactory internal factory;
    PersonalAccount internal account;

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal sentinel = makeAddr("sentinel");
    address internal owner = makeAddr("owner");
    address internal session = makeAddr("session key");
    address internal stranger = makeAddr("stranger");
    uint256 internal actionCounter;

    function launchPolicy() internal pure returns (Policy memory) {
        return Policy({
            maxTradeBps: 1_000,
            maxAssetBps: 4_000,
            minUsdcBps: 1_000,
            maxSlippageBps: 50,
            maxTurnoverBps: 10_000,
            maxTradesPerWindow: 20,
            windowSeconds: 86_400,
            deadlineSeconds: 120
        });
    }

    function setUp() public virtual {
        build(launchPolicy());
    }

    function build(Policy memory p) internal {
        vm.warp(1_790_876_425);
        usdc = new MockToken("USDC", 6);
        wmon = new MockToken("WMON", 18);
        nft = new MockAgentNFT();
        nft.setOwner(AGENT, owner);
        monFeed = new MockFeed(8);
        usdcFeed = new MockFeed(8);
        stateView = new MockStateView(POOL_ID);
        oracle = new OracleAdapter(
            OracleAdapter.Config({
                usdc: address(usdc),
                wmon: address(wmon),
                monUsdFeed: IChainlinkFeed(address(monFeed)),
                monUsdDecimals: 8,
                monUsdMaxAge: 300,
                usdcUsdFeed: IChainlinkFeed(address(usdcFeed)),
                usdcUsdDecimals: 8,
                usdcUsdMaxAge: 7_200,
                stateView: IUniswapV4StateView(address(stateView)),
                poolId: POOL_ID,
                maxDeviationBps: 200,
                maxDepegBps: 100
            })
        );
        setMon(ONE_DOLLAR);
        executor = newExecutor(p);
        venue = new MockVenue(address(executor), usdc, wmon, ONE_E18);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = VENUE;
        address[] memory adapters = new address[](1);
        adapters[0] = address(venue);
        ProtocolRegistry.Status[] memory statuses = new ProtocolRegistry.Status[](1);
        statuses[0] = ProtocolRegistry.Status.ACTIVE;
        registry = new ProtocolRegistry(admin, guardian, address(usdc), ids, adapters, statuses);
        address[] memory allow = new address[](1);
        allow[0] = owner;
        factory = new AccountFactory(
            admin,
            guardian,
            sentinel,
            address(oracle),
            address(executor),
            IAgentNFTView(address(nft)),
            address(usdc),
            address(wmon),
            1_000_000e6,
            10_000_000e6,
            allow
        );
        vm.prank(admin);
        executor.bind(IExecutorFactory(address(factory)), registry);
        vm.prank(owner);
        account = PersonalAccount(factory.createPersonalAccount(AGENT));
        if (fundOnBuild) fund(70e6, 30e18);
        grant(uint64(block.timestamp + 7 days));
    }

    /// Whether build() deposits the default 70 USDC and 30 WMON.
    bool internal fundOnBuild = true;

    /// The Executor build() deploys; a test may deploy a harness instead.
    function newExecutor(Policy memory p) internal virtual returns (Executor) {
        return new Executor(admin, guardian, IAgentNFTView(address(nft)), address(usdc), address(wmon), p);
    }

    // ----- helpers -----

    /// Moves MON/USD and the pool with it (the venue's quotes follow too).
    function setMon(int256 answer) internal {
        monFeed.push(answer);
        usdcFeed.push(1e8);
        uint256 priceE18 = uint256(answer) * 1e10;
        stateView.setSqrtPrice(uint160(Math.sqrt(Math.mulDiv(priceE18, 2 ** 192, 1e30))));
        if (address(venue) != address(0)) venue.setPrice(priceE18);
    }

    function fund(uint256 usdcAmount, uint256 wmonAmount) internal {
        vm.startPrank(owner);
        if (usdcAmount > 0) {
            usdc.mint(owner, usdcAmount);
            usdc.approve(address(account), usdcAmount);
            account.deposit(address(usdc), usdcAmount);
        }
        if (wmonAmount > 0) {
            wmon.mint(owner, wmonAmount);
            wmon.approve(address(account), wmonAmount);
            account.deposit(address(wmon), wmonAmount);
        }
        vm.stopPrank();
    }

    /// Withdraws down to exact holdings, for a test that needs a given mix.
    function holdings(uint256 usdcAmount, uint256 wmonAmount) internal {
        vm.startPrank(owner);
        uint256 u = usdc.balanceOf(address(account));
        uint256 w = wmon.balanceOf(address(account));
        if (u > usdcAmount) account.withdraw(address(usdc), u - usdcAmount, owner);
        if (w > wmonAmount) account.withdraw(address(wmon), w - wmonAmount, owner);
        vm.stopPrank();
        if (u < usdcAmount) fund(usdcAmount - u, 0);
        if (w < wmonAmount) fund(0, wmonAmount - w);
    }

    function grant(uint64 validUntil) internal {
        vm.prank(owner);
        executor.registerSession(AGENT, session, validUntil);
    }

    /// A valid intent at the current epochs and policy, deadline two minutes out.
    function intent(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut)
        internal
        returns (SwapIntent memory i)
    {
        i = SwapIntent({
            schemaVersion: 1,
            chainId: block.chainid,
            agentId: AGENT,
            account: address(account),
            actionId: keccak256(abi.encode("action", ++actionCounter)),
            ownerEpoch: nft.ownerEpoch(AGENT),
            configEpoch: executor.configEpochOf(AGENT),
            policyHash: executor.policyHash(),
            adapterId: VENUE,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minAmountOut: minOut,
            deadline: uint64(block.timestamp + 120)
        });
    }

    /// The least minAmountOut the Executor accepts for this trade now.
    function floorFor(address tokenIn, address tokenOut, uint256 amountIn) internal view returns (uint256) {
        return executor.oracleFloor(tokenIn, tokenOut, amountIn, oracle.priceE18(address(wmon)), 50);
    }

    function buy(uint256 usdcIn) internal returns (SwapIntent memory) {
        return intent(address(usdc), address(wmon), usdcIn, floorFor(address(usdc), address(wmon), usdcIn));
    }

    function sell(uint256 wmonIn) internal returns (SwapIntent memory) {
        return intent(address(wmon), address(usdc), wmonIn, floorFor(address(wmon), address(usdc), wmonIn));
    }

    function submit(SwapIntent memory i) internal returns (uint256) {
        vm.prank(session);
        return executor.swap(i);
    }

    function expectRejected(SwapIntent memory i, Reason r) internal {
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(Executor.Rejected.selector, r));
        executor.swap(i);
    }

    function usdcOf(address who) internal view returns (uint256) {
        return usdc.balanceOf(who);
    }

    function wmonOf(address who) internal view returns (uint256) {
        return wmon.balanceOf(who);
    }

    function assertMode(AccountMode m) internal view {
        assertEq(uint8(account.mode()), uint8(m));
    }
}
