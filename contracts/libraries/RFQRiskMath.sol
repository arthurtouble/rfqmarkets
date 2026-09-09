// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @notice Pure version-one portfolio risk arithmetic. Values are signed USDC micro-units.
library RFQRiskMath {
    int256 internal constant RATE = 1e12;
    int256 internal constant K_BTC = 10_000;
    int256 internal constant K_ETH = 12_000;
    int256 internal constant K_CROSS = 6_573;

    function potential(int256 btc, int256 eth) private pure returns (int256) {
        return floorDiv(K_BTC * btc * btc + 2 * K_CROSS * btc * eth + K_ETH * eth * eth, 2 * RATE * 1e6);
    }

    function impactCost(int256 btc, int256 eth, uint8 market, int256 delta) public pure returns (int256) {
        int256 beforeValue = potential(btc, eth);
        if (market == 0) btc += delta; else eth += delta;
        return potential(btc, eth) - beforeValue;
    }

    function tradeAssessment(
        int256 btc, int256 eth, int256 oldSize, uint8 market, int256 baseDelta,
        uint256 executionPrice, uint256 bid, uint256 ask
    ) public pure returns (uint256 notional, int256 requiredImpact, int256 deliveredImpact, bool reduces) {
        uint256 absoluteBase = abs(baseDelta);
        notional = absoluteBase * executionPrice / 1e18;
        uint256 mark = (bid + ask) / 2;
        requiredImpact = impactCost(btc, eth, market, baseDelta * int256(mark) / 1e18);
        deliveredImpact = baseDelta > 0
            ? int256(absoluteBase * executionPrice / 1e18) - int256(absoluteBase * ask / 1e18)
            : int256(absoluteBase * bid / 1e18) - int256(absoluteBase * executionPrice / 1e18);
        int256 next = oldSize + baseDelta;
        reduces = oldSize != 0 && abs(next) < abs(oldSize) && (next == 0 || (next > 0) == (oldSize > 0));
    }

    function stressLoss(int256 btc, int256 eth) public pure returns (uint256) {
        int256 best;
        best = max(best, scenario(btc, eth, 20, 25));
        best = max(best, scenario(btc, eth, -20, -25));
        best = max(best, scenario(btc, eth, 15, -20));
        best = max(best, scenario(btc, eth, -15, 20));
        best = max(best, scenario(btc, eth, 40, 50));
        best = max(best, scenario(btc, eth, -40, -50));
        return uint256(best);
    }

    function marginRate(uint256 notional, bool initial) public pure returns (uint256) {
        if (notional <= 25_000e6) return initial ? 2_000 : 1_200;
        if (notional <= 100_000e6) return initial ? 2_500 : 1_500;
        if (notional <= 250_000e6) return initial ? 3_300 : 2_000;
        if (notional <= 1_000_000e6) return initial ? 5_000 : 3_000;
        if (notional <= 2_500_000e6) return initial ? 6_700 : 4_000;
        if (notional <= 5_000_000e6) return initial ? 10_000 : 6_000;
        return type(uint256).max;
    }

    function liquidationClose(int256 size, uint256 mark, int256 equity) public pure returns (uint256 closed) {
        uint256 absoluteBase = uint256(size < 0 ? -size : size);
        uint256 notional = absoluteBase * mark / 1e18;
        if (notional <= 10_000e6 || equity <= 0) return absoluteBase;
        uint256 shortfall = 2_200 * notional > uint256(equity) * 10_000
            ? 2_200 * notional - uint256(equity) * 10_000 : 0;
        uint256 neededNotional = (shortfall + 2_149) / 2_150;
        uint256 closeNotional = neededNotional < notional / 4 ? neededNotional : notional / 4;
        closed = (closeNotional * 1e18 + mark - 1) / mark;
        if (closed > absoluteBase) closed = absoluteBase;
    }

    function liquidationCharge(uint256 closed, uint256 mark, uint256 available) public pure returns (uint256 penalty, uint256 reward) {
        penalty = closed * mark / 1e18 * 50 / 10_000;
        if (penalty > available) penalty = available;
        reward = closed * mark / 1e18 * 10 / 10_000;
        if (reward > penalty / 5) reward = penalty / 5;
    }

    /// @notice Computes a position's next size, entry price and realized PnL without touching custody state.
    function positionTransition(int256 oldSize, uint256 oldEntry, int256 delta, uint256 price)
        public pure returns (int256 nextSize, uint256 nextEntry, int256 realizedPnl)
    {
        nextSize = oldSize + delta;
        if (oldSize == 0 || (oldSize > 0) == (delta > 0)) {
            uint256 combined = abs(nextSize);
            nextEntry = combined == 0 ? 0 : (abs(oldSize) * oldEntry + abs(delta) * price) / combined;
            return (nextSize, nextEntry, 0);
        }
        uint256 closed = abs(delta) < abs(oldSize) ? abs(delta) : abs(oldSize);
        realizedPnl = oldSize > 0
            ? int256(closed * price / 1e18) - int256(closed * oldEntry / 1e18)
            : int256(closed * oldEntry / 1e18) - int256(closed * price / 1e18);
        nextEntry = nextSize == 0 ? 0 : (nextSize > 0) != (oldSize > 0) ? price : oldEntry;
    }

    function positionPnl(int256 size, uint256 entryPrice, uint256 mark) public pure returns (int256) {
        if (size == 0) return 0;
        uint256 quantity = abs(size);
        return size > 0
            ? int256(quantity * mark / 1e18) - int256(quantity * entryPrice / 1e18)
            : int256(quantity * entryPrice / 1e18) - int256(quantity * mark / 1e18);
    }

    function fundingStep(
        int256 aggregateBase, uint256 mark, int256 currentIndex, uint64 fundingTime,
        uint64 currentTime, uint256 maxMarketNotional
    ) public pure returns (int256 nextIndex, uint64 nextFundingTime) {
        uint256 elapsed = currentTime - fundingTime;
        if (elapsed == 0) return (currentIndex, fundingTime);
        if (elapsed > 7 days) elapsed = 7 days;
        int256 skewNotional = aggregateBase * int256(mark) / 1e18;
        int256 apr = skewNotional * RATE / int256(maxMarketNotional);
        if (apr > RATE) apr = RATE;
        if (apr < -RATE) apr = -RATE;
        nextIndex = currentIndex + int256(mark) * apr * int256(elapsed) / (RATE * int256(365 days));
        nextFundingTime = fundingTime + uint64(elapsed);
    }

    function scenario(int256 btc, int256 eth, int256 btcReturn, int256 ethReturn) private pure returns (int256) {
        return floorDiv(btc * btcReturn, 100) + floorDiv(eth * ethReturn, 100);
    }

    function max(int256 a, int256 b) private pure returns (int256) { return a > b ? a : b; }
    function abs(int256 value) private pure returns (uint256) { return uint256(value < 0 ? -value : value); }
    function floorDiv(int256 numerator, int256 denominator) private pure returns (int256 quotient) {
        quotient = numerator / denominator;
        if (numerator < 0 && numerator % denominator != 0) --quotient;
    }
}
