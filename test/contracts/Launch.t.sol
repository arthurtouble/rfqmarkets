// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {RFQClearing} from "../../contracts/RFQClearing.sol";
import {TestProxy} from "../../contracts/test/TestProxy.sol";
import {ClearingFixture} from "./ClearingFixture.sol";
import "../../contracts/RFQTypes.sol";

/// @notice A fresh deployment starts paused with the launch caps it was given.
contract LaunchTest is ClearingFixture {
    function setUp() public override {
        super.setUp();
        MarketConfig memory btc = MarketConfig({
            enabled: true, maxTradeNotional: 25_000e6, maxMarketNotional: 250_000e6, grossLimit: 500_000e6, sideLimit: 300_000e6
        });
        MarketConfig memory eth = MarketConfig({
            enabled: false, maxTradeNotional: 10_000e6, maxMarketNotional: 100_000e6, grossLimit: 200_000e6, sideLimit: 150_000e6
        });
        clearing = deployClearing([btc, eth]);
    }

    function test_startsPausedWithLaunchCaps() public view {
        assertTrue(clearing.paused());
        assertEq(clearing.governance(), governance);
        assertEq(clearing.emergencyCouncil(), emergency);
        assertEq(clearing.leaderEpoch(), 1);
        assertEq(clearing.makerIncidentGracePeriod(), DEFAULT_INCIDENT_GRACE_PERIOD);

        assertEq(clearing.marketLimitWord(0), uint256(25_000e6) | (uint256(250_000e6) << 128));
        (,,,,,, bool btcEnabled) = clearing.markets(0);
        (,,,,,, bool ethEnabled) = clearing.markets(1);
        assertTrue(btcEnabled);
        assertFalse(ethEnabled);
        (,, uint256 limits,, bool ready) = clearing.exposureState(1);
        assertEq(limits, uint256(200_000e6) | (uint256(150_000e6) << 128));
        assertTrue(ready);
        assertEq(proxyAdmin.owner(), governance);
    }

    function test_tradingWaitsForGovernanceToUnpause() public {
        fundMaker(FLOOR);
        Trader memory alice = newTrader("alice", 10_000e6);
        refreshAll();
        (TradeIntent memory intent, MakerApproval memory approval, bytes memory proof) = quote(alice.account, 0, 1e16, false);
        bytes memory userSig = sign(alice.key, intent);
        bytes memory sigA = signApproval(approverKeys[0], approval);
        bytes memory sigB = signApproval(approverKeys[1], approval);
        vm.expectRevert(InvalidTrade.selector);
        clearing.executeTrade(intent, approval, proof, userSig, sigA, sigB);

        vm.prank(emergency);
        vm.expectRevert(Unauthorized.selector);
        clearing.unpause();

        openVenue();
        clearing.executeTrade(intent, approval, proof, userSig, sigA, sigB);
        assertEq(clearing.positionOf(alice.account, 0).size, 1e16);
    }

    function test_launchCapsApplyFromTheFirstTrade() public {
        fundMaker(FLOOR);
        openVenue();
        Trader memory alice = newTrader("alice", 50_000e6);
        refreshAll();
        // 0.3 BTC is 30k notional, above the 25k per-trade cap.
        vm.expectRevert(InvalidTrade.selector);
        this.tradeExternal(alice, 0, 3e17);
        // ETH launched disabled.
        vm.expectRevert(Margin.selector);
        this.tradeExternal(alice, 1, 1e18);
        trade(alice, 0, 2e17, false);
    }

    function tradeExternal(Trader memory trader, uint8 market, int256 delta) external {
        trade(trader, market, delta, false);
    }

    function test_cannotInitializeTwiceOrUseTheImplementation() public {
        MarketConfig[2] memory configs = [maxConfig(), maxConfig()];
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        clearing.initialize(address(usdc), address(oracle), governance, emergency, approvers, FLOOR, configs);

        RFQClearing implementation = new RFQClearing();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        implementation.initialize(address(usdc), address(oracle), governance, emergency, approvers, FLOOR, configs);
    }

    function test_rejectsInvalidLaunchConfiguration() public {
        MarketConfig memory sideAboveGross = maxConfig();
        sideAboveGross.sideLimit = sideAboveGross.grossLimit + 1;
        expectInitializeRevert([maxConfig(), sideAboveGross]);

        MarketConfig memory zeroTrade = maxConfig();
        zeroTrade.maxTradeNotional = 0;
        expectInitializeRevert([zeroTrade, maxConfig()]);

        MarketConfig memory aboveCeiling = maxConfig();
        aboveCeiling.maxMarketNotional = uint128(ABSOLUTE_MAX_MARKET_NOTIONAL + 1);
        expectInitializeRevert([aboveCeiling, maxConfig()]);
    }

    function expectInitializeRevert(MarketConfig[2] memory configs) internal {
        RFQClearing implementation = new RFQClearing();
        bytes memory init = abi.encodeCall(
            RFQClearing.initialize, (address(usdc), address(oracle), governance, emergency, approvers, FLOOR, configs)
        );
        vm.expectRevert(InvalidTrade.selector);
        new TestProxy(address(implementation), governance, init);
    }
}
