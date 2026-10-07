// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IVenueAdapter} from "../interfaces/IExecutor.sol";
import {IPoolManager, IUnlockCallback, IWMON, PoolKey, V4SwapParams} from "../interfaces/IUniswap.sol";

/// @title UniswapV4MonUsdcAdapter
/// @notice The launch venue (D-166): the hookless Uniswap v4 MON/USDC 0.05%
/// pool, pinned in the constructor. Accounts hold WMON, never native MON
/// (D-167), so selling WMON unwraps it and buying it rewraps the native MON
/// the pool pays, inside the one call the Executor makes.
///
/// - Only the Executor may call `swap`, after transferring exactly `amountIn`.
/// - No approval is ever given: v4 settles by transfer (USDC) or value
///   (native MON). USDC output is taken by PoolManager straight to the
///   account; MON output is taken here, wrapped and sent to the account. Any
///   input the pool did not use goes back to the account.
/// - No other entry point moves funds: no sweep, multicall or arbitrary call,
///   and native MON is accepted only from WMON and PoolManager mid-swap.
contract UniswapV4MonUsdcAdapter is IVenueAdapter, IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// v4's price limits (TickMath MIN_SQRT_PRICE + 1 and MAX_SQRT_PRICE - 1): no limit.
    uint160 internal constant MIN_SQRT_PRICE_PLUS_ONE = 4_295_128_740;
    uint160 internal constant MAX_SQRT_PRICE_MINUS_ONE =
        1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341;
    uint24 public constant FEE = 500;
    int24 public constant TICK_SPACING = 10;

    IPoolManager public immutable POOL_MANAGER;
    address public immutable USDC;
    address public immutable WMON;
    address public immutable EXECUTOR;
    bytes32 public immutable POOL_ID;

    bool private _inSwap;

    error NotExecutor(address caller);
    error NotPoolManager(address caller);
    error UnsupportedPair(address tokenIn, address tokenOut);
    error WrongPool(bytes32 poolId);
    error NativeRefused(address from);
    error OutputTooLow(uint256 out, uint256 minAmountOut);

    constructor(IPoolManager poolManager, address usdc, address wmon, address executor, bytes32 expectedPoolId) {
        POOL_MANAGER = poolManager;
        USDC = usdc;
        WMON = wmon;
        EXECUTOR = executor;
        bytes32 id = keccak256(abi.encode(_key(usdc)));
        if (id != expectedPoolId) revert WrongPool(id);
        POOL_ID = id;
    }

    function venue() external view returns (address) {
        return address(POOL_MANAGER);
    }

    /// 0.05%.
    function feeBps() external pure returns (uint256) {
        return 5;
    }

    function tradesPair(address tokenIn, address tokenOut) public view returns (bool) {
        return (tokenIn == WMON && tokenOut == USDC) || (tokenIn == USDC && tokenOut == WMON);
    }

    /// @inheritdoc IVenueAdapter
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, address recipient)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        if (msg.sender != EXECUTOR) revert NotExecutor(msg.sender);
        if (!tradesPair(tokenIn, tokenOut)) revert UnsupportedPair(tokenIn, tokenOut);
        bool monIn = tokenIn == WMON;
        if (monIn) IWMON(WMON).withdraw(amountIn);

        _inSwap = true;
        (uint256 spent, uint256 out) =
            abi.decode(POOL_MANAGER.unlock(abi.encode(monIn, amountIn, recipient)), (uint256, uint256));
        _inSwap = false;

        if (!monIn) {
            // Native MON arrived here: wrap it for the account.
            IWMON(WMON).deposit{value: out}();
            IERC20(WMON).safeTransfer(recipient, out);
        }
        // Input the pool did not use goes back to the account, as the token it came in.
        uint256 unspent = amountIn - spent;
        if (unspent != 0) {
            if (monIn) IWMON(WMON).deposit{value: unspent}();
            IERC20(tokenIn).safeTransfer(recipient, unspent);
        }
        if (out < minAmountOut) revert OutputTooLow(out, minAmountOut);
        return out;
    }

    /// PoolManager's callback inside `unlock`: one exact-input swap, settled
    /// and taken in full.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER) || !_inSwap) revert NotPoolManager(msg.sender);
        (bool monIn, uint256 amountIn, address recipient) = abi.decode(data, (bool, uint256, address));
        int256 delta = POOL_MANAGER.swap(
            _key(USDC),
            V4SwapParams({
                zeroForOne: monIn,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: monIn ? MIN_SQRT_PRICE_PLUS_ONE : MAX_SQRT_PRICE_MINUS_ONE
            }),
            ""
        );
        int128 amount0 = int128(delta >> 128);
        int128 amount1 = int128(delta);
        uint256 spent;
        uint256 out;
        if (monIn) {
            spent = uint256(uint128(-amount0));
            out = uint256(uint128(amount1));
            POOL_MANAGER.settle{value: spent}();
            // USDC goes straight to the account.
            POOL_MANAGER.take(USDC, recipient, out);
        } else {
            spent = uint256(uint128(-amount1));
            out = uint256(uint128(amount0));
            POOL_MANAGER.sync(USDC);
            IERC20(USDC).safeTransfer(address(POOL_MANAGER), spent);
            POOL_MANAGER.settle();
            POOL_MANAGER.take(address(0), address(this), out);
        }
        return abi.encode(spent, out);
    }

    function _key(address usdc) internal pure returns (PoolKey memory) {
        return PoolKey({currency0: address(0), currency1: usdc, fee: FEE, tickSpacing: TICK_SPACING, hooks: address(0)});
    }

    /// Native MON only from WMON (unwrapping) and PoolManager (paying out) during a swap.
    receive() external payable {
        if (msg.sender != WMON && msg.sender != address(POOL_MANAGER)) revert NativeRefused(msg.sender);
    }
}
