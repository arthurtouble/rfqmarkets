// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import "../RFQClearing.sol";

contract RFQClearingV2 is RFQClearing {
    function implementationVersion() external pure returns (uint256) { return 2; }
}

