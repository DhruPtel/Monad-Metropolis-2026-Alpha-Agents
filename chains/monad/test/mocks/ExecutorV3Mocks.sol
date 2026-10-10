// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

interface IOwnerWithdrawV3 {
    function withdraw(address token, uint256 amount, address to) external;
}

/// A venue adapter as Executor v3 calls it (`swapRoute`, F-U4): its fill is
/// the fair amount at the reference prices the test sets, scaled by `outputBps`
/// or replaced by `fixedOut`, paid from its own stash. The other behaviours are
/// the ways a buggy or compromised venue could misbehave; the Executor must
/// refuse each by what actually arrived in the account.
contract MockRouteAdapter {
    enum Behaviour {
        Honest,
        /// Pays half of what it reports as the output.
        ReportMore,
        PayLess,
        PayNothing,
        PayElsewhere,
        PayTheExecutor,
        PayWrongToken,
        ReenterExecutor,
        WithdrawFromTheAccount,
        RefundHalf
    }

    address public immutable EXECUTOR;
    mapping(address => uint256) public priceE18;
    uint256 public outputBps = 10_000;
    uint256 public fixedOut;
    Behaviour public behaviour;
    bytes public reentry;
    address public wrongToken;
    address public sink = address(0xdead);
    uint256 public calls;
    uint256 public lastReported;

    constructor(address executor) {
        EXECUTOR = executor;
    }

    function setPrice(address token, uint256 p) external {
        priceE18[token] = p;
    }

    function setOutputBps(uint256 b) external {
        outputBps = b;
    }

    function setFixedOut(uint256 o) external {
        fixedOut = o;
    }

    function setWrongToken(address t) external {
        wrongToken = t;
    }

    function setBehaviour(Behaviour b, bytes calldata data) external {
        behaviour = b;
        reentry = data;
    }

    /// The fair output at the reference prices, scaled by `outputBps`, or `fixedOut`.
    function quote(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256) {
        if (fixedOut != 0) return fixedOut;
        uint256 fair = amountIn * priceE18[tokenIn] * (10 ** IERC20Metadata(tokenOut).decimals())
            / (priceE18[tokenOut] * (10 ** IERC20Metadata(tokenIn).decimals()));
        return fair * outputBps / 10_000;
    }

    function swapRoute(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256,
        address recipient,
        bytes32[] calldata,
        bool
    ) external returns (uint256 out) {
        require(msg.sender == EXECUTOR, "not the executor");
        ++calls;
        Behaviour b = behaviour;
        out = quote(tokenIn, tokenOut, amountIn);
        uint256 paid = out;
        if (b == Behaviour.ReenterExecutor) {
            (bool ok, bytes memory ret) = EXECUTOR.call(reentry);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
        if (b == Behaviour.WithdrawFromTheAccount) IOwnerWithdrawV3(recipient).withdraw(tokenIn, 1, address(this));
        if (b == Behaviour.RefundHalf) {
            require(IERC20(tokenIn).transfer(recipient, amountIn / 2), "refund");
            paid = out / 2;
        }
        if (b == Behaviour.ReportMore) paid = out / 2;
        if (b == Behaviour.PayLess) {
            paid = out / 2;
            out = paid;
        }
        if (b == Behaviour.PayNothing) paid = 0;
        address to = b == Behaviour.PayElsewhere ? sink : b == Behaviour.PayTheExecutor ? EXECUTOR : recipient;
        address token = b == Behaviour.PayWrongToken ? wrongToken : tokenOut;
        if (paid != 0) require(IERC20(token).transfer(to, paid), "pay");
        lastReported = out;
    }
}
