// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {AccountFactoryV3} from "../../src/fund/AccountFactoryV3.sol";
import {ExecutorV3} from "../../src/fund/ExecutorV3.sol";
import {OracleAdapterV3} from "../../src/fund/OracleAdapterV3.sol";
import {PersonalAccountV3} from "../../src/fund/PersonalAccountV3.sol";
import {ProtocolRegistryV3} from "../../src/fund/ProtocolRegistryV3.sol";
import {TokenRegistry} from "../../src/fund/TokenRegistry.sol";
import {ReasonV3, SwapIntentV3} from "../../src/interfaces/IExecutorV3.sol";
import {BindExecutorV3} from "../../script/BindExecutorV3.s.sol";
import {CanaryAgent} from "../../script/CanaryAgent.sol";
import {DeployCanaryAgent} from "../../script/DeployCanaryAgent.s.sol";
import {DeployCustodyV3} from "../../script/DeployCustodyV3.s.sol";
import {DeployExecutorV3} from "../../script/DeployExecutorV3.s.sol";
import {DeployFund} from "../../script/DeployFund.s.sol";
import {IFiatToken} from "../fork/CustodyFork.t.sol";

/// F-U13's dry run of the mainnet canary rerun on the v3 set: the canary's
/// deploy scripts on an in-memory fork of Monad mainnet (CanaryAgent, the
/// fund set on the real Chainlink feeds with the three USDC/WMON core pools,
/// Executor v3 and its set, AccountFactoryV3 with the canary's caps and
/// allowlist, the binding), then the canary's class F round trip: the owner
/// opens a v3 account, deposits 5 USDC, registers the session key, buys 0.45
/// USDC of WMON through the launch pool and sells it back, through the
/// Uniswap v3 pool too, an oversized buy is refused, the guardian pauses and
/// a swap is refused while the owner's withdrawal works, the grant is revoked
/// and everything is withdrawn. Nothing is sent to mainnet. Runs only through
/// `pnpm test:canary-fork`.
contract CanaryDeployV3Test is Test {
    IFiatToken internal constant USDC = IFiatToken(0x754704Bc059F8C67012fEd69BC8A327a5aafb603);
    IFiatToken internal constant WMON = IFiatToken(0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A);
    address internal constant MON_USD = 0xBcD78f76005B7515837af6b50c7C52BCf73822fb;
    address internal constant USDC_USD = 0xf5F15f188AbCB0d165D1Edb7f37F7d6fA2fCebec;
    address internal constant UNI_V3_FACTORY = 0x204FAca1764B154221e35c0d20aBb3c525710498;
    address internal constant CAKE_V3_FACTORY = 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865;
    address internal constant POOL_MANAGER = 0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e;
    address internal constant STATE_VIEW = 0x77395F3b2E73aE90843717371294fa97cC419D64;
    address internal constant UNI_V3_POOL = 0x659bD0BC4167BA25c62E05656F78043E7eD4a9da;
    address internal constant CAKE_V3_POOL = 0x63e48B725540A3Db24ACF6682a29f877808C53F2;
    bytes32 internal constant V4_POOL_ID = 0x18a9fc874581f3ba12b7898f80a683c66fd5877fd74b26a85ba9a3a79c549954;
    bytes32 internal constant ROUTER_ID = keccak256("route-adapter");
    uint256 internal constant CAP_E6 = 10e6;
    uint256 internal constant DEPOSIT_E6 = 5e6;
    uint256 internal constant TRADE_E6 = 450_000;

    uint256 internal ownerKey = uint256(keccak256("f-u13 canary dry-run owner"));
    address internal owner;
    address internal guardian = makeAddr("canary guardian");
    address internal session = makeAddr("canary session key");

    CanaryAgent internal agent;
    TokenRegistry internal tokens;
    ExecutorV3 internal executor;
    OracleAdapterV3 internal oracle;
    ProtocolRegistryV3 internal pools;
    AccountFactoryV3 internal factory;
    uint256 internal actions;

    function setUp() public {
        if (!vm.envOr("CANARY_FORK", false)) {
            vm.skip(true);
            return;
        }
        // Pinned by default to the block before the F-U13 canary deployment, so
        // the dry run is reproducible: at the latest block the real pools drift
        // against Chainlink and a 0.3% pool can sit outside the 50 bps floor
        // (L-246). CANARY_FORK_BLOCK=0 forks the latest block.
        uint256 forkBlock = vm.envOr("CANARY_FORK_BLOCK", uint256(112_870_000));
        if (forkBlock == 0) vm.createSelectFork("monad");
        else vm.createSelectFork("monad", forkBlock);
        owner = vm.addr(ownerKey);
        vm.deal(owner, 10 ether);
        vm.prank(USDC.masterMinter());
        USDC.configureMinter(address(this), 10e6);
        USDC.mint(owner, 5e6);

        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(ownerKey));
        vm.setEnv("DEPLOY_SALT_SCOPE", "p2ec.canary");
        vm.setEnv("CANARY_SIGNING_ENABLED", "true");
        vm.setEnv("CANARY_AGENT_OWNER", vm.toString(owner));
        agent = new DeployCanaryAgent().run();

        vm.setEnv("FUND_CONFIG", _fundConfig());
        DeployFund fundScript = new DeployFund();
        fundScript.run();
        tokens = fundScript.deployedTokens();

        vm.setEnv("EXECUTOR_V3_TOKEN_REGISTRY", vm.toString(address(tokens)));
        vm.setEnv("EXECUTOR_V3_AGENT_NFT", vm.toString(address(agent)));
        DeployExecutorV3 execScript = new DeployExecutorV3();
        execScript.run();
        executor = execScript.deployedExecutor();
        pools = execScript.deployedPools();
        oracle = execScript.deployedOracle();

        vm.setEnv("CUSTODY_V3_ADMIN", vm.toString(owner));
        vm.setEnv("CUSTODY_V3_GUARDIAN", vm.toString(guardian));
        vm.setEnv("CUSTODY_V3_SENTINEL", vm.toString(address(0)));
        vm.setEnv("CUSTODY_V3_AGENT_NFT", vm.toString(address(agent)));
        vm.setEnv("CUSTODY_V3_USDC", vm.toString(address(USDC)));
        vm.setEnv("CUSTODY_V3_TOKEN_REGISTRY", vm.toString(address(tokens)));
        vm.setEnv("CUSTODY_V3_ORACLE", vm.toString(address(oracle)));
        vm.setEnv("CUSTODY_V3_EXECUTOR", vm.toString(address(executor)));
        vm.setEnv("CUSTODY_V3_PERSONAL_CAP", vm.toString(CAP_E6));
        vm.setEnv("CUSTODY_V3_VAULT_CAP", vm.toString(CAP_E6));
        vm.setEnv("CUSTODY_V3_PLATFORM_CAP", vm.toString(CAP_E6));
        vm.setEnv("CUSTODY_V3_DEPOSITS_ENABLED", "false");
        vm.setEnv("CUSTODY_V3_ALLOWLIST", vm.toString(owner));
        factory = new DeployCustodyV3().run();
        vm.setEnv("EXECUTOR_V3", vm.toString(address(executor)));
        vm.setEnv("EXECUTOR_V3_FACTORY", vm.toString(address(factory)));
        vm.setEnv("EXECUTOR_V3_POOLS", vm.toString(address(pools)));
        new BindExecutorV3().run();
    }

    /// The FUND_CONFIG scripts/deploy-canary-v3.js builds: the canary owner as admin and screener, the real venues and feeds, the three USDC/WMON pools.
    function _fundConfig() internal view returns (string memory) {
        string memory seeds = string.concat(
            _seed(address(USDC), USDC_USD, 10_000, 7_800), ",", _seed(address(WMON), MON_USD, 4_000, 600)
        );
        string memory poolsJson = string.concat(
            _v3Pool(1, UNI_V3_POOL, 3000, 60),
            ",",
            _v3Pool(2, CAKE_V3_POOL, 500, 10),
            ",",
            '{"venue":3,"token0":"0x0000000000000000000000000000000000000000","token1":"',
            vm.toString(address(USDC)),
            '","fee":500,"tickSpacing":10,"pool":"0x0000000000000000000000000000000000000000"}'
        );
        return string.concat(
            '{"admin":"',
            vm.toString(owner),
            '","guardian":"',
            vm.toString(guardian),
            '","screener":"',
            vm.toString(owner),
            '","usdc":"',
            vm.toString(address(USDC)),
            '","wmon":"',
            vm.toString(address(WMON)),
            '","uniswapV3Factory":"',
            vm.toString(UNI_V3_FACTORY),
            '","pancakeswapV3Factory":"',
            vm.toString(CAKE_V3_FACTORY),
            '","poolManager":"',
            vm.toString(POOL_MANAGER),
            '","stateView":"',
            vm.toString(STATE_VIEW),
            '","demoExecutor":"',
            vm.toString(owner),
            '","maxDeviationBps":200,"seeds":[',
            seeds,
            '],"pools":[',
            poolsJson,
            "]}"
        );
    }

    function _seed(address token, address feed, uint256 bps, uint256 maxAge) internal pure returns (string memory) {
        return string.concat(
            '{"token":"',
            vm.toString(token),
            '","maxPositionBps":',
            vm.toString(bps),
            ',"usdFeed":"',
            vm.toString(feed),
            '","usdDecimals":8,"usdMaxAge":',
            vm.toString(maxAge),
            ',"rateFeed":"0x0000000000000000000000000000000000000000","rateDecimals":0,"rateMaxAge":0}'
        );
    }

    function _v3Pool(uint256 venue, address pool, uint256 fee, int256 spacing) internal pure returns (string memory) {
        return string.concat(
            '{"venue":',
            vm.toString(venue),
            ',"token0":"',
            vm.toString(address(WMON)),
            '","token1":"',
            vm.toString(address(USDC)),
            '","fee":',
            vm.toString(fee),
            ',"tickSpacing":',
            vm.toString(spacing),
            ',"pool":"',
            vm.toString(pool),
            '"}'
        );
    }

    function test_TheCanaryUsesTheRealVenuesAndFeedsWithTheCapsAndAllowlist() public view {
        assertEq(tokens.tokenCount(), 2);
        assertEq(pools.poolCount(), 3);
        assertEq(address(executor.factory()), address(factory));
        assertEq(factory.personalCap(), CAP_E6);
        assertTrue(factory.isAllowlisted(owner));
        assertGt(oracle.priceE18(address(WMON)), 0, "MON priced by Chainlink");
        assertEq(oracle.priceE18(address(USDC)) / 1e16, 100, "USDC about 1 USD");
    }

    function test_TheCanaryRoundTripOnTheRealPools() public {
        vm.startPrank(owner);
        PersonalAccountV3 account = PersonalAccountV3(payable(factory.createPersonalAccount(1)));
        USDC.approve(address(account), DEPOSIT_E6);
        account.deposit(address(USDC), DEPOSIT_E6);
        executor.registerSession(1, session, uint64(block.timestamp + 23 hours));
        vm.stopPrank();

        bytes32[] memory v4 = new bytes32[](1);
        v4[0] = V4_POOL_ID;
        uint256 wmonOut = _swap(address(account), address(USDC), address(WMON), TRADE_E6, v4);
        assertGt(wmonOut, 0);
        uint256 usdcBack = _swap(address(account), address(WMON), address(USDC), wmonOut, v4);
        assertGt(usdcBack, TRADE_E6 * 97 / 100, "within the floor");

        bytes32[] memory v3 = new bytes32[](1);
        v3[0] = bytes32(uint256(uint160(UNI_V3_POOL)));
        wmonOut = _swap(address(account), address(USDC), address(WMON), TRADE_E6, v3);
        assertGt(wmonOut, 0);
        _swap(address(account), address(WMON), address(USDC), wmonOut, v3);

        SwapIntentV3 memory big = _intent(address(account), address(USDC), address(WMON), 1e6, v4);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(ExecutorV3.Rejected.selector, ReasonV3.TRADE_SIZE_EXCEEDED));
        executor.swap(big);

        vm.prank(guardian);
        executor.pauseAll();
        SwapIntentV3 memory paused = _intent(address(account), address(USDC), address(WMON), 100_000, v4);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(ExecutorV3.Rejected.selector, ReasonV3.PAUSED));
        executor.swap(paused);
        vm.prank(owner);
        account.withdraw(address(USDC), 1e6, owner);

        vm.startPrank(owner);
        executor.revokeSession(1);
        account.withdrawAll(owner);
        vm.stopPrank();
        assertEq(USDC.balanceOf(address(account)), 0);
        assertEq(WMON.balanceOf(address(account)), 0);
    }

    function _intent(address account, address tokenIn, address tokenOut, uint256 amountIn, bytes32[] memory route)
        internal
        returns (SwapIntentV3 memory)
    {
        uint8 decIn = tokenIn == address(USDC) ? 6 : 18;
        uint8 decOut = tokenOut == address(USDC) ? 6 : 18;
        uint256 floor =
            executor.floorFor(amountIn, oracle.priceE18(tokenIn), decIn, oracle.priceE18(tokenOut), decOut, 50);
        return SwapIntentV3({
            schemaVersion: 2,
            chainId: block.chainid,
            agentId: 1,
            account: account,
            actionId: keccak256(abi.encode("f-u13 canary dry run", ++actions)),
            ownerEpoch: agent.ownerEpoch(1),
            configEpoch: executor.configEpochOf(1),
            policyHash: executor.policyHash(),
            adapterId: ROUTER_ID,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minAmountOut: floor,
            deadline: uint64(block.timestamp + 120),
            route: route,
            attestationIn: "",
            attestationOut: ""
        });
    }

    function _swap(address account, address tokenIn, address tokenOut, uint256 amountIn, bytes32[] memory route)
        internal
        returns (uint256 out)
    {
        SwapIntentV3 memory i = _intent(account, tokenIn, tokenOut, amountIn, route);
        vm.prank(session);
        out = executor.swap(i);
        assertGe(out, i.minAmountOut);
    }
}
