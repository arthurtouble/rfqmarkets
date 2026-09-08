// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

interface IPriceOracle {
    struct Observation {
        uint8 market;
        uint256 bid; // USDC micro-units per token
        uint256 ask;
        uint64 observedAt;
        uint64 validUntil;
    }

    function verify(bytes calldata report) external payable returns (Observation memory observation);
}

