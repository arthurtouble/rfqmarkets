// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

contract MockPythCore {
    struct Price { int64 price; uint64 conf; int32 expo; uint256 publishTime; }
    uint256 public fee;
    mapping(bytes32 => Price) public prices;

    function setFee(uint256 next) external { fee = next; }
    function setPrice(bytes32 id, Price calldata next) external { prices[id] = next; }
    function getUpdateFee(bytes[] calldata) external view returns (uint256) { return fee; }
    function updatePriceFeeds(bytes[] calldata) external payable { require(msg.value == fee, "fee"); }
    function getPriceNoOlderThan(bytes32 id, uint256 age) external view returns (Price memory value) {
        value = prices[id]; require(value.publishTime + age >= block.timestamp, "stale");
    }
}
