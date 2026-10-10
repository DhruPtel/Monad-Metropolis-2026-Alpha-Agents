// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {RiskTimelock} from "../executor/RiskTimelock.sol";
import {IRegistryAccount} from "../interfaces/IFund.sol";

/// @title LaneRegistry
/// @notice What the TokenRegistry and the ProtocolRegistryV3 share (D-342,
/// D-351): the admin's 9-day loosening timelock, and the screener role that
/// adds screened entries at once and, with the guardian and the admin,
/// tightens anything at once. Making an address the screener is itself a
/// loosening change and waits the timelock. Written clean-room.
abstract contract LaneRegistry is RiskTimelock {
    /// The role that adds screened entries and tightens instantly; never loosens.
    address public screener;

    event ScreenerSet(address indexed previous, address indexed current);

    error NotScreener(address caller);
    error NotTightener(address caller);

    constructor(address admin, address guardian_, address screener_) RiskTimelock(admin, guardian_) {
        screener = screener_;
        emit ScreenerSet(address(0), screener_);
    }

    function _setScreener(address next) internal {
        emit ScreenerSet(screener, next);
        screener = next;
    }

    function _checkScreener() internal view {
        if (msg.sender != screener || screener == address(0)) revert NotScreener(msg.sender);
    }

    /// The admin, the guardian or the screener: the roles that may tighten at once.
    function _checkTightener() internal view {
        bool ok = msg.sender == owner() || (msg.sender == guardian && guardian != address(0))
            || (msg.sender == screener && screener != address(0));
        if (!ok) revert NotTightener(msg.sender);
    }

    /// Whether an account may use screened entries: a personal account whose
    /// owner opted in. Anything that does not answer, or answers it is a vault, may not.
    function _optedIn(address account) internal view returns (bool) {
        if (account.code.length == 0) return false;
        try IRegistryAccount(account).isVault() returns (bool vault) {
            if (vault) return false;
        } catch {
            return false;
        }
        try IRegistryAccount(account).screenedOptIn() returns (bool optedIn) {
            return optedIn;
        } catch {
            return false;
        }
    }
}
