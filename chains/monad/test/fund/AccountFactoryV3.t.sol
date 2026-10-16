// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AccountFactoryV3} from "../../src/fund/AccountFactoryV3.sol";
import {PersonalAccountV3} from "../../src/fund/PersonalAccountV3.sol";
import {StrategyVaultV3} from "../../src/fund/StrategyVaultV3.sol";
import {IAgentNFTView} from "../../src/interfaces/ICustody.sol";
import {ITokenRegistry} from "../../src/interfaces/IFund.sol";
import {CustodyV3Base} from "./CustodyV3Base.sol";

/// AccountFactoryV3: caps, allowlist, roles, the registry binding and the
/// in-contract timelock (F-U3). The buy list is the TokenRegistry's now. The
/// vault's side (P7-U4): the per-vault cap, the public-deposit launch flag and
/// the allowlist on vault deposits, with exits never gated by any of them.
contract AccountFactoryV3Test is CustodyV3Base {
    bytes32 internal constant NONE = bytes32(0);

    function addr(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    // ----- deployment state -----

    function test_StartsWithTheBetaConfiguration() public view {
        assertEq(factory.owner(), admin);
        assertEq(factory.guardian(), guardian);
        assertEq(factory.sentinel(), sentinel);
        assertEq(factory.executor(), address(0), "F-U3 deploys with no Executor; F-U4 brings it");
        assertEq(factory.oracle(), address(oracle), "given at deployment (D-235)");
        assertEq(address(factory.TOKEN_REGISTRY()), address(tokens));
        assertEq(factory.USDC(), address(usdc));
        assertEq(address(factory.AGENT_NFT()), address(nft));
        assertEq(factory.personalCap(), PERSONAL_CAP);
        assertEq(factory.vaultCap(), VAULT_CAP);
        assertEq(factory.platformCap(), PLATFORM_CAP);
        assertTrue(factory.allowlistEnabled());
        assertFalse(factory.depositsEnabled(), "public vault deposits wait the launch decision (Q-29)");
        assertGt(factory.VAULT_IMPLEMENTATION().code.length, 0);
        assertTrue(factory.isAllowlisted(owner));
        assertFalse(factory.isAllowlisted(stranger));
        assertEq(factory.RISK_TIMELOCK(), 9 days);
        PersonalAccountV3 impl = PersonalAccountV3(factory.PERSONAL_ACCOUNT_IMPLEMENTATION());
        assertEq(address(impl.TOKENS()), address(tokens));
        assertEq(impl.USDC(), address(usdc));
        assertEq(address(impl.AGENT_NFT()), address(nft));
    }

    // ----- the timelock -----

    function test_AChangeWaitsTheFullTimelock_ThenAnyoneExecutesIt() public {
        vm.prank(admin);
        bytes32 id = factory.propose(AccountFactoryV3.Action.SetExecutor, addr(address(executor)));
        (uint64 executableAt, uint64 expiresAt) = factory.pending(id);
        assertEq(executableAt, block.timestamp + 9 days);
        assertEq(expiresAt, block.timestamp + 16 days);

        vm.warp(executableAt - 1);
        vm.expectRevert(abi.encodeWithSelector(AccountFactoryV3.TooEarly.selector, executableAt));
        factory.execute(AccountFactoryV3.Action.SetExecutor, addr(address(executor)));
        assertEq(factory.executor(), address(0));

        vm.warp(executableAt);
        vm.prank(stranger);
        factory.execute(AccountFactoryV3.Action.SetExecutor, addr(address(executor)));
        assertEq(factory.executor(), address(executor));
        vm.expectRevert(abi.encodeWithSelector(AccountFactoryV3.NotPending.selector, id));
        factory.execute(AccountFactoryV3.Action.SetExecutor, addr(address(executor)));
    }

    function test_EveryTimelockedActionWaits() public {
        bytes32[9] memory values = [
            addr(address(executor)),
            addr(makeAddr("new oracle")),
            addr(makeAddr("new guardian")),
            addr(makeAddr("new sentinel")),
            bytes32(uint256(5_000e6)),
            bytes32(uint256(50_000e6)),
            NONE,
            bytes32(uint256(7_000e6)),
            NONE
        ];
        for (uint256 i = 0; i < 9; i++) {
            AccountFactoryV3.Action action = AccountFactoryV3.Action(i);
            vm.prank(admin);
            bytes32 id = factory.propose(action, values[i]);
            (uint64 executableAt,) = factory.pending(id);
            vm.expectRevert(abi.encodeWithSelector(AccountFactoryV3.TooEarly.selector, executableAt));
            factory.execute(action, values[i]);
        }
        vm.warp(block.timestamp + 9 days);
        for (uint256 i = 0; i < 9; i++) {
            factory.execute(AccountFactoryV3.Action(i), values[i]);
        }
        assertEq(factory.executor(), address(executor));
        assertEq(factory.oracle(), makeAddr("new oracle"));
        assertEq(factory.guardian(), makeAddr("new guardian"));
        assertEq(factory.sentinel(), makeAddr("new sentinel"));
        assertEq(factory.personalCap(), 5_000e6);
        assertEq(factory.platformCap(), 50_000e6);
        assertFalse(factory.allowlistEnabled());
        assertEq(factory.vaultCap(), 7_000e6);
        assertTrue(factory.depositsEnabled());
    }

    function test_AMaturedChangeLapses_AndCanBeProposedAgain() public {
        vm.prank(admin);
        bytes32 id = factory.propose(AccountFactoryV3.Action.SetOracle, addr(address(oracle)));
        (, uint64 expiresAt) = factory.pending(id);
        vm.warp(expiresAt + 1);
        vm.expectRevert(abi.encodeWithSelector(AccountFactoryV3.Lapsed.selector, expiresAt));
        factory.execute(AccountFactoryV3.Action.SetOracle, addr(address(oracle)));
        vm.prank(admin);
        factory.propose(AccountFactoryV3.Action.SetOracle, addr(address(oracle)));
    }

    function test_OnlyTheAdminProposes_AndNotTwice() public {
        address[3] memory others = [stranger, guardian, sentinel];
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(others[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, others[i]));
            factory.propose(AccountFactoryV3.Action.SetExecutor, addr(others[i]));
        }
        vm.startPrank(admin);
        bytes32 id = factory.propose(AccountFactoryV3.Action.SetExecutor, addr(address(executor)));
        vm.expectRevert(abi.encodeWithSelector(AccountFactoryV3.AlreadyPending.selector, id));
        factory.propose(AccountFactoryV3.Action.SetExecutor, addr(address(executor)));
        vm.stopPrank();
    }

    function test_TheAdminOrGuardianCancels_NobodyElse() public {
        vm.prank(admin);
        bytes32 id = factory.propose(AccountFactoryV3.Action.SetExecutor, addr(address(executor)));
        vm.prank(sentinel);
        vm.expectRevert(abi.encodeWithSelector(AccountFactoryV3.NotAdminOrGuardian.selector, sentinel));
        factory.cancel(id);
        vm.prank(guardian);
        factory.cancel(id);
        vm.warp(block.timestamp + 9 days);
        vm.expectRevert(abi.encodeWithSelector(AccountFactoryV3.NotPending.selector, id));
        factory.execute(AccountFactoryV3.Action.SetExecutor, addr(address(executor)));
    }

    function test_ProposalsTakeOneEncodingPerValue() public {
        vm.startPrank(admin);
        bytes32 dirty = bytes32(uint256(1) << 200 | uint256(uint160(address(executor))));
        vm.expectRevert(abi.encodeWithSelector(AccountFactoryV3.BadValue.selector, dirty));
        factory.propose(AccountFactoryV3.Action.SetExecutor, dirty);
        vm.expectRevert(abi.encodeWithSelector(AccountFactoryV3.BadValue.selector, bytes32(uint256(1))));
        factory.propose(AccountFactoryV3.Action.DisableAllowlist, bytes32(uint256(1)));
        vm.expectRevert(abi.encodeWithSelector(AccountFactoryV3.BadValue.selector, bytes32(uint256(1))));
        factory.propose(AccountFactoryV3.Action.EnableDeposits, bytes32(uint256(1)));
        vm.stopPrank();
    }

    // ----- instant tightening -----

    function test_CapsLowerAtOnce_AndRaiseOnlyByTimelock() public {
        vm.startPrank(admin);
        factory.setPersonalCap(50e6);
        factory.setPlatformCap(1_000e6);
        vm.expectRevert(AccountFactoryV3.UseTimelock.selector);
        factory.setPersonalCap(50e6 + 1);
        vm.expectRevert(AccountFactoryV3.UseTimelock.selector);
        factory.setPlatformCap(1_000e6 + 1);
        vm.stopPrank();
        assertEq(factory.personalCap(), 50e6);
        timelocked(AccountFactoryV3.Action.RaisePersonalCap, bytes32(uint256(80e6)));
        assertEq(factory.personalCap(), 80e6);
    }

    function test_OnlyTheAdminLowersCaps() public {
        vm.startPrank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        factory.setPersonalCap(0);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        factory.setVaultCap(0);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        factory.disableDeposits();
        vm.stopPrank();
    }

    function test_TheVaultCapLowersAtOnce_AndRaisesOnlyByTimelock() public {
        vm.startPrank(admin);
        factory.setVaultCap(VAULT_CAP - 1);
        vm.expectRevert(AccountFactoryV3.UseTimelock.selector);
        factory.setVaultCap(VAULT_CAP);
        vm.stopPrank();
        assertEq(factory.vaultCap(), VAULT_CAP - 1);
        timelocked(AccountFactoryV3.Action.RaiseVaultCap, bytes32(uint256(VAULT_CAP + 1)));
        assertEq(factory.vaultCap(), VAULT_CAP + 1);
    }

    // ----- vaults (P7-U4): the vault cap, the launch flag, the allowlist, ungated exits -----

    /// The agent's vault with the leader's stake in and deposits open.
    function newVault(uint256 stake) internal returns (StrategyVaultV3 v) {
        vm.prank(owner);
        v = StrategyVaultV3(factory.createVault(AGENT));
        usdc.mint(owner, stake);
        vm.startPrank(owner);
        usdc.approve(address(v), stake);
        v.deposit(stake, 0);
        v.setDepositsOpen(true);
        vm.stopPrank();
    }

    function vaultDeposit(StrategyVaultV3 v, address who, uint256 amount) internal returns (uint256 shares) {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(v), amount);
        shares = v.deposit(amount, 0);
        vm.stopPrank();
    }

    function test_AVaultIsBoundByTheVaultCap_NotThePersonalCap() public {
        StrategyVaultV3 v = newVault(1_000e6);
        assertTrue(factory.isVault(address(v)));
        assertTrue(factory.isAccount(address(v)));
        assertFalse(factory.isVault(address(account)));
        assertEq(factory.platformTotal(), 1_000e6, "the leader's stake is principal");
        address tester = makeAddr("tester");
        vm.prank(admin);
        factory.addDepositor(tester);
        // Over the vault cap by one: refused with the vault's own error; at the cap: taken.
        usdc.mint(tester, VAULT_CAP);
        vm.startPrank(tester);
        usdc.approve(address(v), VAULT_CAP);
        vm.expectRevert(abi.encodeWithSelector(AccountFactoryV3.VaultCapExceeded.selector, VAULT_CAP + 1, VAULT_CAP));
        v.deposit(VAULT_CAP - 1_000e6 + 1, 0);
        v.deposit(VAULT_CAP - 1_000e6, 0);
        vm.stopPrank();
        assertEq(v.principal(), VAULT_CAP);
        assertGt(VAULT_CAP, PERSONAL_CAP, "the vault holds more than one personal account may");
        // The owner's personal account still has its whole personal cap: the vault's principal is not its own.
        deposit(usdc, PERSONAL_CAP);
        assertEq(account.principal(), PERSONAL_CAP);
        assertEq(factory.platformTotal(), VAULT_CAP + PERSONAL_CAP, "the platform total counts both");
    }

    function test_TheAllowlistGatesVaultDeposits_AndNeverExits() public {
        StrategyVaultV3 v = newVault(100e6);
        address tester = makeAddr("tester");
        address other = makeAddr("other");
        usdc.mint(stranger, 10e6);
        vm.startPrank(stranger);
        usdc.approve(address(v), 10e6);
        vm.expectRevert(abi.encodeWithSelector(AccountFactoryV3.NotAllowlisted.selector, stranger));
        v.deposit(10e6, 0);
        vm.stopPrank();
        vm.startPrank(admin);
        factory.addDepositor(tester);
        factory.addDepositor(other);
        vm.stopPrank();
        uint256 testerShares = vaultDeposit(v, tester, 300e6);
        uint256 otherShares = vaultDeposit(v, other, 200e6);
        // Every gate shut after the fact: off the allowlist, the vault cap at zero, public deposits off.
        vm.startPrank(admin);
        factory.removeDepositor(tester);
        factory.removeDepositor(other);
        factory.setVaultCap(0);
        factory.disableDeposits();
        vm.stopPrank();
        vm.warp(block.timestamp + 1 days + 1);
        refreshFeeds();
        uint256 before = usdc.balanceOf(tester);
        vm.prank(tester);
        v.redeem(testerShares, tester, 0, uint64(block.timestamp + 1 hours));
        assertGt(usdc.balanceOf(tester) - before, 298e6, "the USDC exit paid, less the spread");
        before = usdc.balanceOf(other);
        vm.prank(other);
        v.redeemInKind(otherShares, other);
        assertGt(usdc.balanceOf(other) - before, 198e6, "the in-kind exit paid");
        assertEq(v.sharesOf(tester) + v.sharesOf(other), 0);
    }

    function test_PublicVaultDepositsWaitTheLaunchDecision() public {
        StrategyVaultV3 v = newVault(1_000e6);
        address tester = makeAddr("tester");
        vm.prank(admin);
        factory.addDepositor(tester);
        timelocked(AccountFactoryV3.Action.DisableAllowlist, NONE);
        assertFalse(factory.allowlistEnabled());
        // The allowlist is off, public deposits are not on yet: a stranger is refused by the launch flag alone.
        usdc.mint(stranger, 10e6);
        vm.startPrank(stranger);
        usdc.approve(address(v), 10e6);
        vm.expectRevert(abi.encodeWithSelector(AccountFactoryV3.PublicDepositsDisabled.selector, stranger));
        v.deposit(10e6, 0);
        vm.stopPrank();
        vaultDeposit(v, tester, 10e6);
        // A personal account is its owner's own money: the launch flag never gates it.
        nft.setOwner(9, stranger);
        vm.prank(stranger);
        PersonalAccountV3 theirs = PersonalAccountV3(factory.createPersonalAccount(9));
        vm.startPrank(stranger);
        usdc.approve(address(theirs), 10e6);
        theirs.deposit(address(usdc), 10e6);
        vm.stopPrank();
        assertEq(theirs.principal(), 10e6);
        // The launch decision (P9-U5) opens public vault deposits after the timelock; closing is instant.
        timelocked(AccountFactoryV3.Action.EnableDeposits, NONE);
        assertTrue(factory.depositsEnabled());
        vaultDeposit(v, stranger, 5e6);
        vm.prank(admin);
        factory.disableDeposits();
        usdc.mint(stranger, 5e6);
        vm.startPrank(stranger);
        usdc.approve(address(v), 5e6);
        vm.expectRevert(abi.encodeWithSelector(AccountFactoryV3.PublicDepositsDisabled.selector, stranger));
        v.deposit(5e6, 0);
        vm.stopPrank();
    }

    function test_TheAdminAddsAndRemovesDepositorsAtOnce_AndTurnsTheAllowlistOffOnlyByTimelock() public {
        vm.startPrank(admin);
        vm.expectEmit(address(factory));
        emit AccountFactoryV3.DepositorAllowlistSet(owner, true, false);
        factory.removeDepositor(owner);
        assertFalse(factory.isAllowlisted(owner));
        factory.enableAllowlist();
        vm.stopPrank();
        usdc.mint(owner, 1e6);
        vm.startPrank(owner);
        usdc.approve(address(account), 1e6);
        vm.expectRevert(abi.encodeWithSelector(AccountFactoryV3.NotAllowlisted.selector, owner));
        account.deposit(address(usdc), 1e6);
        vm.stopPrank();
        vm.prank(admin);
        vm.expectEmit(address(factory));
        emit AccountFactoryV3.DepositorAllowlistSet(owner, false, true);
        factory.addDepositor(owner);
        assertTrue(factory.isAllowlisted(owner));
        deposit(usdc, 1e6);
        vm.prank(owner);
        account.withdrawAll(owner);
        assertEq(usdcBal(owner), 2e6);

        timelocked(AccountFactoryV3.Action.DisableAllowlist, NONE);
        assertFalse(factory.allowlistEnabled());
        vm.prank(admin);
        factory.enableAllowlist();
        assertTrue(factory.allowlistEnabled());
    }

    function test_OnlyTheAdminAddsADepositor_AndNeverAddressZero() public {
        address tester = makeAddr("tester");
        address[3] memory others = [guardian, sentinel, makeAddr("outsider")];
        for (uint256 i = 0; i < others.length; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, others[i]));
            factory.addDepositor(tester);
        }
        assertFalse(factory.isAllowlisted(tester));
        vm.prank(admin);
        vm.expectRevert(AccountFactoryV3.ZeroAddress.selector);
        factory.addDepositor(address(0));
    }

    /// An instant addition cannot raise exposure: the new depositor is held
    /// to the per-account cap and the platform cap, which only the timelock raises.
    function test_AnAddedDepositorIsStillBoundByBothCaps() public {
        address tester = makeAddr("tester");
        nft.setOwner(8, tester);
        vm.prank(admin);
        factory.addDepositor(tester);
        vm.prank(tester);
        PersonalAccountV3 theirs = PersonalAccountV3(factory.createPersonalAccount(8));
        usdc.mint(tester, PERSONAL_CAP + 1);
        vm.startPrank(tester);
        usdc.approve(address(theirs), PERSONAL_CAP + 1);
        vm.expectRevert(
            abi.encodeWithSelector(AccountFactoryV3.PersonalCapExceeded.selector, PERSONAL_CAP + 1, PERSONAL_CAP)
        );
        theirs.deposit(address(usdc), PERSONAL_CAP + 1);
        theirs.deposit(address(usdc), PERSONAL_CAP);
        vm.stopPrank();
        vm.prank(admin);
        factory.setPlatformCap(1_500e6);
        deposit(usdc, 500e6);
        usdc.mint(owner, 1e6);
        vm.startPrank(owner);
        usdc.approve(address(account), 1e6);
        vm.expectRevert(abi.encodeWithSelector(AccountFactoryV3.PlatformCapExceeded.selector, 1_501e6, 1_500e6));
        account.deposit(address(usdc), 1e6);
        vm.stopPrank();
    }

    function test_TheAdminOrGuardianClearsTheExecutor_NobodyElse() public {
        setExecutor();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AccountFactoryV3.NotAdminOrGuardian.selector, stranger));
        factory.clearExecutor();
        vm.prank(guardian);
        factory.clearExecutor();
        assertEq(factory.executor(), address(0));
        setExecutor();
        vm.prank(admin);
        factory.clearExecutor();
        assertEq(factory.executor(), address(0));
    }

    function test_ANewGuardianWaitsTheTimelock() public {
        address next = makeAddr("next guardian");
        timelocked(AccountFactoryV3.Action.SetGuardian, addr(next));
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(AccountFactoryV3.NotAdminOrGuardian.selector, guardian));
        factory.clearExecutor();
        vm.prank(next);
        factory.clearExecutor();
    }

    // ----- bookkeeping is for accounts only -----

    function test_OnlyAccountsRecord() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AccountFactoryV3.NotAnAccount.selector, stranger));
        factory.recordDeposit(stranger, 0, 0);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(AccountFactoryV3.NotAnAccount.selector, admin));
        factory.recordWithdrawal(0);
    }

    // ----- admin -----

    function test_AdminIsTwoStep_AndCannotBeRenounced() public {
        address next = makeAddr("next admin");
        vm.prank(admin);
        factory.transferOwnership(next);
        assertEq(factory.owner(), admin);
        vm.prank(next);
        factory.acceptOwnership();
        assertEq(factory.owner(), next);
        vm.prank(next);
        vm.expectRevert(AccountFactoryV3.RenounceDisabled.selector);
        factory.renounceOwnership();
    }

    // ----- fuzz -----

    /// Whatever the cap and the amounts, principal never passes the cap and the
    /// platform total equals the sum of what was recorded.
    function testFuzz_CapsHold(uint96 cap, uint96 first, uint96 second) public {
        cap = uint96(bound(cap, 1, PERSONAL_CAP));
        vm.prank(admin);
        factory.setPersonalCap(cap);
        uint256 a = bound(first, 1, 2_000e6);
        uint256 b = bound(second, 1, 2_000e6);
        usdc.mint(owner, a + b);
        vm.startPrank(owner);
        usdc.approve(address(account), a + b);
        bool firstOk = a <= cap;
        if (!firstOk) vm.expectRevert();
        account.deposit(address(usdc), a);
        uint256 held = firstOk ? a : 0;
        bool secondOk = held + b <= cap;
        if (!secondOk) vm.expectRevert();
        account.deposit(address(usdc), b);
        vm.stopPrank();
        held += secondOk ? b : 0;
        assertEq(account.principal(), held);
        assertEq(factory.platformTotal(), held);
        assertLe(account.principal(), cap);
    }

    // ----- D-235: the oracle and Executor given at deployment -----

    function freshFactoryWith(address oracle_, address executor_) internal returns (AccountFactoryV3 f) {
        address[] memory allow = new address[](1);
        allow[0] = owner;
        f = new AccountFactoryV3(
            AccountFactoryV3.Deployment({
                admin: admin,
                guardian: guardian,
                sentinel: sentinel,
                oracle: oracle_,
                executor: executor_,
                agentNft: IAgentNFTView(address(nft)),
                usdc: address(usdc),
                tokenRegistry: ITokenRegistry(address(tokens)),
                personalCap: PERSONAL_CAP,
                vaultCap: VAULT_CAP,
                platformCap: PLATFORM_CAP,
                depositsEnabled: false,
                allowlist: allow,
                personalImplementation: address(
                    new PersonalAccountV3(
                        IAgentNFTView(address(nft)), address(usdc), ITokenRegistry(address(tokens)), 6_000
                    )
                ),
                vaultImplementation: address(
                    new StrategyVaultV3(
                        IAgentNFTView(address(nft)), address(usdc), ITokenRegistry(address(tokens)), 6_000
                    )
                )
            })
        );
    }

    function test_AnOracleAndExecutorGivenAtDeploymentAreLiveAtOnce() public {
        vm.expectEmit();
        emit AccountFactoryV3.OracleSet(address(0), address(oracle));
        vm.expectEmit();
        emit AccountFactoryV3.ExecutorSet(address(0), address(executor));
        AccountFactoryV3 f = freshFactoryWith(address(oracle), address(executor));
        assertEq(f.oracle(), address(oracle));
        assertEq(f.executor(), address(executor));
        nft.setOwner(9, owner);
        vm.prank(owner);
        PersonalAccountV3 a = PersonalAccountV3(f.createPersonalAccount(9));
        usdc.mint(owner, 10e6);
        vm.startPrank(owner);
        usdc.approve(address(a), 10e6);
        a.deposit(address(usdc), 10e6);
        vm.stopPrank();
        assertEq(a.principal(), 10e6);
    }

    function test_ChangingAnOracleOrExecutorGivenAtDeploymentStillWaitsTheTimelock() public {
        AccountFactoryV3 f = freshFactoryWith(address(oracle), address(executor));
        address next = makeAddr("next");
        bytes32 value = addr(next);
        vm.startPrank(admin);
        bytes32 idO = f.propose(AccountFactoryV3.Action.SetOracle, value);
        bytes32 idE = f.propose(AccountFactoryV3.Action.SetExecutor, value);
        vm.stopPrank();
        (uint64 at,) = f.pending(idO);
        vm.expectRevert(abi.encodeWithSelector(AccountFactoryV3.TooEarly.selector, at));
        f.execute(AccountFactoryV3.Action.SetOracle, value);
        (at,) = f.pending(idE);
        vm.expectRevert(abi.encodeWithSelector(AccountFactoryV3.TooEarly.selector, at));
        f.execute(AccountFactoryV3.Action.SetExecutor, value);
        assertEq(f.oracle(), address(oracle));
        assertEq(f.executor(), address(executor));
        vm.prank(guardian);
        f.clearExecutor();
        assertEq(f.executor(), address(0));
    }

    function test_ADeploymentRefusesZeroReferences() public {
        address[] memory allow = new address[](0);
        AccountFactoryV3.Deployment memory d = AccountFactoryV3.Deployment({
            admin: admin,
            guardian: guardian,
            sentinel: sentinel,
            oracle: address(0),
            executor: address(0),
            agentNft: IAgentNFTView(address(0)),
            usdc: address(usdc),
            tokenRegistry: ITokenRegistry(address(tokens)),
            personalCap: PERSONAL_CAP,
            vaultCap: VAULT_CAP,
            platformCap: PLATFORM_CAP,
            depositsEnabled: false,
            allowlist: allow,
            personalImplementation: address(
                new PersonalAccountV3(IAgentNFTView(address(0)), address(usdc), ITokenRegistry(address(tokens)), 6_000)
            ),
            vaultImplementation: address(
                new StrategyVaultV3(IAgentNFTView(address(0)), address(usdc), ITokenRegistry(address(tokens)), 6_000)
            )
        });
        vm.expectRevert(AccountFactoryV3.ZeroAddress.selector);
        new AccountFactoryV3(d);
        d.agentNft = IAgentNFTView(address(nft));
        d.tokenRegistry = ITokenRegistry(address(0));
        vm.expectRevert(AccountFactoryV3.ZeroAddress.selector);
        new AccountFactoryV3(d);
        // CO-U1: the personal implementation is required and must have code.
        d.tokenRegistry = ITokenRegistry(address(tokens));
        d.personalImplementation = address(0);
        vm.expectRevert(AccountFactoryV3.ZeroAddress.selector);
        new AccountFactoryV3(d);
    }

    /// CO-U1: a factory given no vault implementation (Base and Arbitrum) offers personal
    /// accounts only and refuses every vault.
    function test_AFactoryWithoutAVaultImplementationRefusesVaults() public {
        address[] memory allow = new address[](0);
        AccountFactoryV3 f = new AccountFactoryV3(
            AccountFactoryV3.Deployment({
                admin: admin,
                guardian: guardian,
                sentinel: sentinel,
                oracle: address(oracle),
                executor: address(0),
                agentNft: IAgentNFTView(address(nft)),
                usdc: address(usdc),
                tokenRegistry: ITokenRegistry(address(tokens)),
                personalCap: PERSONAL_CAP,
                vaultCap: VAULT_CAP,
                platformCap: PLATFORM_CAP,
                depositsEnabled: false,
                allowlist: allow,
                personalImplementation: address(
                    new PersonalAccountV3(
                        IAgentNFTView(address(nft)), address(usdc), ITokenRegistry(address(tokens)), 6_000
                    )
                ),
                vaultImplementation: address(0)
            })
        );
        assertEq(f.VAULT_IMPLEMENTATION(), address(0));
        vm.prank(owner);
        vm.expectRevert(AccountFactoryV3.VaultsNotOffered.selector);
        f.createVault(AGENT);
        vm.prank(owner);
        assertTrue(f.createPersonalAccount(AGENT) != address(0));
    }
}
