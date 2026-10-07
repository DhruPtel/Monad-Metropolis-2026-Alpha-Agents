// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CustodyCore} from "../../src/custody/CustodyCore.sol";
import {IAgentNFTView, ISwapExecutor, IValuationOracle, SwapParams} from "../../src/interfaces/ICustody.sol";

/// A plain ERC-20 with open minting, and a switch that makes every transfer
/// revert, as a USDC pause or blacklist does.
contract MockToken is ERC20 {
    uint8 private immutable _decimals;
    mapping(address => bool) public blocked;
    bool public paused;

    constructor(string memory name, uint8 decimals_) ERC20(name, name) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address who, bool b) external {
        blocked[who] = b;
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function _update(address from, address to, uint256 value) internal virtual override {
        require(!paused, "paused");
        require(!blocked[from] && !blocked[to], "blacklisted");
        super._update(from, to, value);
    }
}

/// Takes 1% of every transfer: what the exact-receipt check must refuse.
contract FeeOnTransferToken is MockToken {
    constructor() MockToken("FOT", 6) {}

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0xFEE), fee);
            value -= fee;
        }
        super._update(from, to, value);
    }
}

/// A token that, once armed, calls a hook during its next transfer, the way
/// a token with receiver hooks would. With the owner's wallet as the hook,
/// the account sees its own owner calling back in mid-withdrawal.
contract ReentrantToken is MockToken {
    OwnerWallet public hook;
    address public target;
    bytes public payload;
    bool public armed;
    bool public lastCallSucceeded;
    bytes public lastRevert;

    constructor() MockToken("REENTER", 6) {}

    function arm(OwnerWallet hook_, address target_, bytes calldata payload_) external {
        hook = hook_;
        target = target_;
        payload = payload_;
        armed = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed) {
            armed = false;
            (lastCallSucceeded, lastRevert) = hook.forward(target, payload);
        }
    }
}

/// An owner that is a contract: it can call anything, and is the hook the
/// reentrant token calls back.
contract OwnerWallet {
    function forward(address target, bytes calldata data) external returns (bool ok, bytes memory ret) {
        (ok, ret) = target.call(data);
    }

    function exec(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }
}

/// AgentNFT as the custody contracts read it, with ownership the test sets:
/// every change of owner bumps the epoch, as AgentNFT's transfers do.
contract MockAgentNFT is IAgentNFTView {
    mapping(uint256 => address) internal _owner;
    mapping(uint256 => uint64) internal _epoch;

    function setOwner(uint256 agentId, address owner) external {
        if (_owner[agentId] != address(0)) _epoch[agentId] += 1;
        _owner[agentId] = owner;
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        address o = _owner[agentId];
        require(o != address(0), "no agent");
        return o;
    }

    function ownerEpoch(uint256 agentId) external view returns (uint64) {
        return _epoch[agentId];
    }
}

/// Prices in USDC per whole token, 6 decimals; reverts while stale.
contract MockOracle is IValuationOracle {
    mapping(address => uint256) public priceE6;
    mapping(address => uint8) public decimalsOf;
    bool public stale;

    function set(address token, uint8 decimals_, uint256 priceE6_) external {
        decimalsOf[token] = decimals_;
        priceE6[token] = priceE6_;
    }

    function setStale(bool s) external {
        stale = s;
    }

    function valueUsdc(address token, uint256 amount) external view returns (uint256) {
        require(!stale, "stale price");
        require(priceE6[token] != 0, "no feed");
        return amount * priceE6[token] / (10 ** decimalsOf[token]);
    }
}

/// An Executor whose behaviour inside `onSwap` the test chooses, from honest
/// to every way a buggy or compromised Executor could misbehave.
contract MockExecutor is ISwapExecutor {
    enum Behaviour {
        Honest,
        PayLess,
        PayNothing,
        PullTwice,
        PullMore,
        PullOtherToken,
        PayWrongToken,
        KeepAndPayFromElsewhere,
        ReenterExecute,
        ReenterWithdraw
    }

    MockOracle public immutable ORACLE;
    Behaviour public behaviour;
    /// Output as a fraction of the oracle-fair amount, in bps (10,000 = fair).
    uint256 public outputBps = 10_000;
    bytes public lastRevert;

    constructor(MockOracle oracle) {
        ORACLE = oracle;
    }

    function setBehaviour(Behaviour b) external {
        behaviour = b;
    }

    function setOutputBps(uint256 bps) external {
        outputBps = bps;
    }

    function swap(CustodyCore account, SwapParams calldata p) external {
        account.executeSwap(p);
    }

    /// The oracle-fair output for `amountIn`, scaled by outputBps.
    function quote(SwapParams calldata p) public view returns (uint256) {
        uint256 value = ORACLE.valueUsdc(p.tokenIn, p.amountIn);
        uint256 unit = 10 ** ORACLE.decimalsOf(p.tokenOut);
        return value * unit / ORACLE.priceE6(p.tokenOut) * outputBps / 10_000;
    }

    function onSwap(SwapParams calldata p) external {
        CustodyCore account = CustodyCore(msg.sender);
        Behaviour b = behaviour;
        if (b == Behaviour.PullOtherToken) {
            account.pullForSwap(p.tokenOut, p.amountIn);
            return;
        }
        if (b == Behaviour.PullMore) {
            account.pullForSwap(p.tokenIn, p.amountIn + 1);
            return;
        }
        if (b != Behaviour.KeepAndPayFromElsewhere) account.pullForSwap(p.tokenIn, p.amountIn);
        if (b == Behaviour.PullTwice) account.pullForSwap(p.tokenIn, p.amountIn);
        if (b == Behaviour.ReenterExecute) account.executeSwap(p);
        if (b == Behaviour.ReenterWithdraw) account.withdraw(p.tokenIn, 1, address(this));
        uint256 out = quote(p);
        if (b == Behaviour.PayNothing) return;
        if (b == Behaviour.PayLess) out = out / 2;
        if (b == Behaviour.PayWrongToken) {
            MockToken(p.tokenIn).mint(address(account), p.amountIn);
            return;
        }
        MockToken(p.tokenOut).mint(address(account), out);
    }
}

/// A stand-in for a factory that a withdrawal must not depend on: every call reverts.
contract RevertingLedger {
    fallback() external {
        revert("ledger down");
    }
}

/// Burns all the gas it is given.
contract GasBurner {
    fallback() external {
        while (true) {}
    }
}
