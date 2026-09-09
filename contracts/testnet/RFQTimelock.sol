// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import "@openzeppelin/contracts/governance/TimelockController.sol";

/// @notice Testnet governance delay controlled by a separately deployed Safe.
contract RFQTimelock is TimelockController {
    constructor(address governanceSafe)
        TimelockController(3 days, _singleton(governanceSafe), _singleton(governanceSafe), governanceSafe)
    {}

    function _singleton(address account) private pure returns (address[] memory values) {
        values = new address[](1);
        values[0] = account;
    }
}
