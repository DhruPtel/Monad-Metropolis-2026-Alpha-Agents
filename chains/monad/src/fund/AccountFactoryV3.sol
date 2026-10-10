// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {PersonalAccountV3} from "./PersonalAccountV3.sol";
import {IAgentNFTView, IDepositLedger} from "../interfaces/ICustody.sol";
import {ICustodyConfigV3} from "../interfaces/ICustodyV3.sol";
import {ITokenRegistry, Lane} from "../interfaces/IFund.sol";

/// @title AccountFactoryV3
/// @notice Deploys PersonalAccountV3 clones and holds what every custody
/// account v3 reads (FINAL_PLAN 0.4, 4.1.13, F-U3): the Executor, oracle,
/// guardian and sentinel references, the beta's depositor allowlist and the
/// per-account and platform-wide deposit caps. The buy list is no longer here:
/// the TokenRegistry (F-U2), given at deployment and immutable, says what may
/// be held and bought, with its own lanes and timelock.
///
/// - The factory can never move account funds: it has no call into an
///   account other than `initialize` at creation.
/// - The oracle and the Executor are given at deployment (D-235), so a new
///   deployment can take deposits and trade at once; the deployment is the
///   commitment, as for the guardian and the sentinel. Every later change to
///   either waits the timelock. F-U3 deploys with the Executor unset, since
///   Executor v3 is F-U4's; that unit deploys the factory again with it.
/// - Tightening is instant (the admin lowers a cap, removes a depositor,
///   turns the allowlist on; the admin or guardian clears the Executor or
///   cancels a pending change). Loosening waits RISK_TIMELOCK in this
///   contract's own code: anyone executes a matured change, nobody can
///   execute it early, and it lapses if left too long.
/// - The one loosening that is instant: the admin adds a depositor to the beta
///   allowlist (Q-46). A new depositor is still bound by both caps, which only
///   the timelock raises, so an addition cannot raise the platform's exposure.
/// - Admin is two-step (Ownable2Step) and cannot be renounced.
contract AccountFactoryV3 is ICustodyConfigV3, IDepositLedger, Ownable2Step {
    /// 9 days: the maximum lockup (7 days) plus notice (2 days) (FINAL_PLAN 4.7.2).
    uint256 public constant RISK_TIMELOCK = 9 days;
    /// A matured change can be executed for this long, then it lapses.
    uint256 public constant EXECUTION_WINDOW = 7 days;

    /// Changes that loosen something, so wait the timelock.
    enum Action {
        SetExecutor,
        SetOracle,
        SetGuardian,
        SetSentinel,
        RaisePersonalCap,
        RaisePlatformCap,
        DisableAllowlist
    }

    struct Pending {
        uint64 executableAt;
        uint64 expiresAt;
    }

    IAgentNFTView public immutable AGENT_NFT;
    address public immutable USDC;
    ITokenRegistry public immutable TOKEN_REGISTRY;
    /// The PersonalAccountV3 every clone runs.
    address public immutable PERSONAL_ACCOUNT_IMPLEMENTATION;

    address public executor;
    address public oracle;
    address public guardian;
    address public sentinel;

    /// Most principal one PersonalAccountV3 may hold, in USDC (6 decimals).
    uint256 public personalCap;
    /// Most principal across every account, in USDC (6 decimals).
    uint256 public platformCap;
    /// Principal across every account, as accounts report it.
    uint256 public platformTotal;

    bool public allowlistEnabled = true;
    mapping(address depositor => bool) public isAllowlisted;

    mapping(uint256 agentId => mapping(address owner => address)) public personalAccountOf;
    mapping(address account => bool) public isAccount;

    mapping(bytes32 id => Pending) public pending;

    event PersonalAccountCreated(uint256 indexed agentId, address indexed owner, address account);
    event DepositRecorded(
        address indexed account, address indexed depositor, uint256 value, uint256 principalAfter, uint256 platformTotal
    );
    event WithdrawalRecorded(address indexed account, uint256 principalReduced, uint256 platformTotal);
    event ChangeProposed(bytes32 indexed id, Action action, bytes32 value, uint64 executableAt, uint64 expiresAt);
    event ChangeExecuted(bytes32 indexed id, Action action, bytes32 value);
    event ChangeCancelled(bytes32 indexed id, address indexed by);
    event ExecutorSet(address indexed previous, address indexed current);
    event OracleSet(address indexed previous, address indexed current);
    event GuardianSet(address indexed previous, address indexed current);
    event SentinelSet(address indexed previous, address indexed current);
    event PersonalCapSet(uint256 previous, uint256 current);
    event PlatformCapSet(uint256 previous, uint256 current);
    event DepositorAllowlistSet(address indexed depositor, bool previous, bool current);
    event AllowlistEnabledSet(bool previous, bool current);

    error ZeroAddress();
    error UsdcNotCore(address usdc);
    error NotAgentOwner(address caller, address agentOwner);
    error AccountExists(address account);
    error NotAnAccount(address caller);
    error NotAllowlisted(address depositor);
    error PersonalCapExceeded(uint256 principalAfter, uint256 cap);
    error PlatformCapExceeded(uint256 totalAfter, uint256 cap);
    error NotAdminOrGuardian(address caller);
    error UseTimelock();
    error AlreadyPending(bytes32 id);
    error NotPending(bytes32 id);
    error TooEarly(uint64 executableAt);
    error Lapsed(uint64 expiresAt);
    error BadValue(bytes32 value);
    error RenounceDisabled();

    struct Deployment {
        address admin;
        address guardian;
        address sentinel;
        address oracle;
        address executor;
        IAgentNFTView agentNft;
        address usdc;
        ITokenRegistry tokenRegistry;
        uint256 personalCap;
        uint256 platformCap;
        address[] allowlist;
    }

    constructor(Deployment memory d) Ownable(d.admin) {
        if (address(d.agentNft) == address(0) || d.usdc == address(0) || address(d.tokenRegistry) == address(0)) {
            revert ZeroAddress();
        }
        // USDC is the unit of account and the first held token: it must be a core token of the registry.
        if (d.tokenRegistry.tokenRecord(d.usdc).lane != Lane.CORE) revert UsdcNotCore(d.usdc);
        AGENT_NFT = d.agentNft;
        USDC = d.usdc;
        TOKEN_REGISTRY = d.tokenRegistry;
        PERSONAL_ACCOUNT_IMPLEMENTATION = address(new PersonalAccountV3(d.agentNft, d.usdc, d.tokenRegistry));
        guardian = d.guardian;
        sentinel = d.sentinel;
        oracle = d.oracle;
        executor = d.executor;
        personalCap = d.personalCap;
        platformCap = d.platformCap;
        for (uint256 i = 0; i < d.allowlist.length; i++) {
            isAllowlisted[d.allowlist[i]] = true;
            emit DepositorAllowlistSet(d.allowlist[i], false, true);
        }
        emit GuardianSet(address(0), d.guardian);
        emit SentinelSet(address(0), d.sentinel);
        emit OracleSet(address(0), d.oracle);
        emit ExecutorSet(address(0), d.executor);
        emit PersonalCapSet(0, d.personalCap);
        emit PlatformCapSet(0, d.platformCap);
    }

    // ---------------------------------------------------------------------
    // Accounts
    // ---------------------------------------------------------------------

    /// Deploys the caller's PersonalAccountV3 for an agent they own. The address
    /// is fixed by `(agentId, owner)`, so the UI can show it beforehand.
    function createPersonalAccount(uint256 agentId) external returns (address account) {
        address agentOwner = AGENT_NFT.ownerOf(agentId);
        if (agentOwner != msg.sender) revert NotAgentOwner(msg.sender, agentOwner);
        address existing = personalAccountOf[agentId][msg.sender];
        if (existing != address(0)) revert AccountExists(existing);
        account = Clones.cloneDeterministic(PERSONAL_ACCOUNT_IMPLEMENTATION, _salt(agentId, msg.sender));
        personalAccountOf[agentId][msg.sender] = account;
        isAccount[account] = true;
        emit PersonalAccountCreated(agentId, msg.sender, account);
        PersonalAccountV3(account).initialize(agentId, msg.sender);
    }

    /// Where `(agentId, owner)`'s PersonalAccountV3 is or will be.
    function predictPersonalAccount(uint256 agentId, address owner_) external view returns (address) {
        return Clones.predictDeterministicAddress(PERSONAL_ACCOUNT_IMPLEMENTATION, _salt(agentId, owner_));
    }

    function _salt(uint256 agentId, address owner_) private pure returns (bytes32) {
        return keccak256(abi.encode(agentId, owner_));
    }

    // ---------------------------------------------------------------------
    // Deposit bookkeeping (accounts only)
    // ---------------------------------------------------------------------

    /// @inheritdoc IDepositLedger
    function recordDeposit(address depositor, uint256 principalAfter, uint256 value) external {
        if (!isAccount[msg.sender]) revert NotAnAccount(msg.sender);
        if (allowlistEnabled && !isAllowlisted[depositor]) revert NotAllowlisted(depositor);
        if (principalAfter > personalCap) revert PersonalCapExceeded(principalAfter, personalCap);
        uint256 totalAfter = platformTotal + value;
        if (totalAfter > platformCap) revert PlatformCapExceeded(totalAfter, platformCap);
        platformTotal = totalAfter;
        emit DepositRecorded(msg.sender, depositor, value, principalAfter, totalAfter);
    }

    /// @inheritdoc IDepositLedger
    function recordWithdrawal(uint256 principalReduced) external {
        if (!isAccount[msg.sender]) revert NotAnAccount(msg.sender);
        uint256 total = platformTotal;
        total = principalReduced < total ? total - principalReduced : 0;
        platformTotal = total;
        emit WithdrawalRecorded(msg.sender, principalReduced, total);
    }

    // ---------------------------------------------------------------------
    // Instant changes: every tightening, and adding a depositor (Q-46)
    // ---------------------------------------------------------------------

    /// Sets the Executor to none: no account can trade until a new one passes
    /// the timelock. The admin or the guardian.
    function clearExecutor() external {
        _checkAdminOrGuardian();
        emit ExecutorSet(executor, address(0));
        executor = address(0);
    }

    /// Cancels a pending change. The admin or the guardian.
    function cancel(bytes32 id) external {
        _checkAdminOrGuardian();
        if (pending[id].executableAt == 0) revert NotPending(id);
        delete pending[id];
        emit ChangeCancelled(id, msg.sender);
    }

    /// Lowers the per-account cap at once; raising it waits the timelock.
    function setPersonalCap(uint256 cap) external onlyOwner {
        if (cap > personalCap) revert UseTimelock();
        emit PersonalCapSet(personalCap, cap);
        personalCap = cap;
    }

    /// Lowers the platform cap at once; raising it waits the timelock.
    function setPlatformCap(uint256 cap) external onlyOwner {
        if (cap > platformCap) revert UseTimelock();
        emit PlatformCapSet(platformCap, cap);
        platformCap = cap;
    }

    /// Puts a wallet on the depositor allowlist at once (Q-46): beta testers
    /// join without waiting the timelock. Both caps still bound what they can
    /// deposit, and raising either cap still waits the timelock.
    function addDepositor(address depositor) external onlyOwner {
        if (depositor == address(0)) revert ZeroAddress();
        emit DepositorAllowlistSet(depositor, isAllowlisted[depositor], true);
        isAllowlisted[depositor] = true;
    }

    /// Takes a wallet off the depositor allowlist; its withdrawals are never gated.
    function removeDepositor(address depositor) external onlyOwner {
        emit DepositorAllowlistSet(depositor, isAllowlisted[depositor], false);
        isAllowlisted[depositor] = false;
    }

    /// Turns the depositor allowlist back on.
    function enableAllowlist() external onlyOwner {
        emit AllowlistEnabledSet(allowlistEnabled, true);
        allowlistEnabled = true;
    }

    // ---------------------------------------------------------------------
    // Timelocked loosening
    // ---------------------------------------------------------------------

    /// The ID of a change: one per action and value.
    function changeId(Action action, bytes32 value) public pure returns (bytes32) {
        return keccak256(abi.encode(action, value));
    }

    /// Proposes a change, executable by anyone after RISK_TIMELOCK and for
    /// EXECUTION_WINDOW after that. `value` is an address or an amount as bytes32.
    function propose(Action action, bytes32 value) external onlyOwner returns (bytes32 id) {
        _validate(action, value);
        id = changeId(action, value);
        Pending memory p = pending[id];
        if (p.executableAt != 0 && block.timestamp <= p.expiresAt) revert AlreadyPending(id);
        uint64 executableAt = uint64(block.timestamp + RISK_TIMELOCK);
        uint64 expiresAt = uint64(block.timestamp + RISK_TIMELOCK + EXECUTION_WINDOW);
        pending[id] = Pending(executableAt, expiresAt);
        emit ChangeProposed(id, action, value, executableAt, expiresAt);
    }

    /// Applies a matured change. Anyone may call it.
    function execute(Action action, bytes32 value) external {
        bytes32 id = changeId(action, value);
        Pending memory p = pending[id];
        if (p.executableAt == 0) revert NotPending(id);
        if (block.timestamp < p.executableAt) revert TooEarly(p.executableAt);
        if (block.timestamp > p.expiresAt) revert Lapsed(p.expiresAt);
        delete pending[id];
        _validate(action, value);
        _apply(action, value);
        emit ChangeExecuted(id, action, value);
    }

    function _validate(Action action, bytes32 value) private pure {
        bool isAmount = action == Action.RaisePersonalCap || action == Action.RaisePlatformCap;
        // One encoding per change: an address fills the low 160 bits only, and
        // turning the allowlist off carries no value.
        if (!isAmount && uint256(value) >> 160 != 0) revert BadValue(value);
        if (action == Action.DisableAllowlist && value != bytes32(0)) revert BadValue(value);
    }

    function _apply(Action action, bytes32 value) private {
        if (action == Action.SetExecutor) {
            emit ExecutorSet(executor, _address(value));
            executor = _address(value);
        } else if (action == Action.SetOracle) {
            emit OracleSet(oracle, _address(value));
            oracle = _address(value);
        } else if (action == Action.SetGuardian) {
            emit GuardianSet(guardian, _address(value));
            guardian = _address(value);
        } else if (action == Action.SetSentinel) {
            emit SentinelSet(sentinel, _address(value));
            sentinel = _address(value);
        } else if (action == Action.RaisePersonalCap) {
            emit PersonalCapSet(personalCap, uint256(value));
            personalCap = uint256(value);
        } else if (action == Action.RaisePlatformCap) {
            emit PlatformCapSet(platformCap, uint256(value));
            platformCap = uint256(value);
        } else {
            emit AllowlistEnabledSet(allowlistEnabled, false);
            allowlistEnabled = false;
        }
    }

    function _address(bytes32 value) private pure returns (address) {
        return address(uint160(uint256(value)));
    }

    function _checkAdminOrGuardian() private view {
        if (msg.sender != owner() && (msg.sender != guardian || guardian == address(0))) {
            revert NotAdminOrGuardian(msg.sender);
        }
    }

    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }
}
