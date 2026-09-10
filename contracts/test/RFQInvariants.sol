// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import "../RFQAuthorization.sol";

/// @notice Stateless properties usable from any Solidity fuzz runner.
contract RFQInvariants {
    RFQAuthorization public immutable target;

    constructor() {
        target = new RFQAuthorization(address(this), [address(1), address(2), address(3)], 600_000e6);
    }

    function invariant_partitionCannotResetImpact(uint128 first, uint128 second) external view {
        int256 a = int256(uint256(first % 25_000e6));
        int256 b = int256(uint256(second % 25_000e6));
        int256 whole = target.impactCost(0, 0, 0, a + b);
        int256 split = target.impactCost(0, 0, 0, a)
            + target.impactCost(a, 0, 0, b);
        assert(whole == split);
    }

    function invariant_crossMarketPotentialIsNonnegative(int128 rawBtc, int128 rawEth) external view {
        int256 btc = int256(rawBtc) % int256(250_000e6);
        int256 eth = int256(rawEth) % int256(250_000e6);
        assert(target.potential(btc, eth) >= 0);
    }
}
