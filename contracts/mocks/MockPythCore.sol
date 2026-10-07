// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

contract MockPythCore {
    struct Price {
        int64 price;
        uint64 conf;
        int32 expo;
        uint256 publishTime;
    }

    struct PriceFeed {
        bytes32 id;
        Price price;
        Price emaPrice;
    }
    uint256 public fee;
    mapping(bytes32 => Price) public prices;

    function setFee(uint256 next) external {
        fee = next;
    }

    function setPrice(bytes32 id, Price calldata next) external {
        prices[id] = next;
    }

    function getUpdateFee(bytes[] calldata) external view returns (uint256) {
        return fee;
    }

    function parsePriceFeedUpdates(bytes[] calldata, bytes32[] calldata ids, uint64 minimum, uint64 maximum)
        external
        payable
        returns (PriceFeed[] memory values)
    {
        require(msg.value == fee, "fee");
        values = new PriceFeed[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            Price memory value = prices[ids[i]];
            require(value.publishTime >= minimum && value.publishTime <= maximum, "range");
            values[i] = PriceFeed(ids[i], value, value);
        }
    }
}
