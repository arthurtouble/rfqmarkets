// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ClearingFixture} from "./ClearingFixture.sol";
import "../../contracts/RFQTypes.sol";

/// @notice The risk operator lists and tunes markets at once, with no timelock. It may always tighten, may
/// loosen only within the bounds governance sets, and has no other authority.
contract RiskOperatorTest is ClearingFixture {
    address internal operator = makeAddr("operator");
    address internal stranger = makeAddr("stranger");
    Trader internal alice;

    function setUp() public override {
        super.setUp();
        fundMaker(10_000_000e6);
        openVenue();
        refreshAll();
        alice = newTrader("alice", 100_000e6);
        vm.startPrank(governance);
        clearing.setRiskOperator(operator);
        clearing.setRiskOperatorBounds(bounds());
        // Start the launch markets inside the operator's envelope.
        for (uint8 market; market < 2; ++market) {
            clearing.setMarketPolicy(market, true, 100_000e6, 1_000_000e6);
            clearing.setExposurePolicy(market, 2_000_000e6, 1_000_000e6);
        }
        vm.stopPrank();
    }

    function bounds() internal pure returns (RiskOperatorBounds memory) {
        return RiskOperatorBounds({
            maxTradeNotional: 250_000e6,
            maxMarketNotional: 2_000_000e6,
            maxGrossLimit: 3_000_000e6,
            minImpactK: 5_000,
            minShockBps: 2_000,
            minMarginScaleBps: 5_000
        });
    }

    function solConfig() internal pure returns (MarketConfig memory config) {
        config = marketConfig("SOL", 20_000, 6_000);
        config.maxTradeNotional = 50_000e6;
        config.maxMarketNotional = 500_000e6;
        config.grossLimit = 1_000_000e6;
        config.sideLimit = 600_000e6;
        config.marginScaleBps = 15_000;
    }

    // ---- Appointment ----

    function test_onlyGovernanceAppointsAndEitherSafetyRoleRevokes() public {
        vm.prank(operator);
        vm.expectRevert(Unauthorized.selector);
        clearing.setRiskOperator(stranger);
        vm.prank(emergency);
        vm.expectRevert(Unauthorized.selector);
        clearing.setRiskOperator(stranger);
        vm.prank(operator);
        vm.expectRevert(Unauthorized.selector);
        clearing.setRiskOperatorBounds(bounds());

        vm.prank(emergency);
        clearing.setRiskOperator(address(0));
        assertEq(clearing.riskOperator(), address(0));
        vm.prank(operator);
        vm.expectRevert(Unauthorized.selector);
        clearing.setMarketPolicy(0, false, 1_000e6, 10_000e6);

        vm.prank(governance);
        clearing.setRiskOperator(operator);
        assertEq(clearing.riskOperator(), operator);
        RiskOperatorBounds memory stored = clearing.riskOperatorBounds();
        assertEq(stored.maxGrossLimit, 3_000_000e6);
        assertEq(stored.minMarginScaleBps, 5_000);
    }

    function test_operatorHasNoOtherAuthority() public {
        vm.startPrank(operator);
        vm.expectRevert(Unauthorized.selector);
        clearing.unpause();
        vm.expectRevert(Unauthorized.selector);
        clearing.pause();
        vm.expectRevert(Unauthorized.selector);
        clearing.setOracle(stranger);
        vm.expectRevert(Unauthorized.selector);
        clearing.rotateApprovers([stranger, stranger, stranger]);
        vm.expectRevert(Unauthorized.selector);
        clearing.withdrawMakerExcess(operator, 1);
        vm.expectRevert(Unauthorized.selector);
        clearing.transferGovernance(operator);
        vm.expectRevert(Unauthorized.selector);
        clearing.setEmergencyCouncil(operator);
        vm.stopPrank();
    }

    function test_strangersCannotConfigureMarkets() public {
        vm.startPrank(stranger);
        vm.expectRevert(Unauthorized.selector);
        clearing.addMarket(solConfig());
        vm.expectRevert(Unauthorized.selector);
        clearing.setMarketPolicy(0, false, 1_000e6, 10_000e6);
        vm.expectRevert(Unauthorized.selector);
        clearing.setExposurePolicy(0, 1_000e6, 1_000e6);
        vm.expectRevert(Unauthorized.selector);
        clearing.setMarketRisk(0, 20_000, 6_000, 20_000);
        vm.expectRevert(Unauthorized.selector);
        clearing.setSpread(0, 10);
        vm.stopPrank();
    }

    // ---- Listing ----

    function test_operatorListsAMarketWithinBoundsThatTradesAtOnce() public {
        uint64 before = clearing.policyVersion();
        vm.prank(operator);
        uint8 sol = clearing.addMarket(solConfig());
        assertEq(sol, 2);
        assertEq(clearing.policyVersion(), before + 1);
        prices.push(150e6);
        refresh(sol);
        trade(alice, sol, 100e18, false);
        assertEq(clearing.positionOf(alice.account, sol).size, 100e18);
    }

    function test_operatorCannotListOutsideBounds() public {
        MarketConfig[6] memory configs;
        for (uint256 i; i < 6; ++i) configs[i] = solConfig();
        configs[0].maxTradeNotional = 250_000e6 + 1;
        configs[1].maxMarketNotional = 2_000_000e6 + 1;
        configs[2].grossLimit = 3_000_000e6 + 1;
        configs[3].impactK = 4_999;
        configs[4].shockBps = 1_999;
        configs[5].marginScaleBps = 4_999;
        vm.startPrank(operator);
        for (uint256 i; i < 6; ++i) {
            vm.expectRevert(Unauthorized.selector);
            clearing.addMarket(configs[i]);
        }
        vm.stopPrank();
        // Governance is not bound by the envelope.
        vm.prank(governance);
        clearing.addMarket(configs[2]);
    }

    // ---- Limits and reduce-only ----

    function test_operatorMakesAMarketReduceOnlyAndBack() public {
        trade(alice, 0, 1e17, false);
        vm.prank(operator);
        clearing.setMarketPolicy(0, false, 100_000e6, 1_000_000e6);
        tradeReverts(alice, 0, 1e17, Margin.selector);
        trade(alice, 0, -5e16, true);
        vm.prank(operator);
        clearing.setMarketPolicy(0, true, 100_000e6, 1_000_000e6);
        trade(alice, 0, 1e16, false);
    }

    function test_operatorLoosensLimitsOnlyWithinBounds() public {
        vm.startPrank(operator);
        clearing.setMarketPolicy(0, true, 250_000e6, 2_000_000e6);
        vm.expectRevert(Unauthorized.selector);
        clearing.setMarketPolicy(0, true, 250_000e6 + 1, 2_000_000e6);
        vm.expectRevert(Unauthorized.selector);
        clearing.setMarketPolicy(0, true, 250_000e6, 2_000_000e6 + 1);

        clearing.setExposurePolicy(0, 3_000_000e6, 1_500_000e6);
        vm.expectRevert(Unauthorized.selector);
        clearing.setExposurePolicy(0, 3_000_000e6 + 1, 1_500_000e6);
        vm.stopPrank();
    }

    function test_operatorMayTightenAboveItsBounds() public {
        // Governance sets limits above the operator's envelope; the operator can still bring them down.
        vm.startPrank(governance);
        clearing.setMarketPolicy(0, true, 900_000e6, 4_000_000e6);
        clearing.setExposurePolicy(0, 5_000_000e6, 5_000_000e6);
        vm.stopPrank();
        vm.startPrank(operator);
        clearing.setMarketPolicy(0, true, 800_000e6, 3_500_000e6);
        clearing.setExposurePolicy(0, 4_000_000e6, 4_000_000e6);
        vm.expectRevert(Unauthorized.selector);
        clearing.setMarketPolicy(0, true, 850_000e6, 3_500_000e6);
        vm.stopPrank();
    }

    function test_exposureLimitsChangeWhileLiveAndFenceApprovals() public {
        trade(alice, 0, 1e17, false);
        uint64 before = clearing.policyVersion();
        vm.prank(operator);
        clearing.setExposurePolicy(0, 5_000e6, 5_000e6);
        assertEq(clearing.policyVersion(), before + 1);
        // The book is over the new limit: it may shrink but not grow.
        tradeReverts(alice, 0, 1e16, Margin.selector);
        trade(alice, 0, -5e16, true);
    }

    function test_emergencyTightensExposureButCannotLoosen() public {
        vm.startPrank(emergency);
        clearing.setExposurePolicy(0, 1_000_000e6, 500_000e6);
        vm.expectRevert(Unauthorized.selector);
        clearing.setExposurePolicy(0, 1_000_000e6, 600_000e6);
        vm.stopPrank();
    }

    // ---- Risk parameters ----

    function test_operatorRaisesRiskFreelyAndLowersItOnlyToTheFloor() public {
        vm.startPrank(operator);
        clearing.setMarketRisk(0, 50_000, 8_000, 30_000);
        clearing.setMarketRisk(0, 5_000, 2_000, 5_000);
        vm.expectRevert(Unauthorized.selector);
        clearing.setMarketRisk(0, 4_999, 2_000, 5_000);
        vm.expectRevert(Unauthorized.selector);
        clearing.setMarketRisk(0, 5_000, 1_999, 5_000);
        vm.expectRevert(Unauthorized.selector);
        clearing.setMarketRisk(0, 5_000, 2_000, 4_999);
        vm.stopPrank();

        // Below the floor already (set by governance): the operator may raise, never lower further.
        vm.prank(governance);
        clearing.setMarketRisk(1, 1_000, 1_000, 2_500);
        vm.startPrank(operator);
        clearing.setMarketRisk(1, 2_000, 1_500, 3_000);
        vm.expectRevert(Unauthorized.selector);
        clearing.setMarketRisk(1, 1_900, 1_500, 3_000);
        vm.stopPrank();
        assertEq(clearing.marketParams(1).marginScaleBps, 3_000);
    }

    function test_contractLimitsStillBindGovernanceAndOperator() public {
        vm.prank(governance);
        clearing.setRiskOperatorBounds(
            RiskOperatorBounds({
                maxTradeNotional: type(uint128).max,
                maxMarketNotional: type(uint128).max,
                maxGrossLimit: type(uint128).max,
                minImpactK: 0,
                minShockBps: 0,
                minMarginScaleBps: 0
            })
        );
        vm.startPrank(operator);
        vm.expectRevert(InvalidTrade.selector);
        clearing.setMarketPolicy(0, true, uint128(ABSOLUTE_MAX_TRADE_NOTIONAL) + 1, uint128(ABSOLUTE_MAX_MARKET_NOTIONAL));
        vm.expectRevert(InvalidTrade.selector);
        clearing.setExposurePolicy(0, uint128(ABSOLUTE_MAX_MARKET_NOTIONAL) + 1, 1);
        vm.expectRevert(InvalidConfiguration.selector);
        clearing.setMarketRisk(0, 10_000, 4_000, MIN_MARGIN_SCALE_BPS - 1);
        vm.stopPrank();
    }

    // ---- Spreads ----

    function test_spreadsAreBoundedAndZeroFallsBack() public {
        vm.startPrank(operator);
        clearing.setSpread(0, 8);
        clearing.setSpread(255, 4);
        vm.expectRevert(InvalidConfiguration.selector);
        clearing.setSpread(0, 1);
        vm.expectRevert(InvalidConfiguration.selector);
        clearing.setSpread(0, 51);
        vm.expectRevert(InvalidTrade.selector);
        clearing.setSpread(2, 8);
        vm.stopPrank();
        assertEq(clearing.marketSpread(0), 8);
        assertEq(clearing.marketSpread(1), 0);
        assertEq(clearing.defaultSpread(), 4);

        uint64 before = clearing.policyVersion();
        vm.prank(governance);
        clearing.setSpread(0, 0);
        assertEq(clearing.marketSpread(0), 0);
        assertEq(clearing.policyVersion(), before);

        vm.prank(emergency);
        vm.expectRevert(Unauthorized.selector);
        clearing.setSpread(0, 10);
    }
}
