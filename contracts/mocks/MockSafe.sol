// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @notice Local rehearsal stand-in for a Safe: exposes owner/threshold views and forwards calls.
/// @dev Never deploy outside local chains. Anyone can call exec.
contract MockSafe {
    address[] private _owners;
    uint256 private _threshold;

    constructor(address[] memory owners_, uint256 threshold_) { _owners = owners_; _threshold = threshold_; }

    function getOwners() external view returns (address[] memory) { return _owners; }
    function getThreshold() external view returns (uint256) { return _threshold; }
    function exec(address to, bytes calldata data) external returns (bytes memory result) {
        bool ok; (ok, result) = to.call(data);
        if (!ok) assembly { revert(add(result, 32), mload(result)) }
    }
}
