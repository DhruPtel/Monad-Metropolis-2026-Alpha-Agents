// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IVenueAdapter} from "../interfaces/IExecutor.sol";
import {RiskTimelock} from "./RiskTimelock.sol";

/// @title ProtocolRegistry
/// @notice The deny-by-default list of venue adapters the Executor may trade
/// through (FINAL_PLAN 4.1.8, D-238), written clean-room.
///
/// - Each adapter is recorded with its own code hash and its venue's code
///   hash; a mismatch on either fails closed, so a swapped adapter or an
///   upgraded venue cannot trade until reviewed.
/// - Statuses: ACTIVE trades both ways; EXIT_ONLY only sells into USDC;
///   PAUSED trades nothing. Registering an adapter or making one ACTIVE waits
///   the 9-day timelock; pausing or setting exit-only is instant for the
///   admin or the guardian.
/// - The deployment's adapters and their statuses are given to the
///   constructor (the deployment is the commitment, as in D-235).
contract ProtocolRegistry is RiskTimelock {
    enum Status {
        NONE,
        ACTIVE,
        PAUSED,
        EXIT_ONLY
    }

    struct Entry {
        address adapter;
        Status status;
        bytes32 adapterCodeHash;
        bytes32 venueCodeHash;
    }

    /// Timelocked actions.
    uint8 public constant REGISTER = 1;
    uint8 public constant ACTIVATE = 2;
    uint8 public constant SET_GUARDIAN = 3;

    /// USDC: the only output an EXIT_ONLY adapter may produce.
    address public immutable USDC;

    mapping(bytes32 adapterId => Entry) internal _entries;
    bytes32[] public adapterIds;

    event AdapterRegistered(
        bytes32 indexed adapterId,
        address indexed adapter,
        Status status,
        bytes32 adapterCodeHash,
        bytes32 venueCodeHash
    );
    event StatusSet(bytes32 indexed adapterId, Status previous, Status current, address indexed by);

    error ZeroAddress();
    error UnknownAdapter(bytes32 adapterId);
    error AlreadyRegistered(bytes32 adapterId);
    error BadStatus(Status status);
    error BadPayload();

    constructor(
        address admin,
        address guardian_,
        address usdc,
        bytes32[] memory ids,
        address[] memory adapters,
        Status[] memory statuses
    ) RiskTimelock(admin, guardian_) {
        if (usdc == address(0)) revert ZeroAddress();
        if (ids.length != adapters.length || ids.length != statuses.length) revert BadPayload();
        USDC = usdc;
        for (uint256 i = 0; i < ids.length; ++i) {
            _register(ids[i], adapters[i], statuses[i]);
        }
    }

    // ---------------------------------------------------------------------
    // The Executor's question
    // ---------------------------------------------------------------------

    /// The adapter to trade `tokenIn` for `tokenOut` through, or zero when the
    /// adapter is unknown, paused, exit-only for a buy, does not trade the
    /// pair, or its code or its venue's code has changed since registration.
    function adapterFor(bytes32 adapterId, address tokenIn, address tokenOut) external view returns (address) {
        Entry memory e = _entries[adapterId];
        if (e.status == Status.ACTIVE || (e.status == Status.EXIT_ONLY && tokenOut == USDC)) {
            if (e.adapter.codehash != e.adapterCodeHash) return address(0);
            if (IVenueAdapter(e.adapter).venue().codehash != e.venueCodeHash) return address(0);
            if (!IVenueAdapter(e.adapter).tradesPair(tokenIn, tokenOut)) return address(0);
            return e.adapter;
        }
        return address(0);
    }

    function entry(bytes32 adapterId) external view returns (Entry memory) {
        return _entries[adapterId];
    }

    function adapterCount() external view returns (uint256) {
        return adapterIds.length;
    }

    // ---------------------------------------------------------------------
    // Instant tightening: the admin or the guardian
    // ---------------------------------------------------------------------

    function pause(bytes32 adapterId) external {
        _checkAdminOrGuardian();
        _setStatus(adapterId, Status.PAUSED);
    }

    /// Only sales into USDC; never loosens a PAUSED adapter.
    function setExitOnly(bytes32 adapterId) external {
        _checkAdminOrGuardian();
        if (_entries[adapterId].status == Status.PAUSED) revert BadStatus(Status.PAUSED);
        _setStatus(adapterId, Status.EXIT_ONLY);
    }

    // ---------------------------------------------------------------------
    // Timelocked loosening
    // ---------------------------------------------------------------------

    function _validateChange(uint8 action, bytes calldata data) internal view override {
        if (action == REGISTER) {
            (bytes32 id, address adapter, Status status) = abi.decode(data, (bytes32, address, Status));
            if (_entries[id].status != Status.NONE) revert AlreadyRegistered(id);
            if (adapter == address(0) || status == Status.NONE) revert BadPayload();
        } else if (action == ACTIVATE) {
            bytes32 id = abi.decode(data, (bytes32));
            if (_entries[id].status == Status.NONE) revert UnknownAdapter(id);
        } else if (action == SET_GUARDIAN) {
            abi.decode(data, (address));
        } else {
            revert BadPayload();
        }
    }

    function _applyChange(uint8 action, bytes calldata data) internal override {
        if (action == REGISTER) {
            (bytes32 id, address adapter, Status status) = abi.decode(data, (bytes32, address, Status));
            _register(id, adapter, status);
        } else if (action == ACTIVATE) {
            _setStatus(abi.decode(data, (bytes32)), Status.ACTIVE);
        } else {
            _setGuardian(abi.decode(data, (address)));
        }
    }

    function _register(bytes32 id, address adapter, Status status) internal {
        if (adapter == address(0)) revert ZeroAddress();
        if (status == Status.NONE) revert BadStatus(status);
        if (_entries[id].status != Status.NONE) revert AlreadyRegistered(id);
        bytes32 venueHash = IVenueAdapter(adapter).venue().codehash;
        _entries[id] = Entry(adapter, status, adapter.codehash, venueHash);
        adapterIds.push(id);
        emit AdapterRegistered(id, adapter, status, adapter.codehash, venueHash);
    }

    function _setStatus(bytes32 id, Status next) internal {
        Entry storage e = _entries[id];
        if (e.status == Status.NONE) revert UnknownAdapter(id);
        emit StatusSet(id, e.status, next, msg.sender);
        e.status = next;
    }
}
