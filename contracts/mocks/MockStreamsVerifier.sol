// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

contract MockStreamsVerifier {
    bytes public response;

    function setResponse(bytes calldata value) external {
        response = value;
    }

    function verify(bytes calldata, bytes calldata) external payable returns (bytes memory) {
        return response;
    }
}

