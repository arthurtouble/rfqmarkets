// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ClearingFixture} from "./ClearingFixture.sol";
import "../../contracts/RFQTypes.sol";

/// @notice Resolution is irreversible, so anyone can force it only after a reported maker incident has
/// lasted the full grace period. Before that the maker can recapitalize.
contract MakerIncidentTest is ClearingFixture {
    Trader internal alice;
    address internal stranger = makeAddr("stranger");

    function setUp() public override {
        super.setUp();
        fundMaker(101_000e6);
        openVenue();
        alice = newTrader("alice", 20_000e6);
        refreshAll();
        // 0.6 BTC at 100k: stress loss (40% shock) is 24k, just under backing / 4 = 25.25k.
        trade(alice, 0, 6e17, false);
        // A rally pushes stress above backing / 4 without any realized loss: an objective incident.
        vm.warp(block.timestamp + 1);
        setPrice(0, 110_000e6);
        refresh(1);
        assertTrue(clearing.makerIncident());
    }

    function test_incidentAloneDoesNotResolve() public {
        vm.prank(stranger);
        vm.expectRevert(Insolvent.selector);
        clearing.declareResolution();
    }

    function test_resolutionWaitsForTheGracePeriod() public {
        vm.prank(stranger);
        clearing.reportMakerIncident();
        assertEq(clearing.makerIncidentSince(), block.timestamp);

        vm.prank(stranger);
        vm.expectRevert(InvalidTrade.selector);
        clearing.reportMakerIncident();

        vm.warp(block.timestamp + DEFAULT_INCIDENT_GRACE_PERIOD - 1);
        refreshAll();
        vm.prank(stranger);
        vm.expectRevert(IncidentGracePeriod.selector);
        clearing.declareResolution();

        vm.warp(block.timestamp + 1);
        refreshAll();
        vm.prank(stranger);
        clearing.declareResolution();
        assertTrue(clearing.resolutionRequired());
        assertTrue(clearing.paused());
    }

    function test_recapitalizationClearsTheIncident() public {
        vm.prank(stranger);
        clearing.reportMakerIncident();

        vm.prank(stranger);
        vm.expectRevert(InvalidTrade.selector);
        clearing.clearMakerIncident();

        fundMaker(50_000e6);
        assertFalse(clearing.makerIncident());
        vm.prank(stranger);
        clearing.clearMakerIncident();
        assertEq(clearing.makerIncidentSince(), 0);

        vm.warp(block.timestamp + DEFAULT_INCIDENT_GRACE_PERIOD);
        refreshAll();
        vm.prank(stranger);
        vm.expectRevert(Insolvent.selector);
        clearing.declareResolution();
        assertFalse(clearing.resolutionRequired());
    }

    function test_incidentThatEndsBeforeTheGraceDeadlineCannotResolve() public {
        vm.prank(stranger);
        clearing.reportMakerIncident();
        vm.warp(block.timestamp + DEFAULT_INCIDENT_GRACE_PERIOD);
        prices[0] = 100_000e6; // the rally reverses
        refreshAll();
        assertFalse(clearing.makerIncident());
        vm.prank(stranger);
        vm.expectRevert(Insolvent.selector);
        clearing.declareResolution();
    }

    function test_governanceSetsTheGracePeriodWithinBounds() public {
        vm.prank(stranger);
        vm.expectRevert(Unauthorized.selector);
        clearing.setMakerIncidentGracePeriod(2 hours);

        vm.startPrank(governance);
        vm.expectRevert(InvalidConfiguration.selector);
        clearing.setMakerIncidentGracePeriod(MIN_INCIDENT_GRACE_PERIOD - 1);
        vm.expectRevert(InvalidConfiguration.selector);
        clearing.setMakerIncidentGracePeriod(MAX_INCIDENT_GRACE_PERIOD + 1);
        clearing.setMakerIncidentGracePeriod(2 hours);
        vm.stopPrank();

        vm.prank(stranger);
        clearing.reportMakerIncident();
        vm.warp(block.timestamp + 2 hours);
        refreshAll();
        vm.prank(stranger);
        clearing.declareResolution();
        assertTrue(clearing.resolutionRequired());
    }

    function test_governanceCanStillResolveAPausedVenue() public {
        vm.prank(governance);
        vm.expectRevert(InvalidTrade.selector);
        clearing.declareResolution();

        vm.prank(emergency);
        clearing.pause();
        vm.prank(governance);
        clearing.declareResolution();
        assertTrue(clearing.resolutionRequired());
    }

    function test_openingTradesAreBlockedDuringTheIncident() public {
        Trader memory bob = newTrader("bob", 20_000e6);
        vm.expectRevert(Margin.selector);
        this.tradeExternal(bob, 0, 1e16);
        // Reductions remain available.
        trade(alice, 0, -1e17, true);
    }

    function tradeExternal(Trader memory trader, uint8 market, int256 delta) external {
        trade(trader, market, delta, false);
    }
}
