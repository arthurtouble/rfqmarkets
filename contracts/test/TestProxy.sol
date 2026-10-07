// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

contract TestProxy is TransparentUpgradeableProxy {
    constructor(address implementation, address initialOwner, bytes memory data)
        TransparentUpgradeableProxy(implementation, initialOwner, data)
    {}
}
