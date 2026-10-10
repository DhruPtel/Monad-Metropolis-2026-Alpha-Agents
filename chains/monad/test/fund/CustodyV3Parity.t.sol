// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {AccountFactoryV3} from "../../src/fund/AccountFactoryV3.sol";
import {CustodyCoreV3} from "../../src/fund/CustodyCoreV3.sol";
import {PersonalAccountV3} from "../../src/fund/PersonalAccountV3.sol";
import {SwapParamsV3} from "../../src/interfaces/ICustodyV3.sol";
import {MockToken} from "../mocks/CustodyMocks.sol";
import {CustodyV3Base} from "./CustodyV3Base.sol";

/// The custody core's parity fixture (F-U3, D-343): packages/policy's custody
/// model wrote down what it answers after each step of each sequence; this
/// test replays the same steps on the real PersonalAccountV3 and makes it
/// answer the same: the outcome of every call, units, principal, mode, NAV,
/// the capped value, every token's amount and cost basis, and what a poke
/// records. packages/policy's fund test fails if the fixture is not what its
/// code builds now, so a change to either side alone fails one of them.
contract CustodyV3ParityTest is CustodyV3Base {
    string internal constant PATH = "../../packages/policy/fixtures/fund-parity.json";

    struct Step {
        string op;
        string token;
        string tokenOut;
        uint256 amount;
        uint256 outputBps;
        uint256 priceE18;
        uint256 answer;
        uint256 warp;
        bool flag;
        bool ok;
        string failure;
        uint256 units;
        uint256 principal;
        uint256 mode;
        uint256 nav;
        uint256 capped;
        uint256 totalBasis;
        uint256 classABasis;
        uint256[] amounts;
        uint256[] bases;
        uint256 heldCount;
        uint256 perUnit;
        uint256 pokePeak;
    }

    string internal constant STEP_TYPE =
        "Step(string op,string token,string tokenOut,uint256 amount,uint256 outputBps,uint256 priceE18,uint256 answer,uint256 warp,bool flag,bool ok,string failure,uint256 units,uint256 principal,uint256 mode,uint256 nav,uint256 capped,uint256 totalBasis,uint256 classABasis,uint256[] amounts,uint256[] bases,uint256 heldCount,uint256 perUnit,uint256 pokePeak)";

    string internal json;
    /// The fixture's tokens, in its order: USDC, WMON, A, B, C, D, E, F.
    address[8] internal fixtureTokens;

    function setUp() public override {
        super.setUp();
        json = vm.readFile(PATH);
        fixtureTokens = [
            address(usdc),
            address(wmon),
            address(tokA),
            address(tokB),
            address(tokC),
            address(tokD),
            address(tokE),
            address(tokF)
        ];
    }

    function test_TheFixtureUsesTheContractsConstants() public view {
        assertEq(vm.parseJsonUint(json, ".custodyLimits.maxTradeBps"), account.MAX_TRADE_BPS());
        assertEq(vm.parseJsonUint(json, ".custodyLimits.maxAssetBps"), account.MAX_ASSET_BPS());
        assertEq(vm.parseJsonUint(json, ".custodyLimits.maxClassAPositionBps"), account.MAX_CLASS_A_POSITION_BPS());
        assertEq(vm.parseJsonUint(json, ".custodyLimits.maxClassATotalBps"), account.MAX_CLASS_A_TOTAL_BPS());
        assertEq(vm.parseJsonUint(json, ".custodyLimits.maxSlippageBps"), account.MAX_SLIPPAGE_BPS());
        assertEq(vm.parseJsonUint(json, ".custodyLimits.maxDepegBps"), account.MAX_DEPEG_BPS());
        assertEq(vm.parseJsonUint(json, ".custodyLimits.maxHeldTokens"), account.MAX_HELD_TOKENS());
        assertEq(vm.parseJsonUint(json, ".custodyLimits.attestedPriceTtlSeconds"), account.ATTESTED_PRICE_TTL());
        assertEq(vm.parseJsonUint(json, ".custodyLimits.maxDecimals"), account.MAX_DECIMALS());
        assertEq(vm.parseJsonUint(json, ".custodyLimits.breakerReduceOnlyBps"), account.BREAKER_REDUCE_ONLY_BPS());
        assertEq(vm.parseJsonUint(json, ".custodyLimits.breakerPauseBps"), account.BREAKER_PAUSE_BPS());
        assertEq(vm.parseJsonUint(json, ".custodyLimits.peakDays"), account.PEAK_DAYS());
        string[] memory names = vm.parseJsonStringArray(json, ".custodyLimits.tokens");
        assertEq(names.length, 8);
        assertEq(names[0], "USDC");
        assertEq(names[7], "F");
    }

    /// Replays every sequence on a fresh account from the fixture's start time.
    function test_TheCustodyCoreMatchesThePolicyPackage() public {
        uint256 count = vm.parseJsonUint(json, ".custodyCaseCount");
        vm.warp(vm.parseJsonUint(json, ".custodyLimits.t0"));
        refreshFeeds();
        setExecutor();
        uint256 start = vm.snapshotState();
        for (uint256 i = 0; i < count; ++i) {
            string memory key = string.concat(".custodyCases[", vm.toString(i), "]");
            string memory name = vm.parseJsonString(json, string.concat(key, ".name"));
            Step[] memory steps =
                abi.decode(vm.parseJsonTypeArray(json, string.concat(key, ".steps"), STEP_TYPE), (Step[]));
            assertEq(steps.length, vm.parseJsonUint(json, string.concat(key, ".stepCount")));
            for (uint256 j = 0; j < steps.length; ++j) {
                string memory label = string.concat(name, " step ", vm.toString(j), " (", steps[j].op, ")");
                _apply(steps[j], label);
                _check(steps[j], label);
            }
            vm.revertToState(start);
        }
    }

    function _is(string memory a, string memory b) private pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    function _token(string memory n) private view returns (address) {
        bytes32 k = keccak256(bytes(n));
        if (k == keccak256("USDC")) return fixtureTokens[0];
        if (k == keccak256("WMON")) return fixtureTokens[1];
        if (k == keccak256("A")) return fixtureTokens[2];
        if (k == keccak256("B")) return fixtureTokens[3];
        if (k == keccak256("C")) return fixtureTokens[4];
        if (k == keccak256("D")) return fixtureTokens[5];
        if (k == keccak256("E")) return fixtureTokens[6];
        if (k == keccak256("F")) return fixtureTokens[7];
        revert(string.concat("unknown token ", n));
    }

    function _apply(Step memory s, string memory label) private {
        if (_is(s.op, "deposit")) {
            address t = _token(s.token);
            if (t == address(wmon)) _wmonTo(owner, s.amount);
            else MockToken(t).mint(owner, s.amount);
            vm.startPrank(owner);
            MockToken(t).approve(address(account), s.amount);
            _call(abi.encodeCall(PersonalAccountV3.deposit, (t, s.amount)), s, label);
            vm.stopPrank();
        } else if (_is(s.op, "withdraw")) {
            vm.prank(owner);
            account.withdraw(_token(s.token), s.amount, owner);
        } else if (_is(s.op, "swap")) {
            executor.setOutputBps(s.outputBps);
            SwapParamsV3 memory p = attest(params(_token(s.token), _token(s.tokenOut), s.amount));
            vm.prank(address(executor));
            _call(abi.encodeCall(CustodyCoreV3.executeSwap, (p)), s, label);
            executor.setOutputBps(10_000);
        } else if (_is(s.op, "attest")) {
            executor.setPrice(_token(s.token), s.priceE18);
        } else if (_is(s.op, "price")) {
            if (_is(s.token, "A")) {
                aUsd.push(int256(s.answer));
                executor.setPrice(address(tokA), s.answer * 1e10);
            } else {
                monUsd.push(int256(s.answer));
                executor.setPrice(address(wmon), s.answer * 1e10);
                executor.setPrice(address(tokB), 20 * s.answer * 1e10);
            }
        } else if (_is(s.op, "warp")) {
            vm.warp(block.timestamp + s.warp);
            // Fresh rounds at the same answers: class F stays priced, class A ages.
            monUsd.push(monUsd.answer());
            usdcUsd.push(usdcUsd.answer());
            aUsd.push(aUsd.answer());
            bRate.push(bRate.answer());
        } else if (_is(s.op, "poke")) {
            uint256 nav;
            uint256 p;
            uint256 peak;
            if (bytes(s.token).length == 0) {
                (nav, p, peak) = account.poke();
            } else {
                address t = _token(s.token);
                address[] memory ts = one(t);
                bytes[] memory atts = new bytes[](1);
                atts[0] = attestation(t, executor.priceE18(t));
                (nav, p, peak) = account.poke(ts, atts);
            }
            assertEq(nav, s.nav, string.concat(label, ": poke nav"));
            assertEq(p, s.perUnit, string.concat(label, ": poke per unit"));
            assertEq(peak, s.pokePeak, string.concat(label, ": poke peak"));
        } else if (_is(s.op, "optIn")) {
            vm.prank(owner);
            account.setScreenedOptIn(s.flag);
        } else if (_is(s.op, "unpause")) {
            vm.prank(owner);
            account.unpause();
        } else {
            revert(string.concat("unknown op ", s.op));
        }
    }

    /// A call the model may have refused: its outcome, and the refusal's name, must match.
    function _call(bytes memory data, Step memory s, string memory label) private {
        (bool ok, bytes memory ret) = address(account).call(data);
        assertEq(ok, s.ok, string.concat(label, ": outcome"));
        if (!ok) assertEq(bytes4(ret), _selector(s.failure), string.concat(label, ": refusal ", s.failure));
    }

    function _selector(string memory failure) private pure returns (bytes4) {
        bytes32 k = keccak256(bytes(failure));
        if (k == keccak256("NotBuyable")) return CustodyCoreV3.NotBuyable.selector;
        if (k == keccak256("ReduceOnly")) return CustodyCoreV3.ReduceOnly.selector;
        if (k == keccak256("TradeTooLarge")) return CustodyCoreV3.TradeTooLarge.selector;
        if (k == keccak256("OutputTooLow")) return CustodyCoreV3.OutputTooLow.selector;
        if (k == keccak256("SlippageTooHigh")) return CustodyCoreV3.SlippageTooHigh.selector;
        if (k == keccak256("ConcentrationTooHigh")) return CustodyCoreV3.ConcentrationTooHigh.selector;
        if (k == keccak256("ClassAPositionTooLarge")) return CustodyCoreV3.ClassAPositionTooLarge.selector;
        if (k == keccak256("ClassATooLarge")) return CustodyCoreV3.ClassATooLarge.selector;
        if (k == keccak256("AccountValueZero")) return PersonalAccountV3.AccountValueZero.selector;
        if (k == keccak256("DepositsPaused")) return PersonalAccountV3.DepositsPaused.selector;
        if (k == keccak256("PersonalCapExceeded")) return AccountFactoryV3.PersonalCapExceeded.selector;
        if (k == keccak256("InsufficientFree")) return CustodyCoreV3.InsufficientFree.selector;
        revert(string.concat("unknown failure ", failure));
    }

    function _check(Step memory s, string memory label) private view {
        assertEq(account.units(), s.units, string.concat(label, ": units"));
        assertEq(account.principal(), s.principal, string.concat(label, ": principal"));
        assertEq(uint256(account.mode()), s.mode, string.concat(label, ": mode"));
        assertEq(account.navUsdc(), s.nav, string.concat(label, ": nav"));
        (uint256 capped, uint256 totalBasis, uint256 classABasis) = account.capValues();
        assertEq(capped, s.capped, string.concat(label, ": capped"));
        assertEq(totalBasis, s.totalBasis, string.concat(label, ": total basis"));
        assertEq(classABasis, s.classABasis, string.concat(label, ": class A basis"));
        assertEq(account.heldCount(), s.heldCount, string.concat(label, ": held count"));
        for (uint256 i = 0; i < 8; ++i) {
            assertEq(
                MockToken(fixtureTokens[i]).balanceOf(address(account)),
                s.amounts[i],
                string.concat(label, ": amount ", vm.toString(i))
            );
            assertEq(account.costBasis(fixtureTokens[i]), s.bases[i], string.concat(label, ": basis ", vm.toString(i)));
        }
    }
}
