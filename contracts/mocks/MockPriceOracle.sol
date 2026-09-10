// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import "../interfaces/IPriceOracle.sol";

contract MockPriceOracle is IPriceOracle {
    function verify(bytes calldata report) external payable returns (Observation memory) {
        return abi.decode(report, (Observation));
    }
}

