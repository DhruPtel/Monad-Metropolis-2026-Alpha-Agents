// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title RiskTimelock
/// @notice The loosening timelock the Executor and the ProtocolRegistry share
/// (FINAL_PLAN 4.7.2, D-229's rules, clean-room): the admin proposes a change,
/// anyone executes it after RISK_TIMELOCK and within EXECUTION_WINDOW, the
/// admin or the guardian cancels it. Tightening is done by each contract's own
/// instant functions. Admin is two-step and cannot be renounced.
abstract contract RiskTimelock is Ownable2Step {
    /// 9 days: the maximum lockup (7 days) plus notice (2 days).
    uint256 public constant RISK_TIMELOCK = 9 days;
    /// A matured change can be executed for this long, then it lapses (A-32).
    uint256 public constant EXECUTION_WINDOW = 7 days;

    struct Pending {
        uint64 executableAt;
        uint64 expiresAt;
    }

    /// The emergency role: tightens and cancels, never loosens.
    address public guardian;
    mapping(bytes32 id => Pending) public pending;

    event ChangeProposed(bytes32 indexed id, uint8 action, bytes data, uint64 executableAt, uint64 expiresAt);
    event ChangeExecuted(bytes32 indexed id, uint8 action, bytes data);
    event ChangeCancelled(bytes32 indexed id, address indexed by);
    event GuardianSet(address indexed previous, address indexed current);

    error NotAdminOrGuardian(address caller);
    error AlreadyPending(bytes32 id);
    error NotPending(bytes32 id);
    error TooEarly(uint64 executableAt);
    error Lapsed(uint64 expiresAt);
    error RenounceDisabled();

    constructor(address admin, address guardian_) Ownable(admin) {
        guardian = guardian_;
        emit GuardianSet(address(0), guardian_);
    }

    /// The ID of a change: one per action and payload.
    function changeId(uint8 action, bytes calldata data) public pure returns (bytes32) {
        return keccak256(abi.encode(action, data));
    }

    /// Proposes a loosening change, executable by anyone after RISK_TIMELOCK.
    function propose(uint8 action, bytes calldata data) external onlyOwner returns (bytes32 id) {
        _validateChange(action, data);
        id = changeId(action, data);
        Pending memory p = pending[id];
        // forge-lint: disable-next-line(block-timestamp)
        if (p.executableAt != 0 && block.timestamp <= p.expiresAt) revert AlreadyPending(id);
        uint64 executableAt = uint64(block.timestamp + RISK_TIMELOCK);
        uint64 expiresAt = uint64(block.timestamp + RISK_TIMELOCK + EXECUTION_WINDOW);
        pending[id] = Pending(executableAt, expiresAt);
        emit ChangeProposed(id, action, data, executableAt, expiresAt);
    }

    /// Applies a matured change. Anyone may call it.
    function execute(uint8 action, bytes calldata data) external {
        bytes32 id = changeId(action, data);
        Pending memory p = pending[id];
        if (p.executableAt == 0) revert NotPending(id);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < p.executableAt) revert TooEarly(p.executableAt);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > p.expiresAt) revert Lapsed(p.expiresAt);
        delete pending[id];
        _validateChange(action, data);
        _applyChange(action, data);
        emit ChangeExecuted(id, action, data);
    }

    /// Cancels a pending change. The admin or the guardian.
    function cancel(bytes32 id) external {
        _checkAdminOrGuardian();
        if (pending[id].executableAt == 0) revert NotPending(id);
        delete pending[id];
        emit ChangeCancelled(id, msg.sender);
    }

    function _setGuardian(address next) internal {
        emit GuardianSet(guardian, next);
        guardian = next;
    }

    function _checkAdminOrGuardian() internal view {
        if (msg.sender != owner() && (msg.sender != guardian || guardian == address(0))) {
            revert NotAdminOrGuardian(msg.sender);
        }
    }

    /// Reverts unless `data` is a valid payload for `action`.
    function _validateChange(uint8 action, bytes calldata data) internal view virtual;

    /// Applies a matured change.
    function _applyChange(uint8 action, bytes calldata data) internal virtual;

    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }
}
