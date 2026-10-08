// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {AgentNFT} from "../../src/AgentNFT.sol";
import {AccountFactory} from "../../src/custody/AccountFactory.sol";
import {PersonalAccount} from "../../src/custody/PersonalAccount.sol";
import {Executor} from "../../src/executor/Executor.sol";
import {OracleAdapter} from "../../src/oracle/OracleAdapter.sol";
import {Reason, SwapIntent} from "../../src/interfaces/IExecutor.sol";
import {DeployAccountFactory} from "../../script/DeployAccountFactory.s.sol";
import {DeployAgentNFT} from "../../script/DeployAgentNFT.s.sol";
import {DeployTestnetMarket, IStateViewLiquidity} from "../../script/DeployTestnetMarket.s.sol";
import {TestnetFeed} from "../../script/TestnetFeed.sol";
import {IFiatToken} from "../fork/CustodyFork.t.sol";

/// P2-EC part 1 dry run: the real testnet deploy scripts, in the order of the
/// unit, then a mint, a deposit, a buy and a sale on the P2-EC pool, a
/// blocked trade and a withdrawal, all on an in-memory fork of Monad testnet.
/// Nothing is sent to testnet. Runs only through `pnpm test:testnet-fork`,
/// which sets TESTNET_FORK=1 (the RPC alias resolves MONAD_TESTNET_RPC_URL).
contract TestnetDeployTest is Test {
    IFiatToken internal constant USDC = IFiatToken(0x534b2f3A21130d7a60830c2Df862319e593943A3);
    IFiatToken internal constant WMON = IFiatToken(0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541);
    address internal constant POOL_MANAGER = 0x451D64ab3b650040d2aE1886602b97ed6eDc643d;
    address internal constant STATE_VIEW = 0xB639209539c61BaF67AC04876315786F8D0b153c;
    address internal constant ENTROPY = 0x825c0390f379C631f3Cf11A82a37D20BddF93c07;
    bytes32 internal constant V4 = keccak256("uniswap-v4-mon-usdc-500");

    uint256 internal deployerKey = uint256(keccak256("p2ec testnet dry-run deployer"));
    uint256 internal claimKey = uint256(keccak256("p2ec testnet dry-run claim signer"));
    address internal deployer;
    address internal feedWriter = makeAddr("feed writer");
    address internal guardian = makeAddr("guardian");
    address internal sentinel = makeAddr("sentinel");
    address internal owner = makeAddr("agent owner");
    address internal session = makeAddr("session key");

    DeployTestnetMarket.Market internal market;
    AgentNFT internal nft;
    AccountFactory internal factory;
    Executor internal executor;
    OracleAdapter internal oracle;

    function setUp() public {
        if (!vm.envOr("TESTNET_FORK", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork("monad_testnet");
        deployer = vm.addr(deployerKey);
        vm.deal(deployer, 10 ether);
        vm.prank(USDC.masterMinter());
        USDC.configureMinter(address(this), 10e6);
        USDC.mint(deployer, 5e6);
        USDC.mint(owner, 2e6);

        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(deployerKey));
        vm.setEnv("DEPLOY_SALT_SCOPE", "p2ec.testnet");
        vm.setEnv("TESTNET_FEED_WRITER", vm.toString(feedWriter));
        vm.setEnv("TESTNET_USDC", vm.toString(address(USDC)));
        vm.setEnv("TESTNET_POOL_MANAGER", vm.toString(POOL_MANAGER));
        vm.setEnv("TESTNET_STATE_VIEW", vm.toString(STATE_VIEW));
        vm.setEnv("SEED_MON_WEI", "500000000000000000");
        vm.setEnv("SEED_USDC_RAW", "500000");
        vm.setEnv("SEED_LIQUIDITY", "95902508421861");
        vm.setEnv("SEED_TICK_LOWER", "-276420");
        vm.setEnv("SEED_TICK_UPPER", "-276220");
        market = new DeployTestnetMarket().run();

        vm.setEnv("AGENT_NFT_ADMIN", vm.toString(deployer));
        vm.setEnv("AGENT_NFT_CLAIM_SIGNER", vm.toString(vm.addr(claimKey)));
        vm.setEnv("AGENT_NFT_TREASURY", vm.toString(deployer));
        vm.setEnv("AGENT_NFT_IMAGE_BASE_URI", "ipfs://alpha-agents-images-pending/");
        vm.setEnv("AGENT_NFT_ENTROPY", vm.toString(ENTROPY));
        nft = new DeployAgentNFT().run();

        vm.setEnv("ACCOUNT_FACTORY_ADMIN", vm.toString(deployer));
        vm.setEnv("ACCOUNT_FACTORY_GUARDIAN", vm.toString(guardian));
        vm.setEnv("ACCOUNT_FACTORY_SENTINEL", vm.toString(sentinel));
        vm.setEnv("ACCOUNT_FACTORY_AGENT_NFT", vm.toString(address(nft)));
        vm.setEnv("ACCOUNT_FACTORY_USDC", vm.toString(address(USDC)));
        vm.setEnv("ACCOUNT_FACTORY_WMON", vm.toString(address(WMON)));
        vm.setEnv("ACCOUNT_FACTORY_PERSONAL_CAP", "100000000");
        vm.setEnv("ACCOUNT_FACTORY_PLATFORM_CAP", "2000000000");
        vm.setEnv("ACCOUNT_FACTORY_ALLOWLIST", vm.toString(owner));
        vm.setEnv("ORACLE_MON_USD_FEED", vm.toString(market.monUsdFeed));
        vm.setEnv("ORACLE_USDC_USD_FEED", vm.toString(market.usdcUsdFeed));
        vm.setEnv("ORACLE_STATE_VIEW", vm.toString(STATE_VIEW));
        vm.setEnv("ORACLE_POOL_ID", vm.toString(market.poolId));
        vm.setEnv("VENUE_POOL_MANAGER", vm.toString(POOL_MANAGER));
        vm.setEnv("VENUE_V3_ROUTER", vm.toString(address(0)));
        factory = new DeployAccountFactory().run();
        executor = Executor(factory.executor());
        oracle = OracleAdapter(factory.oracle());
    }

    function test_DeploymentUsesTheP2ecSaltsAndTheOperatorPrice() public view {
        bytes32 v1 = keccak256("alpha-agents.agent-nft.v1");
        bytes memory init = abi.encodePacked(
            type(AgentNFT).creationCode,
            abi.encode(
                deployer,
                vm.addr(claimKey),
                deployer,
                "ipfs://alpha-agents-images-pending/",
                0x000000006551c19487814612e58FE06813775758,
                0x55266d75D1a14E4572138116aF39863Ed6596E7F,
                0x41C8f39463A868d3A88af00cd0fe7102F30E44eC,
                ENTROPY
            )
        );
        assertTrue(vm.computeCreate2Address(v1, keccak256(init), CREATE2_FACTORY) != address(nft), "not at v1");
        assertEq(
            vm.computeCreate2Address(
                keccak256("alpha-agents.p2ec.testnet.agent-nft.v1"), keccak256(init), CREATE2_FACTORY
            ),
            address(nft)
        );
        assertEq(TestnetFeed(market.monUsdFeed).latestAnswer(), 1e8);
        assertEq(TestnetFeed(market.usdcUsdFeed).latestAnswer(), 1e8);
        assertGt(IStateViewLiquidity(STATE_VIEW).getLiquidity(market.poolId), 0);
        assertEq(oracle.priceE18(address(WMON)), 1e18, "1 MON = 1 USD");
        assertTrue(nft.claimRequired());
        assertEq(address(executor.registry()) != address(0), true);
    }

    function test_MintDepositTradeBlockAndWithdrawOnThePool() public {
        uint256 agentId = _mint(owner);
        vm.startPrank(owner);
        PersonalAccount account = PersonalAccount(factory.createPersonalAccount(agentId));
        USDC.approve(address(account), 0.5e6);
        account.deposit(address(USDC), 0.5e6);
        executor.registerSession(agentId, session, uint64(block.timestamp + 1 days));
        vm.stopPrank();

        // A buy of 0.05 USDC, then the WMON sold back (D-307's trade size).
        uint256 bought = _swap(account, agentId, address(USDC), address(WMON), 0.05e6, 1);
        assertGt(bought, 0.049 ether);
        assertEq(WMON.balanceOf(address(account)), bought);
        uint256 sold = _swap(account, agentId, address(WMON), address(USDC), bought, 2);
        assertGt(sold, 0.0498e6);

        // A trade over the 10% limit is refused with its reason, nothing moved.
        SwapIntent memory big = _intent(account, agentId, address(USDC), address(WMON), 0.2e6, 3);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(Executor.Rejected.selector, Reason.TRADE_SIZE_EXCEEDED));
        executor.swap(big);

        uint256 held = USDC.balanceOf(address(account));
        vm.prank(owner);
        account.withdrawAll(owner);
        assertEq(USDC.balanceOf(address(account)), 0);
        assertEq(USDC.balanceOf(owner), 2e6 - 0.5e6 + held);
    }

    function test_AStaleFeedBlocksATradeUntilRedated() public {
        uint256 agentId = _mint(owner);
        vm.startPrank(owner);
        PersonalAccount account = PersonalAccount(factory.createPersonalAccount(agentId));
        USDC.approve(address(account), 0.5e6);
        account.deposit(address(USDC), 0.5e6);
        executor.registerSession(agentId, session, uint64(block.timestamp + 1 days));
        vm.stopPrank();
        // Built while the price is fresh (the oracle refuses to price a stale feed).
        SwapIntent memory i = _intent(account, agentId, address(USDC), address(WMON), 0.05e6, 1);
        vm.warp(block.timestamp + 301);
        i.deadline = uint64(block.timestamp + 60);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(Executor.Rejected.selector, Reason.ORACLE_STALE));
        executor.swap(i);
        vm.startPrank(feedWriter);
        TestnetFeed(market.monUsdFeed).redate();
        TestnetFeed(market.usdcUsdFeed).redate();
        vm.stopPrank();
        _swap(account, agentId, address(USDC), address(WMON), 0.05e6, 2);
    }

    function test_TestnetRefusesTheV1Salts() public {
        vm.setEnv("DEPLOY_SALT_SCOPE", "");
        DeployAgentNFT script = new DeployAgentNFT();
        vm.expectRevert(bytes("Monad testnet deployments use DEPLOY_SALT_SCOPE=p2ec.testnet (D-249)"));
        script.run();
    }

    function _mint(address wallet) internal returns (uint256) {
        bytes32 nonce = keccak256(abi.encode("nonce", wallet));
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 structHash = keccak256(abi.encode(nft.CLAIM_TYPEHASH(), wallet, nonce, deadline));
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("AlphaAgents AgentNFT"),
                keccak256("1"),
                block.chainid,
                address(nft)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(claimKey, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        vm.prank(wallet);
        return nft.mintWithClaim(deadline, nonce, abi.encodePacked(r, s, v));
    }

    function _intent(
        PersonalAccount account,
        uint256 agentId,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 n
    ) internal view returns (SwapIntent memory) {
        return SwapIntent({
            schemaVersion: 1,
            chainId: block.chainid,
            agentId: agentId,
            account: address(account),
            actionId: keccak256(abi.encode("testnet dry run", n)),
            ownerEpoch: nft.ownerEpoch(agentId),
            configEpoch: 0,
            policyHash: executor.policyHash(),
            adapterId: V4,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minAmountOut: executor.oracleFloor(tokenIn, tokenOut, amountIn, oracle.priceE18(address(WMON)), 50),
            deadline: uint64(block.timestamp + 120)
        });
    }

    function _swap(
        PersonalAccount account,
        uint256 agentId,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 n
    ) internal returns (uint256 out) {
        SwapIntent memory i = _intent(account, agentId, tokenIn, tokenOut, amountIn, n);
        vm.prank(session);
        out = executor.swap(i);
        assertGe(out, i.minAmountOut);
    }
}
