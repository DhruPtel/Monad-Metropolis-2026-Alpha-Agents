// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AccountFactoryV3} from "../../src/fund/AccountFactoryV3.sol";
import {ExecutorV3} from "../../src/fund/ExecutorV3.sol";
import {PersonalAccountV3} from "../../src/fund/PersonalAccountV3.sol";
import {RouteAdapter} from "../../src/fund/RouteAdapter.sol";
import {OracleAdapterV3} from "../../src/fund/OracleAdapterV3.sol";
import {IAgentNFTView} from "../../src/interfaces/ICustody.sol";
import {SwapIntentV3} from "../../src/interfaces/IExecutorV3.sol";

interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// The monad-dev set on a fork of Monad testnet (2026-10-16), as `pnpm deploy:dev --rpc-env
/// DEVFORK_RPC` deployed it there (evidence/dev-nadfun/fork-deployment.json): an account buys an
/// existing nad.fun token with nad.fun's test USDC through WMON, two Uniswap v2 family hops, in
/// the testnet price mode (the fill checked against the route's own quote), past the old 60%
/// one-token cap, and sells it back. Skipped unless DEVFORK_RPC is set.
contract DevNadfunForkTest is Test {
    bytes32 internal constant ROUTER = keccak256("route-adapter");
    uint256 internal constant AGENT = 900_001;

    ExecutorV3 internal executor;
    AccountFactoryV3 internal factory;
    RouteAdapter internal adapter;
    OracleAdapterV3 internal oracle;
    address internal nft;
    address internal usdc;
    address internal wmon;
    address internal token;
    bytes32 internal basePair;
    bytes32 internal tokenPair;
    /// The dev stack's allowlisted test wallet (deposits are allowlisted).
    address internal owner;
    address internal session = makeAddr("dev session");
    PersonalAccountV3 internal account;
    uint256 internal actions;

    function setUp() public {
        string memory rpc = vm.envOr("DEVFORK_RPC", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);
        string memory json = vm.readFile("../../evidence/dev-nadfun/fork-deployment.json");
        executor = ExecutorV3(vm.parseJsonAddress(json, ".executorV3.executor"));
        factory = AccountFactoryV3(vm.parseJsonAddress(json, ".custodyV3.factory"));
        adapter = RouteAdapter(payable(vm.parseJsonAddress(json, ".executorV3.routeAdapter")));
        oracle = OracleAdapterV3(vm.parseJsonAddress(json, ".executorV3.oracle"));
        nft = vm.parseJsonAddress(json, ".agentNft");
        owner = vm.parseJsonAddress(json, ".roles.testWallet");
        usdc = vm.parseJsonAddress(json, ".venue.usdc");
        wmon = vm.parseJsonAddress(json, ".venue.wmon");
        basePair = bytes32(uint256(uint160(vm.parseJsonAddress(json, ".venue.basePair"))));
        // The deepest discovered token: TTT-like launch tokens pair against WMON.
        token = vm.parseJsonAddress(json, ".tokens[0].token");
        tokenPair = bytes32(uint256(uint160(vm.parseJsonAddress(json, ".tokens[0].pair"))));

        vm.mockCall(nft, abi.encodeCall(IAgentNFTView.ownerOf, (AGENT)), abi.encode(owner));
        vm.mockCall(nft, abi.encodeCall(IAgentNFTView.ownerEpoch, (AGENT)), abi.encode(uint64(0)));
        vm.startPrank(owner);
        account = PersonalAccountV3(factory.createPersonalAccount(AGENT));
        IMintable(usdc).mint(owner, 100e6);
        IERC20(usdc).approve(address(account), 100e6);
        account.deposit(usdc, 100e6);
        executor.registerSession(AGENT, session, uint64(block.timestamp + 1 days));
        vm.stopPrank();
    }

    function test_BuysAnExistingNadfunTokenPastTheOldCapAndSellsItBack() public {
        assertTrue(oracle.quoteMode(), "the dev set prices by its pairs");
        assertEq(account.MAX_ASSET_BPS(), 10_000);
        bytes32[] memory buy = new bytes32[](2);
        buy[0] = basePair;
        buy[1] = tokenPair;
        // Three buys of 22 USDC (the per-trade cap is 25% of a value fees lower): the token ends above 60%.
        for (uint256 i = 0; i < 3; ++i) {
            uint256 quoted = adapter.quoteRoute(usdc, 22e6, buy);
            uint256 got = _swap(usdc, token, 22e6, quoted * 9_900 / 10_000, buy);
            assertEq(got, quoted, "the fill is the route's quote");
        }
        assertGt(IERC20(token).balanceOf(address(account)), 0);
        (uint256 nav,,,) = account.breakerState();
        uint256 tokenValue = nav - IERC20(usdc).balanceOf(address(account));
        assertGt(tokenValue * 10_000, nav * 6_000, "one token above the old 60% cap");

        bytes32[] memory sell = new bytes32[](2);
        sell[0] = tokenPair;
        sell[1] = basePair;
        uint256 held = IERC20(token).balanceOf(address(account));
        // A third of it (about 21% of the account: one trade moves at most 25%).
        uint256 back = adapter.quoteRoute(token, held / 3, sell);
        assertEq(_swap(token, usdc, held / 3, back * 9_900 / 10_000, sell), back);
    }

    function test_RefusesAMinimumAboveTheQuoteLessTheSlippageLimit() public {
        bytes32[] memory buy = new bytes32[](2);
        buy[0] = basePair;
        buy[1] = tokenPair;
        uint256 quoted = adapter.quoteRoute(usdc, 10e6, buy);
        // A minimum under the quote less 3% is refused by the Executor's quote-mode floor.
        SwapIntentV3 memory i = _intent(usdc, token, 10e6, quoted * 9_600 / 10_000, buy);
        vm.prank(session);
        vm.expectRevert();
        executor.swap(i);
    }

    function _swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, bytes32[] memory route)
        internal
        returns (uint256)
    {
        SwapIntentV3 memory i = _intent(tokenIn, tokenOut, amountIn, minOut, route);
        vm.prank(session);
        return executor.swap(i);
    }

    function _intent(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, bytes32[] memory route)
        internal
        returns (SwapIntentV3 memory)
    {
        return SwapIntentV3({
            schemaVersion: executor.SCHEMA_VERSION(),
            chainId: block.chainid,
            agentId: AGENT,
            account: address(account),
            actionId: keccak256(abi.encode("dev fork", ++actions)),
            ownerEpoch: 0,
            configEpoch: executor.configEpochOf(AGENT),
            policyHash: executor.policyHash(),
            adapterId: ROUTER,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minAmountOut: minOut,
            deadline: uint64(block.timestamp + 60),
            route: route,
            attestationIn: "",
            attestationOut: ""
        });
    }
}
