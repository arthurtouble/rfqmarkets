// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

interface IPriceOracle {
    struct Observation {
        uint8 market;
        uint256 bid; // USDC micro-units per market unit (1e18 base units)
        uint256 ask;
        uint64 observedAt;
        uint64 validUntil;
    }

    /// @notice Verifies a report and returns its prices, one observation per market it covers, in ascending
    /// market order with no duplicates. A report may cover any subset of the registered markets.
    function verify(bytes calldata report) external payable returns (Observation[] memory observations);
}
