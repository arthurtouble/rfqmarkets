// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import "../interfaces/IPriceOracle.sol";

interface IPythCore {
    struct Price { int64 price; uint64 conf; int32 expo; uint256 publishTime; }
    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256);
    function updatePriceFeeds(bytes[] calldata updateData) external payable;
    function getPriceNoOlderThan(bytes32 id, uint256 age) external view returns (Price memory);
}

/// @notice Pull-oracle fallback for deployments where Chainlink Data Streams is unavailable.
/// @dev The caller supplies authenticated Pyth update blobs; the adapter pays the exact update fee,
///      reads a price no older than the clearing house's freshness window, and uses confidence as BBO.
contract PythCoreAdapter is IPriceOracle {
    IPythCore public immutable pyth;
    address public immutable clearing;
    bytes32[2] public feedIds;

    error InvalidReport();
    error Unauthorized();
    error IncorrectFee(uint256 expected, uint256 received);

    constructor(address pyth_, address clearing_, bytes32[2] memory feedIds_) {
        if (pyth_ == address(0) || clearing_ == address(0) || feedIds_[0] == feedIds_[1]) revert InvalidReport();
        pyth = IPythCore(pyth_);
        clearing = clearing_;
        feedIds = feedIds_;
    }

    function updateFee(bytes calldata report) external view returns (uint256) {
        (, bytes[] memory updates) = abi.decode(report, (uint8, bytes[]));
        return pyth.getUpdateFee(updates);
    }

    function verify(bytes calldata report) external payable returns (Observation memory observation) {
        if (msg.sender != clearing) revert Unauthorized();
        (uint8 market, bytes[] memory updates) = abi.decode(report, (uint8, bytes[]));
        if (market > 1 || updates.length == 0) revert InvalidReport();
        uint256 fee = pyth.getUpdateFee(updates);
        if (msg.value != fee) revert IncorrectFee(fee, msg.value);
        pyth.updatePriceFeeds{value: fee}(updates);
        IPythCore.Price memory value = pyth.getPriceNoOlderThan(feedIds[market], 15);
        if (value.price <= 0 || value.conf >= uint64(value.price) || value.publishTime > type(uint64).max - 15) revert InvalidReport();
        int256 scale = int256(value.expo) + 6;
        if (scale < -18 || scale > 18) revert InvalidReport();
        uint256 center = uint256(uint64(value.price));
        observation = Observation({
            market: market,
            bid: _scale(center - value.conf, scale, false),
            ask: _scale(center + value.conf, scale, true),
            observedAt: uint64(value.publishTime),
            validUntil: uint64(value.publishTime + 15)
        });
        if (observation.bid == 0 || observation.ask < observation.bid) revert InvalidReport();
    }

    function _scale(uint256 value, int256 exponent, bool roundUp) private pure returns (uint256) {
        if (exponent >= 0) return value * (10 ** uint256(exponent));
        uint256 divisor = 10 ** uint256(-exponent);
        return roundUp ? (value + divisor - 1) / divisor : value / divisor;
    }
}
