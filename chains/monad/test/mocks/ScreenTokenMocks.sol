// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Tokens for F-U1's token screen tests. Each is deployed only on a throwaway
/// fork, paired with USDC in a real Uniswap v3 pool, and screened through the
/// real route. The deployer adds the liquidity, so each mints its supply to the
/// deployer and treats it as the liquidity provider.

/// A plain token: no owner, no tax, no trap. The screen should pass its
/// simulation and contract checks.
contract ScreenPlainToken is ERC20 {
    constructor(uint256 supply) ERC20("Screen Plain", "SPLAIN") {
        _mint(msg.sender, supply);
    }
}

/// Takes 5% of every transfer that neither starts nor ends at the deployer,
/// and sends it to the dead address. The rate is fixed: there is no owner.
contract ScreenTaxToken is ERC20 {
    address public immutable provider;

    constructor(uint256 supply) ERC20("Screen Tax", "STAX") {
        provider = msg.sender;
        _mint(msg.sender, supply);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0) || from == provider || to == provider) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = value / 20;
        super._update(from, address(0xdead), fee);
        super._update(from, to, value - fee);
    }
}

/// Buys and plain transfers work; a transfer to any contract other than from
/// the deployer reverts, so the token can never be sold back into its pool.
contract ScreenHoneypotToken is ERC20 {
    address public immutable provider;

    constructor(uint256 supply) ERC20("Screen Honeypot", "SHONEY") {
        provider = msg.sender;
        _mint(msg.sender, supply);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && from != provider && to.code.length > 0) revert("transfers are closed");
        super._update(from, to, value);
    }
}

/// A live owner who can blacklist any holder. Trading works until the owner
/// uses the power.
contract ScreenBlacklistToken is ERC20 {
    address public owner;
    mapping(address => bool) public isBlacklisted;

    constructor(uint256 supply) ERC20("Screen Blacklist", "SBLACK") {
        owner = msg.sender;
        _mint(msg.sender, supply);
    }

    function blacklist(address holder) external {
        require(msg.sender == owner, "not the owner");
        isBlacklisted[holder] = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!isBlacklisted[from] && !isBlacklisted[to], "blacklisted");
        super._update(from, to, value);
    }
}
