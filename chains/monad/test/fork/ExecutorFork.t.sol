// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {AccountFactory} from "../../src/custody/AccountFactory.sol";
import {PersonalAccount} from "../../src/custody/PersonalAccount.sol";
import {Executor} from "../../src/executor/Executor.sol";
import {ProtocolRegistry} from "../../src/executor/ProtocolRegistry.sol";
import {OracleAdapter} from "../../src/oracle/OracleAdapter.sol";
import {UniswapV3UsdcWmonAdapter} from "../../src/venues/UniswapV3UsdcWmonAdapter.sol";
import {UniswapV4MonUsdcAdapter} from "../../src/venues/UniswapV4MonUsdcAdapter.sol";
import {IAgentNFTView} from "../../src/interfaces/ICustody.sol";
import {IExecutorFactory, Policy, Reason, SwapIntent} from "../../src/interfaces/IExecutor.sol";
import {IChainlinkFeed, IUniswapV4StateView} from "../../src/interfaces/IOracle.sol";
import {IPoolManager, ISwapRouter02} from "../../src/interfaces/IUniswap.sol";
import {MockAgentNFT} from "../mocks/CustodyMocks.sol";
import {IFiatToken, IWMON} from "./CustodyFork.t.sol";

/// The whole trading path on the fork at the pinned block (P2-U2): Monad's
/// real USDC and WMON, the real Chainlink feeds through the oracle adapter,
/// and the real Uniswap v4 MON/USDC pool through the v4 adapter, with the
/// Executor, registry, factory and a PersonalAccount deployed as on launch.
/// Runs only on a fork named by LOCAL_FORK_URL (L-100).
contract ExecutorForkTest is Test {
    IFiatToken internal constant USDC = IFiatToken(0x754704Bc059F8C67012fEd69BC8A327a5aafb603);
    IWMON internal constant WMON = IWMON(0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A);
    bytes32 internal constant POOL_ID = 0x18a9fc874581f3ba12b7898f80a683c66fd5877fd74b26a85ba9a3a79c549954;
    bytes32 internal constant V4 = keccak256("uniswap-v4-mon-usdc-500");
    bytes32 internal constant V3 = keccak256("uniswap-v3-usdc-wmon-3000");
    uint256 internal constant AGENT = 1;

    OracleAdapter internal oracle;
    Executor internal executor;
    ProtocolRegistry internal registry;
    AccountFactory internal factory;
    PersonalAccount internal account;
    MockAgentNFT internal nft;
    address internal owner = makeAddr("fork owner");
    address internal session = makeAddr("fork session");
    address internal admin = makeAddr("fork admin");
    uint256 internal counter;

    function setUp() public {
        string memory url = vm.envOr("LOCAL_FORK_URL", string(""));
        if (bytes(vm.envOr("MONAD_RPC_URL", string(""))).length == 0 || bytes(url).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(url);
        vm.rollFork(vm.parseJsonUint(vm.readFile("./fork.json"), ".blockNumber"));
        nft = new MockAgentNFT();
        nft.setOwner(AGENT, owner);
        oracle = new OracleAdapter(
            OracleAdapter.Config({
                usdc: address(USDC),
                wmon: address(WMON),
                monUsdFeed: IChainlinkFeed(0xBcD78f76005B7515837af6b50c7C52BCf73822fb),
                monUsdDecimals: 8,
                monUsdMaxAge: 300,
                usdcUsdFeed: IChainlinkFeed(0xf5F15f188AbCB0d165D1Edb7f37F7d6fA2fCebec),
                usdcUsdDecimals: 8,
                usdcUsdMaxAge: 7_200,
                stateView: IUniswapV4StateView(0x77395F3b2E73aE90843717371294fa97cC419D64),
                poolId: POOL_ID,
                maxDeviationBps: 200,
                maxDepegBps: 100
            })
        );
        executor = new Executor(
            admin,
            makeAddr("guardian"),
            IAgentNFTView(address(nft)),
            address(USDC),
            address(WMON),
            Policy(1_000, 4_000, 1_000, 50, 10_000, 20, 86_400, 120)
        );
        UniswapV4MonUsdcAdapter v4 = new UniswapV4MonUsdcAdapter(
            IPoolManager(0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e),
            address(USDC),
            address(WMON),
            address(executor),
            POOL_ID
        );
        UniswapV3UsdcWmonAdapter v3 = new UniswapV3UsdcWmonAdapter(
            ISwapRouter02(0xfE31F71C1b106EAc32F1A19239c9a9A72ddfb900), address(USDC), address(WMON), address(executor)
        );
        bytes32[] memory ids = new bytes32[](2);
        ids[0] = V4;
        ids[1] = V3;
        address[] memory adapters = new address[](2);
        adapters[0] = address(v4);
        adapters[1] = address(v3);
        ProtocolRegistry.Status[] memory statuses = new ProtocolRegistry.Status[](2);
        statuses[0] = ProtocolRegistry.Status.ACTIVE;
        statuses[1] = ProtocolRegistry.Status.PAUSED; // the fallback, registered but not active
        registry = new ProtocolRegistry(admin, makeAddr("guardian"), address(USDC), ids, adapters, statuses);
        address[] memory allow = new address[](1);
        allow[0] = owner;
        factory = new AccountFactory(
            admin,
            makeAddr("guardian"),
            makeAddr("sentinel"),
            address(oracle),
            address(executor),
            IAgentNFTView(address(nft)),
            address(USDC),
            address(WMON),
            100e6,
            2_000e6,
            allow
        );
        vm.prank(admin);
        executor.bind(IExecutorFactory(address(factory)), registry);
        vm.prank(owner);
        account = PersonalAccount(factory.createPersonalAccount(AGENT));

        // 60 USDC and about 30 USDC of WMON (873 WMON at $0.0343682).
        vm.prank(USDC.masterMinter());
        USDC.configureMinter(address(this), 60e6);
        USDC.mint(owner, 60e6);
        vm.deal(owner, 1_000 ether);
        vm.startPrank(owner);
        WMON.deposit{value: 873 ether}();
        USDC.approve(address(account), 60e6);
        IFiatToken(address(WMON)).approve(address(account), 873 ether);
        account.deposit(address(USDC), 60e6);
        account.deposit(address(WMON), 873 ether);
        executor.registerSession(AGENT, session, uint64(block.timestamp + 1 days));
        vm.stopPrank();
    }

    function intent(address tokenIn, address tokenOut, uint256 amountIn, bytes32 venue)
        internal
        returns (SwapIntent memory)
    {
        uint256 px = oracle.priceE18(address(WMON));
        return SwapIntent({
            schemaVersion: 1,
            chainId: block.chainid,
            agentId: AGENT,
            account: address(account),
            actionId: keccak256(abi.encode("fork", ++counter)),
            ownerEpoch: nft.ownerEpoch(AGENT),
            configEpoch: 0,
            policyHash: executor.policyHash(),
            adapterId: venue,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minAmountOut: executor.oracleFloor(tokenIn, tokenOut, amountIn, px, 50),
            deadline: uint64(block.timestamp + 120)
        });
    }

    function test_ABuyOnTheRealPoolKeepsEverythingInTheAccount() public {
        uint256 usdcBefore = USDC.balanceOf(address(account));
        uint256 wmonBefore = IFiatToken(address(WMON)).balanceOf(address(account));
        SwapIntent memory i = intent(address(USDC), address(WMON), 5e6, V4);
        vm.prank(session);
        uint256 out = executor.swap(i);
        assertGe(out, i.minAmountOut, "at least the oracle floor");
        assertEq(USDC.balanceOf(address(account)), usdcBefore - 5e6);
        assertEq(IFiatToken(address(WMON)).balanceOf(address(account)), wmonBefore + out, "WMON, not native MON");
        assertEq(address(account).balance, 0);
        _nothingLeftBehind();
    }

    function test_ASaleOnTheRealPoolUnwrapsSwapsAndPaysUsdcToTheAccount() public {
        uint256 usdcBefore = USDC.balanceOf(address(account));
        SwapIntent memory i = intent(address(WMON), address(USDC), 200 ether, V4);
        vm.prank(session);
        uint256 out = executor.swap(i);
        assertGe(out, i.minAmountOut);
        assertEq(USDC.balanceOf(address(account)), usdcBefore + out);
        assertEq(IFiatToken(address(WMON)).balanceOf(address(account)), 673 ether);
        _nothingLeftBehind();
    }

    function test_LimitsHoldOnTheFork() public {
        SwapIntent memory i = intent(address(WMON), address(USDC), 300 ether, V4); // about $10.31 of $90
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(Executor.Rejected.selector, Reason.TRADE_SIZE_EXCEEDED));
        executor.swap(i);
        i = intent(address(USDC), address(WMON), 5e6, V3);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(Executor.Rejected.selector, Reason.VENUE_NOT_ALLOWED));
        executor.swap(i);
        i.adapterId = V4;
        vm.warp(block.timestamp + 300);
        i.deadline = uint64(block.timestamp + 60);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(Executor.Rejected.selector, Reason.ORACLE_STALE));
        executor.swap(i);
    }

    function _nothingLeftBehind() internal view {
        address[3] memory others = [address(executor), registry.entry(V4).adapter, address(registry)];
        for (uint256 k = 0; k < others.length; ++k) {
            assertEq(USDC.balanceOf(others[k]), 0);
            assertEq(IFiatToken(address(WMON)).balanceOf(others[k]), 0);
            assertEq(others[k].balance, 0);
        }
        address pm = 0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e;
        assertEq(USDC.allowance(address(account), pm), 0);
        assertEq(USDC.allowance(address(executor), pm), 0);
        assertEq(USDC.allowance(registry.entry(V4).adapter, pm), 0);
        assertEq(IFiatToken(address(WMON)).allowance(registry.entry(V4).adapter, pm), 0);
    }
}
