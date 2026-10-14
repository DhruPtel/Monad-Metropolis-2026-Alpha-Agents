// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// CO-U1: the platform's test USDC on Base Sepolia and Arbitrum Sepolia (6 decimals). The
/// deployer mints the pool's side; anyone takes 100 a day from the faucet to try a deposit.
/// Refuses every mainnet.
contract TestUSDC is ERC20 {
    uint256 public constant FAUCET_AMOUNT = 100e6;
    uint256 public constant FAUCET_EVERY = 1 days;
    address public immutable minter;
    mapping(address => uint256) public lastFaucetAt;

    error WrongChain(uint256 chainId);
    error NotMinter(address caller);
    error FaucetTooSoon(uint256 nextAt);

    constructor(address minter_) ERC20("Test USDC", "tUSDC") {
        if (block.chainid != 84532 && block.chainid != 421614) revert WrongChain(block.chainid);
        minter = minter_;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) revert NotMinter(msg.sender);
        _mint(to, amount);
    }

    /// 100 test USDC to `to`, once a day per address.
    function faucet(address to) external {
        uint256 next = lastFaucetAt[to] + FAUCET_EVERY;
        if (lastFaucetAt[to] != 0 && block.timestamp < next) revert FaucetTooSoon(next);
        lastFaucetAt[to] = block.timestamp;
        _mint(to, FAUCET_AMOUNT);
    }
}
