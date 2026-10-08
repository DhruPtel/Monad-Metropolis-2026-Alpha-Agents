// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {AccountFactory} from "../../src/custody/AccountFactory.sol";
import {PersonalAccount} from "../../src/custody/PersonalAccount.sol";
import {Executor} from "../../src/executor/Executor.sol";
import {ProtocolRegistry} from "../../src/executor/ProtocolRegistry.sol";
import {OracleAdapter} from "../../src/oracle/OracleAdapter.sol";
import {Reason, SwapIntent} from "../../src/interfaces/IExecutor.sol";
import {CanaryAgent} from "../../script/CanaryAgent.sol";
import {DeployAccountFactory} from "../../script/DeployAccountFactory.s.sol";
import {DeployCanaryAgent} from "../../script/DeployCanaryAgent.s.sol";
import {IFiatToken} from "../fork/CustodyFork.t.sol";

/// P2-EC part 2 dry run: the real canary deploy scripts with the canary's
/// settings (D-252, D-258), then the canary run on the real Chainlink feeds
/// and the real Uniswap v4 MON/USDC 0.05% pool: an account, a 5 USDC deposit,
/// a 24-hour grant, a buy of 0.45 USDC and the sale back, an oversized buy
/// refused, the guardian's pause refusing a swap while the withdrawal works.
/// All on forge's in-memory fork of Monad mainnet; nothing is sent. Runs only
/// through `pnpm test:canary-fork`, which sets CANARY_FORK=true.
contract CanaryDeployTest is Test {
    IFiatToken internal constant USDC = IFiatToken(0x754704Bc059F8C67012fEd69BC8A327a5aafb603);
    IFiatToken internal constant WMON = IFiatToken(0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A);
    address internal constant MON_USD = 0xBcD78f76005B7515837af6b50c7C52BCf73822fb;
    address internal constant USDC_USD = 0xf5F15f188AbCB0d165D1Edb7f37F7d6fA2fCebec;
    address internal constant POOL_MANAGER = 0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e;
    address internal constant STATE_VIEW = 0x77395F3b2E73aE90843717371294fa97cC419D64;
    address internal constant ROUTER02 = 0xfE31F71C1b106EAc32F1A19239c9a9A72ddfb900;
    bytes32 internal constant POOL_ID = 0x18a9fc874581f3ba12b7898f80a683c66fd5877fd74b26a85ba9a3a79c549954;
    bytes32 internal constant V4 = keccak256("uniswap-v4-mon-usdc-500");
    bytes32 internal constant V3 = keccak256("uniswap-v3-usdc-wmon-3000");

    uint256 internal ownerKey = uint256(keccak256("p2ec canary dry-run owner"));
    address internal owner;
    address internal guardian = makeAddr("canary guardian");
    address internal session = makeAddr("canary session key");

    CanaryAgent internal agent;
    AccountFactory internal factory;
    Executor internal executor;
    OracleAdapter internal oracle;

    function setUp() public {
        if (!vm.envOr("CANARY_FORK", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork("monad");
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

        vm.setEnv("ACCOUNT_FACTORY_ADMIN", vm.toString(owner));
        vm.setEnv("ACCOUNT_FACTORY_GUARDIAN", vm.toString(guardian));
        vm.setEnv("ACCOUNT_FACTORY_SENTINEL", vm.toString(address(0)));
        vm.setEnv("ACCOUNT_FACTORY_AGENT_NFT", vm.toString(address(agent)));
        vm.setEnv("ACCOUNT_FACTORY_USDC", vm.toString(address(USDC)));
        vm.setEnv("ACCOUNT_FACTORY_WMON", vm.toString(address(WMON)));
        vm.setEnv("ACCOUNT_FACTORY_PERSONAL_CAP", "10000000");
        vm.setEnv("ACCOUNT_FACTORY_PLATFORM_CAP", "10000000");
        vm.setEnv("ACCOUNT_FACTORY_ALLOWLIST", vm.toString(owner));
        vm.setEnv("ORACLE_MON_USD_FEED", vm.toString(MON_USD));
        vm.setEnv("ORACLE_USDC_USD_FEED", vm.toString(USDC_USD));
        vm.setEnv("ORACLE_STATE_VIEW", vm.toString(STATE_VIEW));
        vm.setEnv("ORACLE_POOL_ID", vm.toString(POOL_ID));
        vm.setEnv("VENUE_POOL_MANAGER", vm.toString(POOL_MANAGER));
        vm.setEnv("VENUE_V3_ROUTER", vm.toString(ROUTER02));
        factory = new DeployAccountFactory().run();
        executor = Executor(factory.executor());
        oracle = OracleAdapter(factory.oracle());
        vm.setEnv("DEPLOY_SALT_SCOPE", "");
        vm.setEnv("CANARY_SIGNING_ENABLED", "false");
    }

    function test_TheCanaryUsesItsSaltsCapsAllowlistAndBothVenues() public view {
        bytes memory init = abi.encodePacked(type(CanaryAgent).creationCode, abi.encode(owner));
        assertEq(
            vm.computeCreate2Address(
                keccak256("alpha-agents.p2ec.canary.canary-agent.v1"), keccak256(init), CREATE2_FACTORY
            ),
            address(agent)
        );
        assertEq(agent.ownerOf(1), owner);
        assertEq(factory.personalCap(), 10e6);
        assertEq(factory.platformCap(), 10e6);
        assertTrue(factory.allowlistEnabled());
        assertTrue(factory.isAllowlisted(owner));
        assertFalse(factory.isAllowlisted(guardian));
        assertEq(factory.sentinel(), address(0));
        assertEq(executor.owner(), owner);
        assertEq(executor.guardian(), guardian);
        ProtocolRegistry registry = executor.registry();
        assertTrue(registry.adapterFor(V4, address(WMON), address(USDC)) != address(0), "v4 active");
        assertTrue(registry.entry(V3).adapter != address(0), "v3 registered");
        assertEq(registry.adapterFor(V3, address(WMON), address(USDC)), address(0), "v3 paused");
        assertGt(oracle.priceE18(address(WMON)), 0, "the real MON price");
    }

    function test_TheCanaryRunOnTheRealPool() public {
        vm.startPrank(owner);
        PersonalAccount account = PersonalAccount(factory.createPersonalAccount(1));
        USDC.approve(address(account), 5e6);
        account.deposit(address(USDC), 5e6);
        executor.registerSession(1, session, uint64(block.timestamp + 24 hours));
        vm.stopPrank();

        // D-258: a buy of about 0.45 USDC of WMON and the sale back, within the 50 bps floor.
        uint256 bought = _swap(account, address(USDC), address(WMON), 0.45e6, 1);
        assertEq(WMON.balanceOf(address(account)), bought);
        uint256 sold = _swap(account, address(WMON), address(USDC), bought, 2);
        assertGt(sold, 0.44e6, "about what was spent");
        assertEq(WMON.balanceOf(address(account)), 0);

        // An oversized buy (more than 10% of the account) is refused with its reason.
        SwapIntent memory big = _intent(account, address(USDC), address(WMON), 1e6, 3);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(Executor.Rejected.selector, Reason.TRADE_SIZE_EXCEEDED));
        executor.swap(big);

        // The guardian pauses: a swap is refused, and the owner still withdraws everything.
        vm.prank(guardian);
        executor.pauseAll();
        SwapIntent memory small = _intent(account, address(USDC), address(WMON), 0.1e6, 4);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(Executor.Rejected.selector, Reason.PAUSED));
        executor.swap(small);
        vm.startPrank(owner);
        executor.revokeSession(1);
        account.withdrawAll(owner);
        vm.stopPrank();
        assertEq(USDC.balanceOf(address(account)), 0);
        assertEq(WMON.balanceOf(address(account)), 0);
        assertEq(USDC.balanceOf(owner), 5e6 - 0.45e6 + sold);
    }

    function _intent(PersonalAccount account, address tokenIn, address tokenOut, uint256 amountIn, uint256 n)
        internal
        view
        returns (SwapIntent memory)
    {
        return SwapIntent({
            schemaVersion: 1,
            chainId: block.chainid,
            agentId: 1,
            account: address(account),
            actionId: keccak256(abi.encode("canary dry run", n)),
            ownerEpoch: 0,
            configEpoch: executor.configEpochOf(1),
            policyHash: executor.policyHash(),
            adapterId: V4,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minAmountOut: executor.oracleFloor(tokenIn, tokenOut, amountIn, oracle.priceE18(address(WMON)), 50),
            deadline: uint64(block.timestamp + 120)
        });
    }

    function _swap(PersonalAccount account, address tokenIn, address tokenOut, uint256 amountIn, uint256 n)
        internal
        returns (uint256 out)
    {
        SwapIntent memory i = _intent(account, tokenIn, tokenOut, amountIn, n);
        vm.prank(session);
        out = executor.swap(i);
        assertGe(out, i.minAmountOut);
    }
}
