// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IPriceOracle} from "../../contracts/interfaces/IPriceOracle.sol";
import {RFQRiskMath} from "../../contracts/libraries/RFQRiskMath.sol";
import {ClearingFixture} from "./ClearingFixture.sol";
import "../../contracts/RFQTypes.sol";

/// @notice Governance lists new markets and tunes their risk without an upgrade; every market is priced,
/// margined and stress-tested with its own parameters.
contract MarketRegistryTest is ClearingFixture {
    Trader internal alice;

    function setUp() public override {
        super.setUp();
        fundMaker(10_000_000e6);
        openVenue();
        refreshAll();
        alice = newTrader("alice", 100_000e6);
    }

    function solConfig() internal pure returns (MarketConfig memory config) {
        config = marketConfig("SOL", 20_000, 6_000);
        config.marginScaleBps = 15_000;
    }

    function test_governanceListsAMarketThatTradesAtOnce() public {
        uint8 sol = listMarket(solConfig(), 150e6);
        assertEq(sol, 2);
        assertEq(clearing.marketCount(), 3);
        assertEq(clearing.marketId("SOL"), 2);
        MarketParams memory params = clearing.marketParams(sol);
        assertEq(params.symbol, bytes32("SOL"));
        assertEq(params.impactK, 20_000);
        assertEq(params.marginScaleBps, 15_000);

        trade(alice, sol, 100e18, false);
        assertEq(clearing.positionOf(alice.account, sol).size, 100e18);
        assertEq(clearing.openMarketsOf(alice.account), 1 << 2);
        trade(alice, 0, 1e16, false);
        assertEq(clearing.openMarketsOf(alice.account), (1 << 2) | 1);
        trade(alice, sol, -100e18, true);
        assertEq(clearing.openMarketsOf(alice.account), 1);
    }

    function test_onlyGovernanceListsMarkets() public {
        MarketConfig memory config = solConfig();
        vm.prank(emergency);
        vm.expectRevert(Unauthorized.selector);
        clearing.addMarket(config);
        vm.prank(alice.account);
        vm.expectRevert(Unauthorized.selector);
        clearing.addMarket(config);
    }

    function test_listingBumpsThePolicyVersion() public {
        uint64 before = clearing.policyVersion();
        listMarket(solConfig(), 150e6);
        assertEq(clearing.policyVersion(), before + 1);
    }

    function test_rejectsDuplicateOrInvalidMarkets() public {
        MarketConfig memory duplicate = marketConfig("ETH", 12_000, 5_000);
        vm.startPrank(governance);
        vm.expectRevert(InvalidConfiguration.selector);
        clearing.addMarket(duplicate);

        MarketConfig memory unnamed = solConfig();
        unnamed.symbol = bytes32(0);
        vm.expectRevert(InvalidConfiguration.selector);
        clearing.addMarket(unnamed);

        MarketConfig memory lightMargin = solConfig();
        lightMargin.marginScaleBps = MIN_MARGIN_SCALE_BPS - 1;
        vm.expectRevert(InvalidConfiguration.selector);
        clearing.addMarket(lightMargin);

        MarketConfig memory noShock = solConfig();
        noShock.shockBps = 0;
        vm.expectRevert(InvalidConfiguration.selector);
        clearing.addMarket(noShock);
        vm.stopPrank();

        vm.expectRevert(InvalidTrade.selector);
        clearing.marketId("DOGE");
    }

    function test_marketsAreCappedAtTheMaximum() public {
        vm.startPrank(governance);
        for (uint256 i = clearing.marketCount(); i < MAX_MARKETS; ++i) {
            clearing.addMarket(marketConfig(bytes32(i + 1000), 10_000, 4_000));
        }
        assertEq(clearing.marketCount(), MAX_MARKETS);
        vm.expectRevert(InvalidConfiguration.selector);
        clearing.addMarket(marketConfig("ONE-TOO-MANY", 10_000, 4_000));
        vm.stopPrank();
    }

    function test_unregisteredMarketsCannotTradeOrBePriced() public {
        prices.push(150e6); // a fixture price for id 2, which governance never listed
        vm.expectRevert(InvalidTrade.selector);
        this.tradeExternal(alice, 2, 1e18);
        vm.expectRevert(OracleInvalid.selector);
        clearing.refreshOracle(report(2, 150e6, vm.getBlockTimestamp()));
    }

    function test_reportsMustBeAscendingAndNonEmpty() public {
        IPriceOracle.Observation[] memory observations = new IPriceOracle.Observation[](2);
        uint64 now_ = uint64(vm.getBlockTimestamp());
        observations[0] = IPriceOracle.Observation(1, 4_000e6, 4_000e6, now_, now_ + 60);
        observations[1] = IPriceOracle.Observation(0, 100_000e6, 100_000e6, now_, now_ + 60);
        vm.expectRevert(OracleInvalid.selector);
        clearing.refreshOracle(abi.encode(observations));

        vm.expectRevert(OracleInvalid.selector);
        clearing.refreshOracle(abi.encode(new IPriceOracle.Observation[](0)));
    }

    function test_tradeReportMustPriceTheTradedMarket() public {
        (TradeIntent memory intent, MakerApproval memory approval,) = quote(alice.account, 1, 1e18, false);
        bytes memory btcOnly = singleReport(0);
        approval.oracleReportHash = keccak256(btcOnly);
        bytes memory userSig = sign(alice.key, intent);
        bytes memory sigA = signApproval(approverKeys[0], approval);
        bytes memory sigB = signApproval(approverKeys[1], approval);
        vm.expectRevert(OracleInvalid.selector);
        clearing.executeTrade(intent, approval, btcOnly, userSig, sigA, sigB);
    }

    function test_marginScaleRaisesTheMarketsMargin() public {
        uint8 sol = listMarket(marketConfig("SOL", 20_000, 6_000), 150e6);
        trade(alice, sol, 100e18, false);
        uint256 base = clearing.initialMargin(alice.account);
        assertEq(base, 15_000e6 * 2_000 / 10_000);

        vm.prank(governance);
        clearing.setMarketRisk(sol, 20_000, 6_000, 20_000);
        assertEq(clearing.initialMargin(alice.account), base * 2);
        assertEq(clearing.maintenanceMargin(alice.account), 15_000e6 * 2_400 / 10_000);
    }

    function test_setMarketRiskIsGovernanceOnlyAndValidated() public {
        vm.prank(emergency);
        vm.expectRevert(Unauthorized.selector);
        clearing.setMarketRisk(0, 10_000, 4_000, 10_000);

        vm.startPrank(governance);
        vm.expectRevert(InvalidConfiguration.selector);
        clearing.setMarketRisk(0, 0, 4_000, 10_000);
        vm.expectRevert(InvalidTrade.selector);
        clearing.setMarketRisk(5, 10_000, 4_000, 10_000);
        uint64 before = clearing.policyVersion();
        clearing.setMarketRisk(0, 11_000, 4_500, 12_000);
        vm.stopPrank();
        assertEq(clearing.policyVersion(), before + 1);
        assertEq(clearing.marketParams(0).shockBps, 4_500);
    }

    function test_stressSumsEveryMarketsShock() public {
        uint8 sol = listMarket(solConfig(), 150e6);
        trade(alice, 0, 1e17, false); // +10k BTC skew
        trade(alice, 1, -5e18, false); // -20k ETH skew
        trade(alice, sol, 100e18, false); // +15k SOL skew
        uint256 expected = 10_000e6 * 4_000 / 10_000 + 20_000e6 * 5_000 / 10_000 + 15_000e6 * 6_000 / 10_000;
        assertEq(clearing.portfolioStress(), expected);
        assertEq(RFQRiskMath.stressContribution(-1, 1), 1); // rounds up
    }

    function test_impactChargeUsesTheMarketsCoefficient() public pure {
        // k * ((s + d)^2 - s^2) / (2 * 1e12 * 1e6) for a 100k USDC trade from flat.
        int256 delta = 100_000e6;
        assertEq(RFQRiskMath.impactCost(10_000, 0, delta), 10_000 * delta * delta / 2e18);
        assertEq(RFQRiskMath.impactCost(20_000, 0, delta), 2 * RFQRiskMath.impactCost(10_000, 0, delta));
        // Reducing skew earns a rebate (negative charge).
        assertLt(RFQRiskMath.impactCost(10_000, delta, -delta), 0);
    }

    function test_sessionMaskCoversListedMarkets() public {
        listMarket(solConfig(), 150e6);
        (address key,) = makeAddrAndKey("session");
        SessionGrant memory g = SessionGrant({
            account: alice.account,
            session: key,
            marketMask: 1 << 3,
            maxTradeNotional: 50_000e6,
            maxCumulativeNotional: 100_000e6,
            maxFee: 10e6,
            validUntil: uint64(vm.getBlockTimestamp() + 1 days),
            nonce: 77,
            deadline: uint64(vm.getBlockTimestamp() + 60)
        });
        bytes memory signature = signDigest(alice.key, typedDigest(grantHash(g)));
        vm.expectRevert(InvalidTrade.selector);
        clearing.grantSessionWithSignature(g, signature);

        g.marketMask = 1 << 2;
        clearing.grantSessionWithSignature(g, signDigest(alice.key, typedDigest(grantHash(g))));
        assertEq(clearing.sessions(key).marketMask, 1 << 2);
    }

    function grantHash(SessionGrant memory g) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                SESSION_GRANT_TYPEHASH,
                g.account,
                g.session,
                g.marketMask,
                g.maxTradeNotional,
                g.maxCumulativeNotional,
                g.maxFee,
                g.validUntil,
                g.nonce,
                g.deadline
            )
        );
    }

    function test_resolutionNeedsPricesOnlyForMarketsWithExposure() public {
        uint8 sol = listMarket(solConfig(), 150e6);
        trade(alice, sol, 10e18, false);
        vm.prank(emergency);
        clearing.pause();
        vm.prank(governance);
        clearing.declareResolution();

        // A report without SOL fills BTC and ETH, but SOL still has open exposure.
        for (uint256 sample; sample < RESOLUTION_SAMPLES; ++sample) {
            if (sample != 0) vm.warp(vm.getBlockTimestamp() + 15);
            IPriceOracle.Observation[] memory observations = new IPriceOracle.Observation[](2);
            uint64 now_ = uint64(vm.getBlockTimestamp());
            observations[0] = IPriceOracle.Observation(0, prices[0], prices[0], now_, now_ + 60);
            observations[1] = IPriceOracle.Observation(1, prices[1], prices[1], now_, now_ + 60);
            clearing.submitResolutionObservation(abi.encode(observations));
        }
        assertFalse(clearing.resolutionPricesReady());
        vm.warp(vm.getBlockTimestamp() + 15);
        vm.expectRevert(InvalidTrade.selector); // nothing new for BTC or ETH
        clearing.submitResolutionObservation(singleReport(0));

        for (uint256 sample; sample < RESOLUTION_SAMPLES; ++sample) {
            vm.warp(vm.getBlockTimestamp() + 15);
            clearing.submitResolutionObservation(singleReport(sol));
        }
        assertTrue(clearing.resolutionPricesReady());
        assertEq(clearing.resolutionPrice(sol), 150e6);
        clearing.processResolution(10);
        assertTrue(clearing.resolutionFinalized());
        assertEq(clearing.openMarketsOf(alice.account), 0);
    }

    function tradeExternal(Trader memory trader, uint8 market, int256 delta) external {
        trade(trader, market, delta, false);
    }
}
