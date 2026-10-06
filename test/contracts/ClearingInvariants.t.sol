// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {ClearingFixture} from "./ClearingFixture.sol";
import "../../contracts/RFQTypes.sol";

/// @notice Drives random deposits, fills, withdrawals, price moves, liquidations and time through the
/// real signing path. Calls that the venue rejects are discarded.
contract ClearingHandler is ClearingFixture {
    Trader[] internal traders;
    uint256 public fills;
    uint256 public liquidations;

    function boot() external {
        setUp();
        fundMaker(2_000_000e6);
        fundInsurance(50_000e6);
        openVenue();
        traders.push(newTrader("alice", 15_000e6));
        traders.push(newTrader("bob", 10_000e6));
        traders.push(newTrader("carol", 7_000e6));
        refreshAll();
    }

    function traderCount() external view returns (uint256) {
        return traders.length;
    }

    function traderAt(uint256 i) external view returns (address) {
        return traders[i].account;
    }

    function clearingAddress() external view returns (address) {
        return address(clearing);
    }

    function usdcAddress() external view returns (address) {
        return address(usdc);
    }

    function tick() internal {
        vm.warp(vm.getBlockTimestamp() + 1);
        refreshAll();
    }

    function deposit(uint256 who, uint256 amount) external {
        tick();
        depositFor(traders[who % traders.length].account, bound(amount, MIN_FIRST_DEPOSIT, 5_000e6));
    }

    function open(uint256 who, uint256 marketSeed, int256 delta) external {
        tick();
        uint8 market = uint8(marketSeed % MARKET_COUNT);
        int256 maxBase = market == 0 ? int256(3e17) : int256(5e18);
        delta = bound(delta, -maxBase, maxBase);
        if (delta == 0) return;
        trade(traders[who % traders.length], market, delta, false);
        ++fills;
    }

    function reduce(uint256 who, uint256 marketSeed, uint256 fraction) external {
        tick();
        Trader memory trader = traders[who % traders.length];
        uint8 market = uint8(marketSeed % MARKET_COUNT);
        int256 size = clearing.positionOf(trader.account, market).size;
        if (size == 0) return;
        int256 delta = -size * int256(bound(fraction, 1, 100)) / 100;
        if (delta == 0) return;
        trade(trader, market, delta, true);
        ++fills;
    }

    function withdraw(uint256 who, uint256 amount) external {
        tick();
        address account = traders[who % traders.length].account;
        vm.prank(account);
        clearing.withdraw(bound(amount, 1, 20_000e6));
    }

    function movePrice(uint256 marketSeed, int256 bps) external {
        vm.warp(vm.getBlockTimestamp() + 1);
        uint8 market = uint8(marketSeed % MARKET_COUNT);
        bps = bound(bps, -2_000, 2_000);
        prices[market] = prices[market] * uint256(10_000 + bps) / 10_000;
        refreshAll();
    }

    /// @notice Keeper sweep: liquidates every account and market that the venue accepts.
    function liquidate() external {
        tick();
        for (uint256 i; i < traders.length; ++i) {
            for (uint8 market; market < MARKET_COUNT; ++market) {
                if (clearing.positionOf(traders[i].account, market).size == 0) continue;
                vm.prank(keeper);
                try clearing.liquidate(traders[i].account, market, currentReport(market)) {
                    ++liquidations;
                } catch {}
            }
        }
    }

    function elapse(uint256 seconds_) external {
        vm.warp(vm.getBlockTimestamp() + bound(seconds_, 1, 12 hours));
        refreshAll();
    }

    function custodyBalanced() external view returns (bool) {
        return custodyMatchesBuckets();
    }
}

interface IClearingView {
    function positionOf(address account, uint8 market) external view returns (Position memory);
    function markets(uint256 market)
        external
        view
        returns (int256, int256, uint64, uint64, uint256, uint256, bool);
    function exposureState(uint8 market) external view returns (uint256, uint256, uint256, uint256, bool);
    function accountCount() external view returns (uint256);
}

contract ClearingInvariantsTest is Test {
    ClearingHandler internal handler;
    IClearingView internal clearing;

    function setUp() public {
        handler = new ClearingHandler();
        handler.boot();
        clearing = IClearingView(handler.clearingAddress());
        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = ClearingHandler.deposit.selector;
        selectors[1] = ClearingHandler.open.selector;
        selectors[2] = ClearingHandler.reduce.selector;
        selectors[3] = ClearingHandler.withdraw.selector;
        selectors[4] = ClearingHandler.movePrice.selector;
        selectors[5] = ClearingHandler.liquidate.selector;
        selectors[6] = ClearingHandler.elapse.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @notice Every USDC the contract holds belongs to exactly one bucket.
    function invariant_custodyEqualsBuckets() public view {
        assertTrue(handler.custodyBalanced());
    }

    /// @notice Market aggregates and exposure books equal the sum of customer positions.
    function invariant_aggregatesMatchPositions() public view {
        uint256 count = handler.traderCount();
        for (uint8 market; market < MARKET_COUNT; ++market) {
            int256 net;
            uint256 longs;
            uint256 shorts;
            for (uint256 i; i < count; ++i) {
                int256 size = clearing.positionOf(handler.traderAt(i), market).size;
                net += size;
                if (size > 0) longs += uint256(size);
                else shorts += uint256(-size);
            }
            (int256 aggregateBase,,,,,,) = clearing.markets(market);
            (uint256 longBase, uint256 shortBase,,,) = clearing.exposureState(market);
            assertEq(aggregateBase, net, "aggregate base");
            assertEq(longBase, longs, "long book");
            assertEq(shortBase, shorts, "short book");
        }
    }

    function afterInvariant() external view {
        // Guard against a handler that silently stopped trading.
        assertGt(handler.fills(), 0, "no fills were exercised");
    }
}
