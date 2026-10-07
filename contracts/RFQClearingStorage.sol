// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import "./RFQTypes.sol";

/// @notice ERC-7201 namespaced storage shared by the clearing proxy and its linked libraries.
/// @dev Declared in a contract that RFQClearing inherits so OpenZeppelin's upgrade validator checks the
/// namespace layout. Append new fields at the end of `Layout`; never reorder or remove existing ones.
abstract contract RFQClearingNamespace {
    /// @custom:storage-location erc7201:rfq.clearing.v1
    struct Layout {
        // Wiring and roles
        IERC20 usdc;
        IPriceOracle oracle;
        address governance;
        address pendingGovernance;
        address emergencyCouncil;
        address[3] approvers;
        mapping(address => bool) isApprover;
        // Accounts
        mapping(address => Account) accounts;
        mapping(address => bool) accountRegistered;
        address[] accountList;
        mapping(address => mapping(uint256 => bool)) nonceUsed;
        mapping(address => Session) sessions;
        // Markets and risk
        Market[2] markets;
        MarketLimits[2] limits;
        ExposureBook[2] exposure;
        // Capital buckets; their sum always equals the USDC balance until resolution finalizes
        uint256 makerBacking;
        uint256 insuranceBalance;
        int256 totalCustomerCollateral;
        uint256 baseRiskCapitalTarget; // opening floor for maker backing
        // Fencing versions bound into every maker approval
        uint64 leaderEpoch;
        uint64 signerSetVersion;
        uint64 policyVersion;
        // Lifecycle
        bool paused;
        bool resolutionRequired;
        uint64 makerIncidentSince;
        uint64 makerIncidentGracePeriod;
        ResolutionState resolution;
        // Appended after the first v1 deployment.
        int256[2] costBasis; // per market: sum of size * entryPrice / 1e18 over open positions
    }
}

/// @notice Accessor for the clearing namespace.
/// @dev Libraries run by DELEGATECALL in the proxy's context, so `layout()` resolves to proxy storage.
library RFQClearingStorage {
    // keccak256(abi.encode(uint256(keccak256("rfq.clearing.v1")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant SLOT = 0x380d1b904479cc040b615065b149573a5f65fb6ce8d21382c296a05a0cc86d00;

    function layout() internal pure returns (RFQClearingNamespace.Layout storage $) {
        assembly {
            $.slot := SLOT
        }
    }
}
