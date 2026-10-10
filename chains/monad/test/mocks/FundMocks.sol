// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IAttestationVerifier, IRegistryAccount} from "../../src/interfaces/IFund.sol";
import {IUnlockCallback, PoolKey, V4SwapParams} from "../../src/interfaces/IUniswap.sol";
import {IV3SwapCallbacks} from "../../src/interfaces/IUniswapV3.sol";

/// Test doubles for the fund agent's v3 set (F-U2). Each behaves like the
/// real venue in the ways the adapter relies on, and can misbehave in the ways
/// a hostile or broken venue could.

contract MockWMON is ERC20 {
    constructor() ERC20("Wrapped MON", "WMON") {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "native send failed");
    }

    receive() external payable {
        _mint(msg.sender, msg.value);
    }
}

contract MockV3Factory {
    mapping(bytes32 => address) internal _pools;

    function setPool(address a, address b, uint24 fee, address pool) external {
        (address t0, address t1) = a < b ? (a, b) : (b, a);
        _pools[keccak256(abi.encode(t0, t1, fee))] = pool;
    }

    function getPool(address a, address b, uint24 fee) external view returns (address) {
        (address t0, address t1) = a < b ? (a, b) : (b, a);
        return _pools[keccak256(abi.encode(t0, t1, fee))];
    }
}

/// A v3 pool at a fixed price: `out = in * num / den` (token0 to token1;
/// the inverse the other way). It pays the output first, then calls back the
/// swapper, then checks it was paid, as a real pool does.
contract MockV3Pool {
    enum Mode {
        Honest,
        /// Consumes only half the input (a price limit or thin liquidity).
        HalfFill,
        /// Calls back under the PancakeSwap name.
        Pancake
    }

    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    uint256 public num = 1;
    uint256 public den = 1;
    uint160 public sqrt;
    Mode public mode;

    constructor(address t0, address t1, uint24 fee_, int24 tickSpacing_) {
        token0 = t0;
        token1 = t1;
        fee = fee_;
        tickSpacing = tickSpacing_;
    }

    function setPrice(uint256 num_, uint256 den_, uint160 sqrt_) external {
        num = num_;
        den = den_;
        sqrt = sqrt_;
    }

    function setMode(Mode m) external {
        mode = m;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint32, bool) {
        return (sqrt, 0, 0, 0, 0, 0, true);
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        virtual
        returns (int256 amount0, int256 amount1)
    {
        require(amountSpecified > 0, "exact input only");
        uint256 inAmt = uint256(amountSpecified);
        if (mode == Mode.HalfFill) inAmt /= 2;
        uint256 out = zeroForOne ? inAmt * num / den : inAmt * den / num;
        (address tin, address tout) = zeroForOne ? (token0, token1) : (token1, token0);
        uint256 before = IERC20(tin).balanceOf(address(this));
        IERC20(tout).transfer(recipient, out);
        (amount0, amount1) = zeroForOne ? (int256(inAmt), -int256(out)) : (-int256(out), int256(inAmt));
        if (mode == Mode.Pancake) IV3SwapCallbacks(msg.sender).pancakeV3SwapCallback(amount0, amount1, data);
        else IV3SwapCallbacks(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
        require(IERC20(tin).balanceOf(address(this)) >= before + inAmt, "IIA");
    }
}

/// Uniswap v4's PoolManager for hookless pools at fixed prices, with real
/// delta accounting: every currency's delta must be settled before `unlock`
/// returns, or it reverts, as the real one does.
contract MockPoolManager {
    mapping(bytes32 poolId => uint256) public num;
    mapping(bytes32 poolId => uint256) public den;
    mapping(address currency => int256) public credit;
    address[] internal _touched;
    bool internal _unlocked;
    address internal _synced;
    uint256 internal _syncedBalance;

    function setPrice(PoolKey memory key, uint256 num_, uint256 den_) external {
        bytes32 id = keccak256(abi.encode(key));
        num[id] = num_;
        den[id] = den_;
    }

    function unlock(bytes calldata data) external returns (bytes memory result) {
        require(!_unlocked, "already unlocked");
        _unlocked = true;
        result = IUnlockCallback(msg.sender).unlockCallback(data);
        for (uint256 i = 0; i < _touched.length; ++i) {
            require(credit[_touched[i]] == 0, "currency not settled");
        }
        delete _touched;
        _unlocked = false;
    }

    function swap(PoolKey memory key, V4SwapParams memory params, bytes calldata) external returns (int256 delta) {
        require(_unlocked, "locked");
        require(key.hooks == address(0), "hooked");
        bytes32 id = keccak256(abi.encode(key));
        require(num[id] != 0, "no pool");
        uint256 inAmt = uint256(-params.amountSpecified);
        uint256 out = params.zeroForOne ? inAmt * num[id] / den[id] : inAmt * den[id] / num[id];
        (address cin, address cout) =
            params.zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        _move(cin, -int256(inAmt));
        _move(cout, int256(out));
        int128 a0 = params.zeroForOne ? -int128(int256(inAmt)) : int128(int256(out));
        int128 a1 = params.zeroForOne ? int128(int256(out)) : -int128(int256(inAmt));
        delta = (int256(a0) << 128) | int256(uint256(uint128(a1)));
    }

    function sync(address currency) external {
        _synced = currency;
        _syncedBalance = IERC20(currency).balanceOf(address(this));
    }

    function settle() external payable returns (uint256 paid) {
        if (msg.value > 0) {
            paid = msg.value;
            _move(address(0), int256(paid));
        } else {
            paid = IERC20(_synced).balanceOf(address(this)) - _syncedBalance;
            _move(_synced, int256(paid));
            _synced = address(0);
        }
    }

    function take(address currency, address to, uint256 amount) external {
        _move(currency, -int256(amount));
        if (currency == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            require(ok, "native take failed");
        } else {
            IERC20(currency).transfer(to, amount);
        }
    }

    function _move(address c, int256 d) internal {
        if (credit[c] == 0) _touched.push(c);
        credit[c] += d;
    }

    receive() external payable {}
}

/// A StateView that answers one settable price for any pool, and zero for "uninitialized".
contract MockStateViewAny {
    mapping(bytes32 => uint160) public sqrtOf;

    function setSqrt(bytes32 poolId, uint160 s) external {
        sqrtOf[poolId] = s;
    }

    function getSlot0(bytes32 poolId) external view returns (uint160, int24, uint24, uint24) {
        return (sqrtOf[poolId], 0, 0, 0);
    }
}

/// An account as the registries ask it (D-351).
contract MockFundAccount is IRegistryAccount {
    bool public screenedOptIn;
    bool public isVault;

    function set(bool optIn, bool vault) external {
        screenedOptIn = optIn;
        isVault = vault;
    }
}

/// An account whose answers revert.
contract RevertingAccount {
    function screenedOptIn() external pure returns (bool) {
        revert("no");
    }

    function isVault() external pure returns (bool) {
        revert("no");
    }
}

contract MockVerifier is IAttestationVerifier {
    address public token;
    uint256 public priceE18;
    uint64 public validUntil;

    function set(address token_, uint256 priceE18_, uint64 validUntil_) external {
        token = token_;
        priceE18 = priceE18_;
        validUntil = validUntil_;
    }

    function verify(bytes calldata) external view returns (address, uint256, uint64) {
        return (token, priceE18, validUntil);
    }
}
