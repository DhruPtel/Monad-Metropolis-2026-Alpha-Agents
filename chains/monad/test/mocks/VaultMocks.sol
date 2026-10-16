// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {StrategyVaultV3} from "../../src/fund/StrategyVaultV3.sol";
import {IAgentNFTView, IDepositLedger} from "../../src/interfaces/ICustody.sol";
import {ICustodyConfigV3} from "../../src/interfaces/ICustodyV3.sol";
import {ITokenRegistry} from "../../src/interfaces/IFund.sol";

/// A stand-in for the vault side of AccountFactoryV3 (P7-U4 builds the real
/// one): deploys StrategyVaultV3 clones for an agent's owner, answers the
/// config reads with what the test sets, and keeps one cap and one allowlist
/// for `recordDeposit`, as the real factory does for personal accounts.
contract VaultHarnessFactory is ICustodyConfigV3, IDepositLedger {
    address public immutable VAULT_IMPLEMENTATION;
    IAgentNFTView public immutable AGENT_NFT;

    address public executor;
    address public oracle;
    address public guardian;
    address public sentinel;
    uint256 public cap = type(uint256).max;
    bool public allowlistEnabled;
    mapping(address => bool) public isAllowlisted;
    mapping(address => bool) public isAccount;
    mapping(uint256 => address) public vaultOf;
    uint256 public platformTotal;
    uint256 public depositsRecorded;
    uint256 public withdrawalsRecorded;

    error NotAgentOwner(address caller, address agentOwner);
    error NotAnAccount(address caller);
    error NotAllowlisted(address depositor);
    error CapExceeded(uint256 principalAfter, uint256 cap);

    constructor(
        IAgentNFTView nft,
        address usdc,
        ITokenRegistry tokens,
        address oracle_,
        address guardian_,
        address sentinel_
    ) {
        VAULT_IMPLEMENTATION = address(new StrategyVaultV3(nft, usdc, tokens, 6_000));
        AGENT_NFT = nft;
        oracle = oracle_;
        guardian = guardian_;
        sentinel = sentinel_;
    }

    function setExecutor(address e) external {
        executor = e;
    }

    function setOracle(address o) external {
        oracle = o;
    }

    function setGuardian(address g) external {
        guardian = g;
    }

    function setCap(uint256 c) external {
        cap = c;
    }

    function setAllowlistEnabled(bool on) external {
        allowlistEnabled = on;
    }

    function allow(address who, bool yes) external {
        isAllowlisted[who] = yes;
    }

    /// Deploys the agent owner's vault for `agentId`, initialized for them.
    function createVault(uint256 agentId) external returns (address vault) {
        address agentOwner = AGENT_NFT.ownerOf(agentId);
        if (agentOwner != msg.sender) revert NotAgentOwner(msg.sender, agentOwner);
        vault = Clones.cloneDeterministic(VAULT_IMPLEMENTATION, keccak256(abi.encode(agentId)));
        isAccount[vault] = true;
        vaultOf[agentId] = vault;
        StrategyVaultV3(vault).initialize(agentId, msg.sender);
    }

    function recordDeposit(address depositor, uint256 principalAfter, uint256 value) external {
        if (!isAccount[msg.sender]) revert NotAnAccount(msg.sender);
        if (allowlistEnabled && !isAllowlisted[depositor]) revert NotAllowlisted(depositor);
        if (principalAfter > cap) revert CapExceeded(principalAfter, cap);
        platformTotal += value;
        depositsRecorded++;
    }

    function recordWithdrawal(uint256 principalReduced) external {
        if (!isAccount[msg.sender]) revert NotAnAccount(msg.sender);
        uint256 total = platformTotal;
        platformTotal = principalReduced < total ? total - principalReduced : 0;
        withdrawalsRecorded++;
    }
}
