// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test, console} from "forge-std/Test.sol";
import {AgentNFT} from "../../src/AgentNFT.sol";
import {AccountFactoryV3} from "../../src/fund/AccountFactoryV3.sol";
import {AttestationVerifier} from "../../src/fund/AttestationVerifier.sol";
import {ExecutorV3} from "../../src/fund/ExecutorV3.sol";
import {OracleAdapterV3} from "../../src/fund/OracleAdapterV3.sol";
import {PersonalAccountV3} from "../../src/fund/PersonalAccountV3.sol";
import {ProtocolRegistryV3} from "../../src/fund/ProtocolRegistryV3.sol";
import {StrategyVaultV3} from "../../src/fund/StrategyVaultV3.sol";
import {TokenRegistry} from "../../src/fund/TokenRegistry.sol";
import {ReasonV3, SwapIntentV3} from "../../src/interfaces/IExecutorV3.sol";
import {Lane} from "../../src/interfaces/IFund.sol";
import {BindExecutorV3} from "../../script/BindExecutorV3.s.sol";
import {DeployAgentNFT} from "../../script/DeployAgentNFT.s.sol";
import {DeployAttestor} from "../../script/DeployAttestor.s.sol";
import {DeployCustodyV3} from "../../script/DeployCustodyV3.s.sol";
import {DeployExecutorV3} from "../../script/DeployExecutorV3.s.sol";
import {DeployFund} from "../../script/DeployFund.s.sol";
import {DeployTestnetMarket, IStateViewLiquidity} from "../../script/DeployTestnetMarket.s.sol";
import {DeployTestnetTokens} from "../../script/DeployTestnetTokens.s.sol";
import {TestnetToken} from "../../script/TestnetToken.sol";
import {IFiatToken} from "../fork/CustodyFork.t.sol";

/// F-U13's dry run: the whole current stack's deploy scripts on an in-memory
/// fork of Monad testnet, in the unit's order (the P2-EC market found, two
/// more tokens with feeds and seeded pools, the new AgentNFT, the fund set,
/// Executor v3 and its set, AccountFactoryV3 with the two implementations,
/// the binding, the attestation verifier and the SET_VERIFIER proposal),
/// with each step's gas, then a mint, a v3 account, a deposit, a session on
/// Executor v3, a buy of WMON through the MON/USDC pool and a two-hop buy of
/// a testnet token, the sales back, an over-limit trade refused, the
/// withdrawal, and a vault: created, staked by the owner, opened, a
/// depositor's deposit, a trade from the vault, and both redeemed after the
/// lock. Nothing is sent to testnet. Runs only through `pnpm test:testnet-fork`.
contract TestnetDeployV3Test is Test {
    IFiatToken internal constant USDC = IFiatToken(0x534b2f3A21130d7a60830c2Df862319e593943A3);
    IFiatToken internal constant WMON = IFiatToken(0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541);
    address internal constant POOL_MANAGER = 0x451D64ab3b650040d2aE1886602b97ed6eDc643d;
    address internal constant STATE_VIEW = 0xB639209539c61BaF67AC04876315786F8D0b153c;
    address internal constant ENTROPY = 0x825c0390f379C631f3Cf11A82a37D20BddF93c07;
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    /// P2-EC's pool seeder on testnet: the deployer below is pranked as its owner.
    address internal constant P2EC_SEEDER = 0xA4adD8Adbb6C04De71dC313322913b7084a9424A;
    address internal constant P2EC_DEPLOYER = 0x5C0Fb609931651357dcfd2b985910E3fC5904A4a;
    bytes32 internal constant ROUTER_ID = keccak256("route-adapter");
    uint256 internal constant FEED_MAX_AGE = 30 days;

    uint256 internal claimKey = uint256(keccak256("f-u13 testnet dry-run claim signer"));
    address internal deployer = P2EC_DEPLOYER;
    address internal feedWriter = makeAddr("feed writer");
    address internal guardian = makeAddr("guardian");
    address internal sentinel = makeAddr("sentinel");
    address internal screener = makeAddr("screener");
    address internal attestor = makeAddr("attestor");
    address internal owner = makeAddr("agent owner");
    address internal depositor = makeAddr("vault depositor");
    address internal session = makeAddr("session key");

    DeployTestnetMarket.Market internal market;
    DeployTestnetTokens.Tokens internal more;
    AgentNFT internal nft;
    TokenRegistry internal tokens;
    ExecutorV3 internal executor;
    OracleAdapterV3 internal oracle;
    ProtocolRegistryV3 internal pools;
    AccountFactoryV3 internal factory;
    AttestationVerifier internal verifier;
    uint256 internal actions;
    mapping(string => uint256) internal gasOf;

    function setUp() public {
        if (!vm.envOr("TESTNET_FORK", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork("monad_testnet");
        // The real deployer, as the P2-EC seeder's owner, with the key the scripts broadcast with.
        uint256 deployerKey = vm.envUint("TESTNET_DEPLOYER_PRIVATE_KEY");
        require(vm.addr(deployerKey) == deployer, "TESTNET_DEPLOYER_PRIVATE_KEY is not P2-EC's deployer");
        vm.deal(deployer, 20 ether);
        vm.prank(USDC.masterMinter());
        USDC.configureMinter(address(this), 100e6);
        USDC.mint(deployer, 5e6);
        USDC.mint(owner, 20e6);
        USDC.mint(depositor, 20e6);

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
        market = _measured("1 market", _market);
        assertEq(market.seeder, P2EC_SEEDER, "the P2-EC seeder is found, not deployed again");

        vm.setEnv("POOL_SEEDER", vm.toString(market.seeder));
        vm.setEnv("TOKEN_SEED_MON_WEI", "500000000000000000");
        vm.setEnv("TOKEN_SEED_TOKEN_WEI", "500000000000000000");
        vm.setEnv("TOKEN_SEED_LIQUIDITY", "100000000000000000000");
        vm.setEnv("TOKEN_SEED_TICK_LOWER", "-100");
        vm.setEnv("TOKEN_SEED_TICK_UPPER", "100");
        vm.startSnapshotGas("2 tokens");
        more = new DeployTestnetTokens().run();
        gasOf["2 tokens"] = vm.stopSnapshotGas();

        vm.setEnv("AGENT_NFT_ADMIN", vm.toString(deployer));
        vm.setEnv("AGENT_NFT_CLAIM_SIGNER", vm.toString(vm.addr(claimKey)));
        vm.setEnv("AGENT_NFT_TREASURY", vm.toString(deployer));
        vm.setEnv("AGENT_NFT_IMAGE_BASE_URI", "ipfs://alpha-agents-images-pending/");
        vm.setEnv("AGENT_NFT_ENTROPY", vm.toString(ENTROPY));
        vm.startSnapshotGas("3 agent nft");
        nft = new DeployAgentNFT().run();
        gasOf["3 agent nft"] = vm.stopSnapshotGas();

        string memory fund = _fundConfig();
        vm.setEnv("FUND_CONFIG", fund);
        vm.startSnapshotGas("4 fund set");
        DeployFund fundScript = new DeployFund();
        fundScript.run();
        gasOf["4 fund set"] = vm.stopSnapshotGas();
        tokens = fundScript.deployedTokens();

        vm.setEnv("EXECUTOR_V3_TOKEN_REGISTRY", vm.toString(address(tokens)));
        vm.setEnv("EXECUTOR_V3_AGENT_NFT", vm.toString(address(nft)));
        vm.startSnapshotGas("5 executor v3");
        DeployExecutorV3 execScript = new DeployExecutorV3();
        execScript.run();
        gasOf["5 executor v3"] = vm.stopSnapshotGas();
        executor = execScript.deployedExecutor();
        pools = execScript.deployedPools();
        oracle = execScript.deployedOracle();

        vm.setEnv("CUSTODY_V3_ADMIN", vm.toString(deployer));
        vm.setEnv("CUSTODY_V3_GUARDIAN", vm.toString(guardian));
        vm.setEnv("CUSTODY_V3_SENTINEL", vm.toString(sentinel));
        vm.setEnv("CUSTODY_V3_AGENT_NFT", vm.toString(address(nft)));
        vm.setEnv("CUSTODY_V3_USDC", vm.toString(address(USDC)));
        vm.setEnv("CUSTODY_V3_TOKEN_REGISTRY", vm.toString(address(tokens)));
        vm.setEnv("CUSTODY_V3_ORACLE", vm.toString(address(oracle)));
        vm.setEnv("CUSTODY_V3_EXECUTOR", vm.toString(address(executor)));
        vm.setEnv("CUSTODY_V3_PERSONAL_CAP", "100000000");
        vm.setEnv("CUSTODY_V3_VAULT_CAP", "500000000");
        vm.setEnv("CUSTODY_V3_PLATFORM_CAP", "2000000000");
        vm.setEnv("CUSTODY_V3_DEPOSITS_ENABLED", "false");
        vm.setEnv("CUSTODY_V3_ALLOWLIST", string.concat(vm.toString(owner), ",", vm.toString(depositor)));
        vm.startSnapshotGas("6 custody v3");
        factory = new DeployCustodyV3().run();
        vm.setEnv("EXECUTOR_V3", vm.toString(address(executor)));
        vm.setEnv("EXECUTOR_V3_FACTORY", vm.toString(address(factory)));
        vm.setEnv("EXECUTOR_V3_POOLS", vm.toString(address(pools)));
        new BindExecutorV3().run();
        gasOf["6 custody v3 and bind"] = vm.stopSnapshotGas();

        vm.setEnv("ATTESTOR_ADDRESS", vm.toString(attestor));
        vm.startSnapshotGas("7 verifier");
        DeployAttestor attestorScript = new DeployAttestor();
        attestorScript.run();
        gasOf["7 verifier"] = vm.stopSnapshotGas();
        verifier = attestorScript.deployedVerifier();
    }

    function _market() internal returns (DeployTestnetMarket.Market memory) {
        return new DeployTestnetMarket().run();
    }

    function _measured(string memory name, function() internal returns (DeployTestnetMarket.Market memory) f)
        internal
        returns (DeployTestnetMarket.Market memory m)
    {
        vm.startSnapshotGas(name);
        m = f();
        gasOf[name] = vm.stopSnapshotGas();
    }

    /// The same FUND_CONFIG scripts/deploy-testnet-v3.js builds, on the fork's addresses.
    function _fundConfig() internal view returns (string memory) {
        string memory seeds = string.concat(
            _seed(address(USDC), market.usdcUsdFeed, 10_000),
            ",",
            _seed(address(WMON), market.monUsdFeed, 4_000),
            ",",
            _seed(more.alpha.token, more.alpha.feed, 4_000),
            ",",
            _seed(more.beta.token, more.beta.feed, 4_000)
        );
        string memory poolsJson = string.concat(
            _pool(address(USDC)), ",", _pool(more.alpha.token), ",", _pool(more.beta.token)
        );
        return string.concat(
            '{"admin":"', vm.toString(deployer),
            '","guardian":"', vm.toString(guardian),
            '","screener":"', vm.toString(screener),
            '","usdc":"', vm.toString(address(USDC)),
            '","wmon":"', vm.toString(address(WMON)),
            '","uniswapV3Factory":"', vm.toString(CREATE2_DEPLOYER),
            '","pancakeswapV3Factory":"', vm.toString(CREATE2_DEPLOYER),
            '","poolManager":"', vm.toString(POOL_MANAGER),
            '","stateView":"', vm.toString(STATE_VIEW),
            '","demoExecutor":"', vm.toString(deployer),
            '","maxDeviationBps":200,"seeds":[', seeds, '],"pools":[', poolsJson, "]}"
        );
    }

    function _seed(address token, address feed, uint256 bps) internal pure returns (string memory) {
        return string.concat(
            '{"token":"', vm.toString(token), '","maxPositionBps":', vm.toString(bps),
            ',"usdFeed":"', vm.toString(feed), '","usdDecimals":8,"usdMaxAge":', vm.toString(FEED_MAX_AGE),
            ',"rateFeed":"0x0000000000000000000000000000000000000000","rateDecimals":0,"rateMaxAge":0}'
        );
    }

    function _pool(address token1) internal pure returns (string memory) {
        return string.concat(
            '{"venue":3,"token0":"0x0000000000000000000000000000000000000000","token1":"', vm.toString(token1),
            '","fee":500,"tickSpacing":10,"pool":"0x0000000000000000000000000000000000000000"}'
        );
    }

    function test_EveryStepDeploysAtTheP2ecSaltsWithTheTokensAndPoolsListed() public view {
        assertEq(TestnetToken(more.alpha.token).symbol(), "TALPHA");
        assertEq(TestnetToken(more.beta.token).symbol(), "TBETA");
        assertGt(IStateViewLiquidity(STATE_VIEW).getLiquidity(more.alpha.poolId), 0);
        assertGt(IStateViewLiquidity(STATE_VIEW).getLiquidity(more.beta.poolId), 0);
        assertGt(IStateViewLiquidity(STATE_VIEW).getLiquidity(market.poolId), 0, "the P2-EC pool still has liquidity");
        assertEq(tokens.tokenCount(), 4, "USDC, WMON and the two tokens are core");
        assertEq(uint8(tokens.tokenRecord(more.alpha.token).lane), uint8(Lane.CORE));
        assertEq(pools.poolCount(), 3, "three native MON v4 pools");
        assertEq(oracle.priceE18(address(WMON)), 1e18, "1 MON = 1 USD");
        assertEq(oracle.priceE18(more.alpha.token), 1e18, "1 TALPHA = 1 USD");
        assertEq(address(executor.factory()), address(factory), "bound");
        assertEq(verifier.ATTESTOR(), attestor);
        assertTrue(nft.claimRequired());
    }

    function test_MintOpenDepositArmTradeBothRoutesRefuseAndWithdraw() public {
        uint256 agentId = _mint(owner);
        vm.startPrank(owner);
        PersonalAccountV3 account = PersonalAccountV3(payable(factory.createPersonalAccount(agentId)));
        USDC.approve(address(account), 5e6);
        account.deposit(address(USDC), 5e6);
        executor.registerSession(agentId, session, uint64(block.timestamp + 1 days));
        vm.stopPrank();

        // One hop: 0.05 USDC for WMON through the P2-EC native MON pool (the adapter wraps).
        bytes32[] memory one = new bytes32[](1);
        one[0] = market.poolId;
        uint256 wmonOut = _swap(address(account), agentId, address(USDC), address(WMON), 0.05e6, one);
        assertGt(wmonOut, 0.049 ether);
        assertEq(WMON.balanceOf(address(account)), wmonOut);
        // Two hops: 0.05 USDC through the MON/USDC pool and the MON/TALPHA pool.
        bytes32[] memory two = new bytes32[](2);
        two[0] = market.poolId;
        two[1] = more.alpha.poolId;
        uint256 alphaOut = _swap(address(account), agentId, address(USDC), more.alpha.token, 0.05e6, two);
        assertGt(alphaOut, 0.049 ether);
        // Both sold back.
        uint256 usdcBack = _swap(address(account), agentId, address(WMON), address(USDC), wmonOut, one);
        assertGt(usdcBack, 0.0495e6);
        bytes32[] memory back = new bytes32[](2);
        back[0] = more.alpha.poolId;
        back[1] = market.poolId;
        usdcBack = _swap(address(account), agentId, more.alpha.token, address(USDC), alphaOut, back);
        assertGt(usdcBack, 0.0495e6);

        // A trade over the 10% limit is refused with its reason, nothing moved.
        SwapIntentV3 memory big = _intent(address(account), agentId, address(USDC), address(WMON), 2e6, one);
        vm.prank(session);
        vm.expectRevert(abi.encodeWithSelector(ExecutorV3.Rejected.selector, ReasonV3.TRADE_SIZE_EXCEEDED));
        executor.swap(big);

        uint256 held = USDC.balanceOf(address(account));
        vm.prank(owner);
        account.withdrawAll(owner);
        assertEq(USDC.balanceOf(address(account)), 0);
        assertEq(USDC.balanceOf(owner), 20e6 - 5e6 + held);
    }

    function test_VaultCreatedStakedOpenedDepositedTradedAndRedeemedAfterTheLock() public {
        uint256 agentId = _mint(owner);
        vm.startPrank(owner);
        StrategyVaultV3 vault = StrategyVaultV3(payable(factory.createVault(agentId)));
        USDC.approve(address(vault), 2e6);
        uint256 ownerShares = vault.deposit(2e6, 0);
        vault.setDepositsOpen(true);
        executor.registerVaultSession(agentId, session);
        vm.stopPrank();
        assertGt(ownerShares, 0);

        vm.startPrank(depositor);
        USDC.approve(address(vault), 3e6);
        uint256 shares = vault.deposit(3e6, 0);
        vm.stopPrank();
        assertGt(shares, 0);

        // The vault trades through Executor v3 like a personal account: 0.05 USDC for WMON.
        bytes32[] memory one = new bytes32[](1);
        one[0] = market.poolId;
        uint256 wmonOut = _swap(address(vault), agentId, address(USDC), address(WMON), 0.05e6, one);
        assertGt(wmonOut, 0.049 ether);

        // After the lock, the depositor leaves in USDC and the owner in kind.
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(depositor);
        vault.redeem(shares, depositor, 0, uint64(block.timestamp + 120));
        assertGt(USDC.balanceOf(depositor), 20e6 - 3e6, "the depositor got USDC back");
        vm.prank(owner);
        vault.redeemInKind(ownerShares, owner);
        assertGt(WMON.balanceOf(owner), 0, "the owner got the WMON share");
    }

    function test_TheVerifierIsProposedAndSetAfterTheNineDayTimelock() public {
        uint8 action = tokens.SET_VERIFIER();
        bytes memory data = abi.encode(address(verifier));
        vm.prank(deployer);
        tokens.propose(action, data);
        (uint64 executableAt,) = tokens.pending(tokens.changeId(action, data));
        assertEq(executableAt, uint64(block.timestamp + tokens.RISK_TIMELOCK()));
        vm.warp(executableAt + 1);
        tokens.execute(action, data);
        assertEq(tokens.verifier(), address(verifier));
    }

    function test_GasOfEveryStep() public view {
        string[7] memory steps =
            ["1 market", "2 tokens", "3 agent nft", "4 fund set", "5 executor v3", "6 custody v3 and bind", "7 verifier"];
        uint256 total;
        for (uint256 i = 0; i < steps.length; ++i) {
            console.log("GAS", steps[i], gasOf[steps[i]]);
            total += gasOf[steps[i]];
        }
        console.log("GAS total", total);
        assertGt(total, 0);
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
        address account,
        uint256 agentId,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        bytes32[] memory route
    ) internal returns (SwapIntentV3 memory) {
        uint8 decIn = TestnetToken(tokenIn).decimals();
        uint8 decOut = TestnetToken(tokenOut).decimals();
        uint256 floor = executor.floorFor(
            amountIn, oracle.priceE18(tokenIn), decIn, oracle.priceE18(tokenOut), decOut, 50
        );
        return SwapIntentV3({
            schemaVersion: 2,
            chainId: block.chainid,
            agentId: agentId,
            account: account,
            actionId: keccak256(abi.encode("f-u13 testnet dry run", ++actions)),
            ownerEpoch: nft.ownerEpoch(agentId),
            configEpoch: executor.configEpochOf(agentId),
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

    function _swap(
        address account,
        uint256 agentId,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        bytes32[] memory route
    ) internal returns (uint256 out) {
        SwapIntentV3 memory i = _intent(account, agentId, tokenIn, tokenOut, amountIn, route);
        vm.prank(session);
        out = executor.swap(i);
        assertGe(out, i.minAmountOut);
    }
}
