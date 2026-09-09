// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract Mock1271Wallet {
    bytes4 private constant MAGIC_VALUE = 0x1626ba7e;
    address public immutable owner;

    constructor(address owner_) { owner = owner_; }

    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        return ECDSA.recover(digest, signature) == owner ? MAGIC_VALUE : bytes4(0xffffffff);
    }
}
