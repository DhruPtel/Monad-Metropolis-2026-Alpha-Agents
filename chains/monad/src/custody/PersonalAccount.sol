// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {CustodyCore} from "./CustodyCore.sol";
import {
    AccountMode,
    SwapParams,
    IAgentNFTView,
    ICustodyConfig,
    IDepositLedger,
    IValuationOracle
} from "../interfaces/ICustody.sol";

/// @title PersonalAccount
/// @notice The custody core in single-owner mode (FINAL_PLAN 4.1.6, D-048):
/// one owner's own trading money for one agent. No shares and no lockup.
///
/// - One clone per `(agentId, owner)`, deployed by AccountFactory, with both
///   fixed at creation. A seller keeps their account and their withdrawal
///   after the agent is sold; trading stops by itself, because it requires
///   the agent's current owner to be this account's owner and the intent's
///   ownership epoch to be the current one.
/// - Deposits are the owner's own, checked against the factory's allowlist
///   and caps, valued in USDC (USDC one for one, WMON through the oracle),
///   and must arrive exactly: a fee-on-transfer token is refused.
/// - Withdrawals are the core's: always on, owner only.
contract PersonalAccount is CustodyCore {
    using SafeERC20 for IERC20;

    /// Gas for telling the factory about a withdrawal: enough for its bookkeeping,
    /// and the withdrawal never depends on the call.
    uint256 internal constant WITHDRAWAL_NOTE_GAS = 50_000;

    IAgentNFTView public immutable AGENT_NFT;

    uint256 public agentId;
    address public owner;
    /// What the owner has put in, in USDC (6 decimals), net of USDC taken out:
    /// what the per-account cap counts. Withdrawing everything sets it to zero.
    uint256 public principal;
    bool private _initialized;

    event Initialized(address indexed factory, uint256 indexed agentId, address indexed owner);
    event Deposited(address indexed token, uint256 amount, uint256 valueUsdc, uint256 principalAfter);
    event PrincipalReduced(uint256 amount, uint256 principalAfter);

    error AlreadyInitialized();
    error DepositsPaused();
    error DepositsAreClosed();
    error NotAgentOwner(address currentOwner);
    error StaleEpoch(uint64 intentEpoch, uint64 currentEpoch);
    error TransferNotExact(address token, uint256 received, uint256 amount);

    /// The implementation: its own storage is never used, so it is locked.
    constructor(IAgentNFTView agentNft, address usdc, address wmon) CustodyCore(usdc, wmon) {
        AGENT_NFT = agentNft;
        _initialized = true;
    }

    /// Called once by the factory in the transaction that deploys the clone.
    function initialize(uint256 agentId_, address owner_) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        config = ICustodyConfig(msg.sender);
        agentId = agentId_;
        owner = owner_;
        emit Initialized(msg.sender, agentId_, owner_);
    }

    // ---------------------------------------------------------------------
    // Deposits
    // ---------------------------------------------------------------------

    /// Pulls `amount` of USDC or WMON from the owner (who approves this
    /// account first). Refused while PAUSED or with deposits closed, once the
    /// owner no longer owns the agent, above either cap, or for a wallet off
    /// the beta allowlist.
    function deposit(address token, uint256 amount) external nonReentrant onlyOwner {
        if (amount == 0) revert ZeroAmount();
        if (!_isHeld(token)) revert NotHeldAsset(token);
        if (mode == AccountMode.PAUSED) revert DepositsPaused();
        if (depositsClosed) revert DepositsAreClosed();
        address agentOwner = AGENT_NFT.ownerOf(agentId);
        if (agentOwner != owner) revert NotAgentOwner(agentOwner);

        uint256 value = token == USDC ? amount : _oracle().valueUsdc(token, amount);
        uint256 principalAfter = principal + value;
        principal = principalAfter;
        IDepositLedger(address(config)).recordDeposit(owner, principalAfter, value);

        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        if (received != amount) revert TransferNotExact(token, received, amount);
        emit Deposited(token, amount, value, principalAfter);
    }

    // ---------------------------------------------------------------------
    // Core hooks
    // ---------------------------------------------------------------------

    function _isOwner(address who) internal view override returns (bool) {
        return who == owner;
    }

    /// Trading needs the agent still to belong to this account's owner and the
    /// intent's epoch to be current: a sale stops it in the same transaction.
    function _checkTrading(SwapParams calldata p) internal view override {
        address agentOwner = AGENT_NFT.ownerOf(agentId);
        if (agentOwner != owner) revert NotAgentOwner(agentOwner);
        uint64 epoch = AGENT_NFT.ownerEpoch(agentId);
        if (p.ownershipEpoch != epoch) revert StaleEpoch(p.ownershipEpoch, epoch);
    }

    /// Lowers the principal by USDC taken out (WMON has no oracle-free value,
    /// so it lowers nothing, which only errs towards the cap), or to zero once
    /// the account is empty, then tells the factory without depending on it.
    function _afterWithdraw(address token, uint256 amount) internal override {
        uint256 p = principal;
        if (p == 0) return;
        uint256 reduce = token == USDC ? (amount < p ? amount : p) : 0;
        if (IERC20(USDC).balanceOf(address(this)) == 0 && IERC20(WMON).balanceOf(address(this)) == 0) {
            reduce = p;
        }
        if (reduce == 0) return;
        principal = p - reduce;
        emit PrincipalReduced(reduce, p - reduce);
        _noteWithdrawal(reduce);
    }

    /// A call with bounded gas whose result and return data are ignored: a
    /// factory that reverts, burns gas or returns a huge payload cannot stop
    /// the withdrawal.
    function _noteWithdrawal(uint256 reduced) private {
        bytes memory data = abi.encodeCall(IDepositLedger.recordWithdrawal, (reduced));
        address target = address(config);
        uint256 gasLimit = WITHDRAWAL_NOTE_GAS;
        assembly ("memory-safe") {
            pop(call(gasLimit, target, 0, add(data, 0x20), mload(data), 0, 0))
        }
    }

    function _oracle() private view returns (IValuationOracle oracle) {
        oracle = IValuationOracle(config.oracle());
        if (address(oracle) == address(0)) revert OracleUnset();
    }
}
