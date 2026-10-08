// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PoolKey} from "../src/interfaces/IUniswap.sol";

/// v4's liquidity change: a positive liquidityDelta adds, a negative removes.
struct ModifyLiquidityParams {
    int24 tickLower;
    int24 tickUpper;
    int256 liquidityDelta;
    bytes32 salt;
}

/// The parts of Uniswap v4's PoolManager the seeder uses, written from its
/// published ABI (clean-room). Deltas are BalanceDeltas: amount0 in the upper
/// 128 bits, amount1 in the lower, negative when the caller owes the pool.
interface IPoolManagerLiquidity {
    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24 tick);

    function unlock(bytes calldata data) external returns (bytes memory);

    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes calldata hookData)
        external
        returns (int256 callerDelta, int256 feesAccrued);

    function sync(address currency) external;

    function settle() external payable returns (uint256 paid);

    function take(address currency, address to, uint256 amount) external;
}

/// @title PoolSeeder
/// @notice Monad testnet only (P2-EC, D-257). Creates and seeds the hookless
/// native MON/USDC pool on the unofficial testnet Uniswap v4, so testnet has a
/// venue for the Executor. It settles by transfer (USDC is sent here first by
/// the owner) and by value (native MON), never through Permit2 or an approval.
/// The position belongs to this contract; only the owner can add to it, take
/// it out, or receive what is left. A throwaway script contract, never in src.
contract PoolSeeder {
    using SafeERC20 for IERC20;

    uint256 public constant MONAD_TESTNET_CHAIN_ID = 10143;

    IPoolManagerLiquidity public immutable POOL_MANAGER;
    address public immutable owner;

    bool private _inUnlock;

    error WrongChain(uint256 chainId);
    error NotOwner(address caller);
    error NotPoolManager(address caller);
    error NotNativePool(address currency0);
    error NativeRefused(address from);

    event LiquidityChanged(int256 liquidityDelta, int256 amount0, int256 amount1);

    constructor(IPoolManagerLiquidity poolManager, address owner_) {
        if (block.chainid != MONAD_TESTNET_CHAIN_ID) revert WrongChain(block.chainid);
        POOL_MANAGER = poolManager;
        owner = owner_;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    function initialize(PoolKey calldata key, uint160 sqrtPriceX96) external onlyOwner returns (int24) {
        return POOL_MANAGER.initialize(key, sqrtPriceX96);
    }

    /// Adds `liquidity` in [tickLower, tickUpper]. The native MON comes with
    /// the call; the USDC must already be here. Whatever the pool did not use
    /// goes back to the owner.
    function addLiquidity(PoolKey calldata key, int24 tickLower, int24 tickUpper, uint128 liquidity)
        external
        payable
        onlyOwner
    {
        _modify(key, tickLower, tickUpper, int256(uint256(liquidity)));
        _returnAll(key);
    }

    /// Takes `liquidity` out of [tickLower, tickUpper] and sends both currencies to the owner.
    function removeLiquidity(PoolKey calldata key, int24 tickLower, int24 tickUpper, uint128 liquidity)
        external
        onlyOwner
    {
        _modify(key, tickLower, tickUpper, -int256(uint256(liquidity)));
        _returnAll(key);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER) || !_inUnlock) revert NotPoolManager(msg.sender);
        (PoolKey memory key, ModifyLiquidityParams memory params) = abi.decode(data, (PoolKey, ModifyLiquidityParams));
        (int256 delta,) = POOL_MANAGER.modifyLiquidity(key, params, "");
        int128 amount0 = int128(delta >> 128);
        int128 amount1 = int128(delta);
        _close(key.currency0, amount0);
        _close(key.currency1, amount1);
        emit LiquidityChanged(params.liquidityDelta, amount0, amount1);
        return "";
    }

    /// Pays what this contract owes the pool for one currency, or takes what it is owed.
    function _close(address currency, int128 amount) internal {
        if (amount < 0) {
            uint256 owed = uint256(uint128(-amount));
            if (currency == address(0)) {
                POOL_MANAGER.settle{value: owed}();
            } else {
                POOL_MANAGER.sync(currency);
                IERC20(currency).safeTransfer(address(POOL_MANAGER), owed);
                POOL_MANAGER.settle();
            }
        } else if (amount > 0) {
            POOL_MANAGER.take(currency, address(this), uint256(uint128(amount)));
        }
    }

    function _modify(PoolKey calldata key, int24 tickLower, int24 tickUpper, int256 liquidityDelta) internal {
        if (key.currency0 != address(0)) revert NotNativePool(key.currency0);
        _inUnlock = true;
        POOL_MANAGER.unlock(
            abi.encode(
                key,
                ModifyLiquidityParams({
                    tickLower: tickLower, tickUpper: tickUpper, liquidityDelta: liquidityDelta, salt: bytes32(0)
                })
            )
        );
        _inUnlock = false;
    }

    function _returnAll(PoolKey calldata key) internal {
        uint256 native = address(this).balance;
        if (native != 0) {
            (bool ok,) = owner.call{value: native}("");
            require(ok, "native return failed");
        }
        uint256 token = IERC20(key.currency1).balanceOf(address(this));
        if (token != 0) IERC20(key.currency1).safeTransfer(owner, token);
    }

    /// Native MON only from the owner (with addLiquidity) and PoolManager (taking).
    receive() external payable {
        if (msg.sender != owner && msg.sender != address(POOL_MANAGER)) revert NativeRefused(msg.sender);
    }
}
