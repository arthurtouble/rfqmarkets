// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import "../interfaces/IPriceOracle.sol";

interface IVerifierProxy {
    function verify(bytes calldata payload, bytes calldata parameterPayload) external payable returns (bytes memory verifierResponse);
}

/// @notice Narrow adapter for Chainlink crypto Data Streams report schema v3.
/// @dev Feed IDs, decimals and verifier proxy must be verified for the deployment chain.
contract ChainlinkDataStreamsV3Adapter is IPriceOracle {
    struct ReportV3 {
        bytes32 feedId;
        uint32 validFromTimestamp;
        uint32 observationsTimestamp;
        uint192 nativeFee;
        uint192 linkFee;
        uint32 expiresAt;
        int192 price;
        int192 bid;
        int192 ask;
    }

    IVerifierProxy public immutable verifier;
    address public immutable clearing;
    bytes32[2] public feedIds;
    uint8[2] public feedDecimals;

    error InvalidReport();
    error Unauthorized();

    constructor(address verifier_, address clearing_, bytes32[2] memory feedIds_, uint8[2] memory feedDecimals_) {
        if (verifier_ == address(0) || clearing_ == address(0) || feedIds_[0] == feedIds_[1]) revert InvalidReport();
        verifier = IVerifierProxy(verifier_);
        clearing = clearing_;
        feedIds = feedIds_;
        feedDecimals = feedDecimals_;
    }

    function verify(bytes calldata report) external payable returns (Observation memory observation) {
        if (msg.sender != clearing) revert Unauthorized();
        bytes memory verified = verifier.verify{value: msg.value}(report, bytes(""));
        ReportV3 memory decoded = abi.decode(verified, (ReportV3));
        uint8 market;
        if (decoded.feedId == feedIds[0]) market = 0;
        else if (decoded.feedId == feedIds[1]) market = 1;
        else revert InvalidReport();
        if (decoded.bid <= 0 || decoded.ask <= 0 || decoded.price <= 0 || decoded.ask < decoded.bid) revert InvalidReport();
        observation = Observation({
            market: market,
            bid: _toUsdc(uint256(int256(decoded.bid)), feedDecimals[market]),
            ask: _toUsdc(uint256(int256(decoded.ask)), feedDecimals[market]),
            observedAt: decoded.observationsTimestamp,
            validUntil: decoded.expiresAt
        });
    }

    function _toUsdc(uint256 value, uint8 decimals_) private pure returns (uint256) {
        if (decimals_ == 6) return value;
        if (decimals_ > 6) return value / (10 ** (decimals_ - 6));
        return value * (10 ** (6 - decimals_));
    }
}

