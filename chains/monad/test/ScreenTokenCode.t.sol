// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {
    ScreenBlacklistToken,
    ScreenHoneypotToken,
    ScreenPlainToken,
    ScreenTaxToken
} from "./mocks/ScreenTokenMocks.sol";

/// services/orchestrator carries the screen test tokens' creation code to
/// deploy on throwaway forks (F-U1). This fails if that copy differs from what
/// the compiler builds now; `pnpm devenv:screen-tokens` rewrites it.
contract ScreenTokenCodeTest is Test {
    function test_TheOrchestratorCarriesTheBuiltCode() public view {
        string memory file = vm.readFile("../../services/orchestrator/src/tokens/screen-token-code.ts");
        string[] memory parts = vm.split(file, '"');
        assertEq(parts.length, 9, "four quoted strings in screen-token-code.ts");
        assertEq(vm.parseBytes(parts[1]), type(ScreenPlainToken).creationCode, "run pnpm devenv:screen-tokens");
        assertEq(vm.parseBytes(parts[3]), type(ScreenTaxToken).creationCode, "run pnpm devenv:screen-tokens");
        assertEq(vm.parseBytes(parts[5]), type(ScreenHoneypotToken).creationCode, "run pnpm devenv:screen-tokens");
        assertEq(vm.parseBytes(parts[7]), type(ScreenBlacklistToken).creationCode, "run pnpm devenv:screen-tokens");
    }

    /// Each token behaves as its screen test expects.
    function test_TheTokensBehaveAsDescribed() public {
        address buyer = address(0xB0B);
        address pool = address(new ScreenPlainToken(1)); // any contract stands in for a pool

        ScreenTaxToken tax = new ScreenTaxToken(1_000 ether);
        tax.transfer(buyer, 100 ether); // from the deployer: untaxed
        vm.prank(buyer);
        tax.transfer(address(0xCAFE), 100 ether);
        assertEq(tax.balanceOf(address(0xCAFE)), 95 ether);

        ScreenHoneypotToken honey = new ScreenHoneypotToken(1_000 ether);
        honey.transfer(pool, 10 ether); // the deployer may add liquidity
        honey.transfer(buyer, 10 ether);
        vm.prank(buyer);
        honey.transfer(address(0xCAFE), 1 ether); // to a person: fine
        vm.prank(buyer);
        vm.expectRevert("transfers are closed");
        honey.transfer(pool, 1 ether); // back into a contract: never

        ScreenBlacklistToken black = new ScreenBlacklistToken(1_000 ether);
        black.transfer(buyer, 10 ether);
        black.blacklist(buyer);
        vm.prank(buyer);
        vm.expectRevert("blacklisted");
        black.transfer(address(0xCAFE), 1 ether);
        vm.prank(buyer);
        vm.expectRevert("not the owner");
        black.blacklist(address(this));
    }
}
