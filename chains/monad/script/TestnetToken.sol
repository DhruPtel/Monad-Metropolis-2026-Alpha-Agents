// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestnetToken
/// @notice Monad testnet only (F-U13). A plain ERC-20 whose whole supply is
/// minted to the deployer, so the v3 set on testnet has class F tokens beyond
/// USDC and WMON to list, price through a TestnetFeed and trade through a
/// seeded pool. No owner, no mint after construction, no pause: nothing a
/// screen would refuse. The constructor refuses any chain but 10143, so this
/// never reaches mainnet or the fork.
contract TestnetToken is ERC20 {
    uint256 public constant MONAD_TESTNET_CHAIN_ID = 10143;

    uint8 private immutable _decimals;

    error WrongChain(uint256 chainId);

    constructor(string memory name_, string memory symbol_, uint8 decimals_, uint256 supply, address to) ERC20(name_, symbol_) {
        if (block.chainid != MONAD_TESTNET_CHAIN_ID) revert WrongChain(block.chainid);
        _decimals = decimals_;
        _mint(to, supply);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }
}
