// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {CustodyCoreV3} from "../../src/fund/CustodyCoreV3.sol";
import {ISwapExecutorV3, SwapParamsV3} from "../../src/interfaces/ICustodyV3.sol";
import {IAttestationVerifier} from "../../src/interfaces/IFund.sol";
import {MockToken} from "./CustodyMocks.sol";

/// Test doubles for the custody core v3 (F-U3).

/// An attestation verifier that answers a settable price per token: the
/// attestation bytes name the token (`abi.encode(token)`), as F-U12's real
/// verifier will recover it from the signed data.
contract MockAttestor is IAttestationVerifier {
    struct Price {
        uint256 priceE18;
        uint64 validUntil;
    }

    mapping(address => Price) public prices;

    function set(address token, uint256 priceE18, uint64 validUntil) external {
        prices[token] = Price(priceE18, validUntil);
    }

    function verify(bytes calldata attestation) external view returns (address, uint256, uint64) {
        address token = abi.decode(attestation, (address));
        Price memory p = prices[token];
        return (token, p.priceE18, p.validUntil);
    }
}

/// An Executor v3 whose behaviour inside `onSwap` the test chooses, from honest
/// to every way a buggy or compromised Executor could misbehave. It pays the
/// output from its own stash at the prices the test sets.
contract MockExecutorV3 is ISwapExecutorV3 {
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
        ReenterWithdraw,
        BurnOtherToken
    }

    Behaviour public behaviour;
    /// Output as a fraction of the fair amount, in bps (10,000 = fair).
    uint256 public outputBps = 10_000;
    /// The reference prices the honest quote uses (USDC per whole token, 1e18).
    mapping(address => uint256) public priceE18;
    /// The held token `BurnOtherToken` takes from the account.
    address public otherToken;

    function setBehaviour(Behaviour b) external {
        behaviour = b;
    }

    function setOutputBps(uint256 bps) external {
        outputBps = bps;
    }

    function setPrice(address token, uint256 p) external {
        priceE18[token] = p;
    }

    function setOtherToken(address t) external {
        otherToken = t;
    }

    function swap(CustodyCoreV3 account, SwapParamsV3 calldata p) external {
        account.executeSwap(p);
    }

    /// The fair output for `amountIn` at the reference prices, scaled by outputBps.
    function quote(SwapParamsV3 calldata p) public view returns (uint256) {
        uint256 decIn = IERC20Metadata(p.tokenIn).decimals();
        uint256 decOut = IERC20Metadata(p.tokenOut).decimals();
        uint256 fair = p.amountIn * priceE18[p.tokenIn] * (10 ** decOut) / (priceE18[p.tokenOut] * (10 ** decIn));
        return fair * outputBps / 10_000;
    }

    function onSwap(SwapParamsV3 calldata p) external {
        CustodyCoreV3 account = CustodyCoreV3(msg.sender);
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
        if (b == Behaviour.BurnOtherToken) MockToken(otherToken).burn(address(account), 1);
        uint256 out = quote(p);
        if (b == Behaviour.PayNothing) return;
        if (b == Behaviour.PayLess) out = out / 2;
        if (b == Behaviour.PayWrongToken) {
            IERC20(p.tokenIn).transfer(address(account), p.amountIn);
            return;
        }
        IERC20(p.tokenOut).transfer(address(account), out);
    }
}

/// A token whose `balanceOf` reverts once armed: what must never stop another token's withdrawal.
contract BalanceRevertingToken is MockToken {
    bool public armed;

    constructor() MockToken("BALREV", 18) {}

    function arm(bool a) external {
        armed = a;
    }

    function balanceOf(address who) public view override returns (uint256) {
        require(!armed, "balance down");
        return super.balanceOf(who);
    }
}

/// A token whose transfer burns every unit of gas it is given once armed.
contract GasBurningToken is MockToken {
    bool public armed;

    constructor() MockToken("BURN", 18) {}

    function arm(bool a) external {
        armed = a;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (armed) {
            while (true) {}
        }
        return super.transfer(to, amount);
    }
}

/// A token whose transfer answers with a huge payload (a return bomb) once
/// armed, and whose `balanceOf` does the same when armed separately.
contract ReturnBombToken is MockToken {
    bool public transferArmed;
    bool public balanceArmed;

    constructor() MockToken("BOMB", 18) {}

    function armTransfer(bool a) external {
        transferArmed = a;
    }

    function armBalance(bool a) external {
        balanceArmed = a;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (transferArmed) {
            assembly {
                return(0, 1000000)
            }
        }
        return super.transfer(to, amount);
    }

    function balanceOf(address who) public view override returns (uint256) {
        if (balanceArmed) {
            assembly {
                return(0, 1000000)
            }
        }
        return super.balanceOf(who);
    }
}
