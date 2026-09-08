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

    function marginRate(uint256 notional, bool initial) internal pure returns (uint256) {
        if (notional <= 25_000e6) return initial ? 2_000 : 1_200;
        if (notional <= 50_000e6) return initial ? 2_500 : 1_500;
        if (notional <= 100_000e6) return initial ? 3_300 : 2_000;
        return type(uint256).max;
    }

    function scenario(int256 btc, int256 eth, int256 btcReturn, int256 ethReturn) private pure returns (int256) {
        return floorDiv(btc * btcReturn, 100) + floorDiv(eth * ethReturn, 100);
    }

    function max(int256 a, int256 b) private pure returns (int256) { return a > b ? a : b; }
    function floorDiv(int256 numerator, int256 denominator) private pure returns (int256 quotient) {
        quotient = numerator / denominator;
        if (numerator < 0 && numerator % denominator != 0) --quotient;
    }
}
