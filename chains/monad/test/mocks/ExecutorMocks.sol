// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IVenueAdapter, SwapIntent} from "../../src/interfaces/IExecutor.sol";
import {MockToken} from "./CustodyMocks.sol";

interface IExecutorEntry {
    function swap(SwapIntent calldata i) external returns (uint256);
}

interface IOwnerWithdraw {
    function withdraw(address token, uint256 amount, address to) external;
}

/// A venue adapter whose output the test sets: by default the oracle-fair
/// amount at `priceE18` (USDC per whole WMON, 1e18 scale), scaled by
/// `outputBps`, or an exact `fixedOut`. It burns the input it receives and
/// mints the output, so funds appear only where it pays them. The other
/// behaviours are the ways a buggy or compromised venue could misbehave.
contract MockVenue is IVenueAdapter {
    enum Behaviour {
        Honest,
        PayElsewhere,
        PayTheExecutor,
        PayLess,
        LeaveAllowance,
        ReenterExecutor,
        WithdrawFromTheAccount,
        RefundHalf
    }

    address public immutable EXECUTOR;
    MockToken public immutable USDC;
    MockToken public immutable WMON;
    uint256 public priceE18;
    uint256 public outputBps = 10_000;
    uint256 public fixedOut;
    uint256 public fee;
    Behaviour public behaviour;
    bytes public reentry;
    address public sink = address(0xdead);

    constructor(address executor, MockToken usdc, MockToken wmon, uint256 priceE18_) {
        EXECUTOR = executor;
        USDC = usdc;
        WMON = wmon;
        priceE18 = priceE18_;
    }

    function setPrice(uint256 p) external {
        priceE18 = p;
    }

    function setOutputBps(uint256 b) external {
        outputBps = b;
    }

    function setFixedOut(uint256 o) external {
        fixedOut = o;
    }

    function setFeeBps(uint256 f) external {
        fee = f;
    }

    function setBehaviour(Behaviour b, bytes calldata reentry_) external {
        behaviour = b;
        reentry = reentry_;
    }

    function venue() external view returns (address) {
        return address(this);
    }

    function feeBps() external view returns (uint256) {
        return fee;
    }

    function tradesPair(address tokenIn, address tokenOut) external view returns (bool) {
        return (tokenIn == address(WMON) && tokenOut == address(USDC))
            || (tokenIn == address(USDC) && tokenOut == address(WMON));
    }

    /// The oracle-fair output for `amountIn`, scaled by outputBps.
    function quote(address tokenIn, uint256 amountIn) public view returns (uint256) {
        if (fixedOut != 0) return fixedOut;
        uint256 fair = tokenIn == address(USDC) ? amountIn * 1e30 / priceE18 : amountIn * priceE18 / 1e30;
        return fair * outputBps / 10_000;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256, address recipient)
        external
        returns (uint256 out)
    {
        require(msg.sender == EXECUTOR, "not the executor");
        Behaviour b = behaviour;
        out = quote(tokenIn, amountIn);
        if (b == Behaviour.ReenterExecutor) {
            (bool ok, bytes memory ret) = EXECUTOR.call(reentry);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
        if (b == Behaviour.WithdrawFromTheAccount) IOwnerWithdraw(recipient).withdraw(tokenIn, 1, address(this));
        if (b == Behaviour.LeaveAllowance) IERC20(tokenIn).approve(address(this), 1);
        uint256 burn = amountIn;
        if (b == Behaviour.RefundHalf) {
            require(IERC20(tokenIn).transfer(recipient, amountIn / 2));
            burn = amountIn - amountIn / 2;
        }
        MockToken(tokenIn).burn(address(this), burn);
        if (b == Behaviour.PayLess) out = out / 2;
        address to = b == Behaviour.PayElsewhere ? sink : b == Behaviour.PayTheExecutor ? EXECUTOR : recipient;
        MockToken(tokenOut).mint(to, out);
    }
}
