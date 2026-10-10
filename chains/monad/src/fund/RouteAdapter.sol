// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolRegistry, PoolRecord, Venue} from "../interfaces/IFund.sol";
import {IPoolManager, IUnlockCallback, IWMON, PoolKey, V4SwapParams} from "../interfaces/IUniswap.sol";
import {IUniswapV3PoolActions, IV3SwapCallbacks} from "../interfaces/IUniswapV3.sol";

/// @title RouteAdapter
/// @notice The fund agent's generic venue adapter (FINAL_PLAN 0.4, D-341,
/// D-354), written clean-room: one exact-input route of up to three hops
/// through pools the ProtocolRegistryV3 lists, on Uniswap v3, PancakeSwap v3
/// and hookless Uniswap v4, in any mix.
///
/// - Only the Executor may call `swapRoute`, after transferring exactly
///   `amountIn` of `tokenIn` here. A route is a list of registered pool IDs: no
///   router, target, selector or calldata comes from the caller.
/// - v3 pools are swapped directly and paid inside their callback, which only
///   the pool being swapped may make. v4 hops run inside PoolManager's unlock
///   and settle by transfer or value. So no approval is ever given, and none
///   can be left behind.
/// - Accounts hold WMON, never native MON (D-167): a v4 hop whose pool holds
///   native MON unwraps WMON going in and wraps MON coming out.
/// - The output goes only to `recipient`, and so does any input or
///   intermediate token a hop left unspent; the adapter checks before
///   returning that it keeps nothing of any token the route touched.
contract RouteAdapter is IUnlockCallback, IV3SwapCallbacks, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_HOPS = 3;
    /// v3 and v4 price limits one step inside the ends: no limit.
    uint160 internal constant MIN_SQRT_PRICE_PLUS_ONE = 4_295_128_740;
    uint160 internal constant MAX_SQRT_PRICE_MINUS_ONE =
        1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341;

    IPoolRegistry public immutable REGISTRY;
    IPoolManager public immutable POOL_MANAGER;
    address public immutable WMON;
    address public immutable USDC;
    address public immutable EXECUTOR;

    /// The v3 pool being swapped and its tokens: the only callback accepted.
    address private _activePool;
    address private _active0;
    address private _active1;
    /// Set only while PoolManager's unlock runs this adapter's callback.
    bool private _inUnlock;

    event RouteSwapped(
        address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, address recipient
    );

    error NotExecutor(address caller);
    error BadRoute();
    error BrokenRoute(uint256 hop);
    error InputMissing(uint256 held, uint256 amountIn);
    error OutputTooLow(uint256 out, uint256 minAmountOut);
    error NotActivePool(address caller);
    error NotPoolManager(address caller);
    error NativeRefused(address from);
    error FundsLeft(address token, uint256 amount);
    error AmountTooLarge();
    error SettledShort(uint256 paid, uint256 owed);

    constructor(IPoolRegistry registry, IPoolManager poolManager, address wmon, address usdc, address executor) {
        if (
            address(registry) == address(0) || address(poolManager) == address(0) || wmon == address(0)
                || usdc == address(0) || executor == address(0)
        ) revert BadRoute();
        REGISTRY = registry;
        POOL_MANAGER = poolManager;
        WMON = wmon;
        USDC = usdc;
        EXECUTOR = executor;
    }

    /// Swaps exactly `amountIn` of `tokenIn` (already here) along `route`,
    /// paying at least `minAmountOut` of `tokenOut` to `recipient`. Screened
    /// pools are usable only when the Executor passes `allowScreened` (the
    /// account's owner opted in, D-351, or the account sells a screened token
    /// through its own pool, D-365).
    function swapRoute(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        bytes32[] calldata route,
        bool allowScreened
    ) external nonReentrant returns (uint256 amountOut) {
        if (msg.sender != EXECUTOR) revert NotExecutor(msg.sender);
        if (route.length == 0 || route.length > MAX_HOPS) revert BadRoute();
        if (tokenIn == tokenOut || recipient == address(0) || amountIn == 0) revert BadRoute();
        if (amountIn > uint256(type(int256).max)) revert AmountTooLarge();

        // Every pool and every token the route touches, checked before anything moves.
        PoolRecord[] memory pools = new PoolRecord[](route.length);
        address[] memory path = new address[](route.length + 1);
        path[0] = tokenIn;
        bool toUsdc = tokenOut == USDC;
        for (uint256 i = 0; i < route.length; ++i) {
            PoolRecord memory p = REGISTRY.usablePool(route[i], allowScreened, toUsdc);
            address a = _held(p.token0);
            address b = _held(p.token1);
            if (path[i] == a) path[i + 1] = b;
            else if (path[i] == b) path[i + 1] = a;
            else revert BrokenRoute(i);
            // A route never revisits a token: each hop moves to one not yet on the path.
            for (uint256 j = 0; j <= i; ++j) {
                if (path[j] == path[i + 1]) revert BrokenRoute(i);
            }
            pools[i] = p;
        }
        if (path[route.length] != tokenOut) revert BrokenRoute(route.length);

        // What the adapter held of each token before the route: anything a stranger sent stays put.
        uint256[] memory before = new uint256[](path.length);
        for (uint256 i = 0; i < path.length; ++i) {
            before[i] = IERC20(path[i]).balanceOf(address(this));
        }
        if (before[0] < amountIn) revert InputMissing(before[0], amountIn);
        before[0] -= amountIn;

        uint256 amount = amountIn;
        for (uint256 i = 0; i < pools.length; ++i) {
            amount = pools[i].venue == Venue.UNISWAP_V4
                ? _swapV4(pools[i], path[i], amount)
                : _swapV3(pools[i], path[i], amount);
        }
        if (amount < minAmountOut) revert OutputTooLow(amount, minAmountOut);
        amountOut = amount;
        IERC20(tokenOut).safeTransfer(recipient, amountOut);

        // Input or intermediates a hop did not use go back to the recipient, then nothing may remain.
        for (uint256 i = 0; i < path.length; ++i) {
            uint256 held = IERC20(path[i]).balanceOf(address(this));
            if (held > before[i]) IERC20(path[i]).safeTransfer(recipient, held - before[i]);
            held = IERC20(path[i]).balanceOf(address(this));
            if (held != before[i]) revert FundsLeft(path[i], held);
        }
        emit RouteSwapped(tokenIn, tokenOut, amountIn, amountOut, recipient);
    }

    // ---------------------------------------------------------------------
    // v3 and PancakeSwap v3
    // ---------------------------------------------------------------------

    function _swapV3(PoolRecord memory p, address tokenIn, uint256 amount) internal returns (uint256 out) {
        bool zeroForOne = tokenIn == p.token0;
        _activePool = p.pool;
        _active0 = p.token0;
        _active1 = p.token1;
        (int256 amount0, int256 amount1) = IUniswapV3PoolActions(p.pool)
            .swap(
                address(this),
                zeroForOne,
                // forge-lint: disable-next-line(unsafe-typecast)
                int256(amount),
                zeroForOne ? MIN_SQRT_PRICE_PLUS_ONE : MAX_SQRT_PRICE_MINUS_ONE,
                ""
            );
        _activePool = address(0);
        int256 paid = zeroForOne ? amount1 : amount0;
        // forge-lint: disable-next-line(unsafe-typecast)
        out = paid < 0 ? uint256(-paid) : 0;
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        _payPool(amount0Delta, amount1Delta);
    }

    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        _payPool(amount0Delta, amount1Delta);
    }

    /// Pays the active pool what it is owed; any other caller is refused.
    function _payPool(int256 amount0Delta, int256 amount1Delta) internal {
        if (msg.sender != _activePool || msg.sender == address(0)) revert NotActivePool(msg.sender);
        // forge-lint: disable-next-line(unsafe-typecast)
        if (amount0Delta > 0) IERC20(_active0).safeTransfer(msg.sender, uint256(amount0Delta));
        // forge-lint: disable-next-line(unsafe-typecast)
        if (amount1Delta > 0) IERC20(_active1).safeTransfer(msg.sender, uint256(amount1Delta));
    }

    // ---------------------------------------------------------------------
    // Uniswap v4, hookless
    // ---------------------------------------------------------------------

    function _swapV4(PoolRecord memory p, address tokenIn, uint256 amount) internal returns (uint256 out) {
        // WMON goes in as native MON when the pool holds native MON.
        address currencyIn =
            tokenIn == WMON && (p.token0 == address(0) || p.token1 == address(0)) ? address(0) : tokenIn;
        bool zeroForOne = currencyIn == p.token0;
        if (currencyIn == address(0)) IWMON(WMON).withdraw(amount);
        _inUnlock = true;
        (uint256 spent, uint256 got) = abi.decode(
            POOL_MANAGER.unlock(abi.encode(p.token0, p.token1, p.fee, p.tickSpacing, zeroForOne, amount)),
            (uint256, uint256)
        );
        _inUnlock = false;
        address currencyOut = zeroForOne ? p.token1 : p.token0;
        if (currencyOut == address(0)) IWMON(WMON).deposit{value: got}();
        uint256 unspent = amount - spent;
        if (unspent != 0 && currencyIn == address(0)) IWMON(WMON).deposit{value: unspent}();
        out = got;
    }

    /// PoolManager's callback inside `unlock`: one exact-input swap, settled and taken in full.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER) || !_inUnlock) revert NotPoolManager(msg.sender);
        (address c0, address c1, uint24 fee, int24 tickSpacing, bool zeroForOne, uint256 amount) =
            abi.decode(data, (address, address, uint24, int24, bool, uint256));
        int256 delta = POOL_MANAGER.swap(
            PoolKey({currency0: c0, currency1: c1, fee: fee, tickSpacing: tickSpacing, hooks: address(0)}),
            V4SwapParams({
                zeroForOne: zeroForOne,
                // forge-lint: disable-next-line(unsafe-typecast)
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE_PLUS_ONE : MAX_SQRT_PRICE_MINUS_ONE
            }),
            ""
        );
        int128 amount0 = int128(delta >> 128);
        int128 amount1 = int128(delta);
        (address currencyIn, address currencyOut) = zeroForOne ? (c0, c1) : (c1, c0);
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 spent = uint256(uint128(zeroForOne ? -amount0 : -amount1));
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 got = uint256(uint128(zeroForOne ? amount1 : amount0));
        // PoolManager must count exactly what the hop owes as paid: a token that
        // takes a fee on transfer fails here, by name, before anything is taken.
        uint256 paid;
        if (currencyIn == address(0)) {
            paid = POOL_MANAGER.settle{value: spent}();
        } else {
            POOL_MANAGER.sync(currencyIn);
            IERC20(currencyIn).safeTransfer(address(POOL_MANAGER), spent);
            paid = POOL_MANAGER.settle();
        }
        if (paid != spent) revert SettledShort(paid, spent);
        POOL_MANAGER.take(currencyOut, address(this), got);
        return abi.encode(spent, got);
    }

    /// A pool's native MON side is held as WMON.
    function _held(address currency) internal view returns (address) {
        return currency == address(0) ? WMON : currency;
    }

    /// Native MON only from WMON (unwrapping) and PoolManager (paying out) mid-route.
    receive() external payable {
        if (msg.sender != WMON && (msg.sender != address(POOL_MANAGER) || !_inUnlock)) {
            revert NativeRefused(msg.sender);
        }
    }
}
