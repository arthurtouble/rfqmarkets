// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract TestProxy is ERC1967Proxy {
    constructor(address implementation, bytes memory data) ERC1967Proxy(implementation, data) {}
}

