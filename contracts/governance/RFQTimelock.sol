// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @notice Production governance for RFQClearing: a timelock whose single proposer and executor is the
/// governance Safe. The delay is chosen at deployment (72 hours is the production recommendation).
/// @dev The Safe starts as admin so it can finish wiring, then renounces `DEFAULT_ADMIN_ROLE`, leaving the
/// timelock self-administered: later delay changes must themselves wait out the delay.
contract RFQTimelock is TimelockController {
    constructor(uint256 minDelay, address governanceSafe)
        TimelockController(minDelay, _singleton(governanceSafe), _singleton(governanceSafe), governanceSafe)
    {}

    function _singleton(address account) private pure returns (address[] memory values) {
        values = new address[](1);
        values[0] = account;
    }
}
