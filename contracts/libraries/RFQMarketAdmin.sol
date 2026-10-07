// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IRFQClearingEvents} from "../interfaces/IRFQClearingEvents.sol";
import {RFQClearingNamespace, RFQClearingStorage} from "../RFQClearingStorage.sol";
import {RFQLedger} from "./RFQLedger.sol";
import "../RFQTypes.sol";

/// @notice Market listing and configuration: limits, exposure caps, risk parameters, spreads and the
/// risk operator's authority over them.
/// @dev Linked library run by DELEGATECALL from RFQClearing, so `msg.sender` is the clearing's caller.
///
/// Who may change what:
/// - governance: anything, within the contract's absolute limits.
/// - risk operator: list markets and change any market setting at once. A change that tightens is always
///   allowed; one that loosens must stay within `RiskOperatorBounds`.
/// - emergency council: disable a market (reduce-only) and tighten its limits, nothing else.
library RFQMarketAdmin {
    /// @notice Registers a market with the next id. No role check: callers authorize first.
    function registerMarket(MarketConfig calldata config) public returns (uint8 market) {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        market = $.marketCount;
        if (market >= MAX_MARKETS || config.symbol == bytes32(0) || $.marketIdPlusOne[config.symbol] != 0) {
            revert InvalidConfiguration();
        }
        validateLimits(config.maxTradeNotional, config.maxMarketNotional);
        validateExposureLimits(config.grossLimit, config.sideLimit);
        validateRisk(config.impactK, config.shockBps, config.marginScaleBps);
        $.marketCount = market + 1;
        $.marketIdPlusOne[config.symbol] = market + 1;
        $.marketParams[market] = MarketParams(config.symbol, config.impactK, config.shockBps, config.marginScaleBps);
        $.markets[market].enabled = config.enabled;
        $.markets[market].fundingTime = uint64(block.timestamp);
        $.limits[market] = MarketLimits(config.maxTradeNotional, config.maxMarketNotional);
        $.exposure[market].grossLimit = config.grossLimit;
        $.exposure[market].sideLimit = config.sideLimit;
        emit IRFQClearingEvents.MarketAdded(market, config.symbol);
        emit IRFQClearingEvents.MarketPolicyUpdated(
            market, config.enabled, config.maxTradeNotional, config.maxMarketNotional, $.policyVersion
        );
        emit IRFQClearingEvents.ExposurePolicyUpdated(market, config.grossLimit, config.sideLimit);
        emit IRFQClearingEvents.MarketRiskUpdated(
            market, config.impactK, config.shockBps, config.marginScaleBps, $.policyVersion
        );
    }

    /// @notice Governance or the risk operator (within its bounds) lists a market.
    function addMarket(MarketConfig calldata config) public returns (uint8 market) {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        if ($.resolutionRequired) revert InvalidTrade();
        if (msg.sender != $.governance) {
            if (msg.sender != $.riskOperator) revert Unauthorized();
            RiskOperatorBounds storage bounds = $.riskOperatorBounds;
            if (
                config.maxTradeNotional > bounds.maxTradeNotional
                    || config.maxMarketNotional > bounds.maxMarketNotional
                    || config.grossLimit > bounds.maxGrossLimit || config.impactK < bounds.minImpactK
                    || config.shockBps < bounds.minShockBps || config.marginScaleBps < bounds.minMarginScaleBps
            ) revert Unauthorized();
        }
        market = registerMarket(config);
        ++$.policyVersion;
    }

    function setMarketPolicy(uint8 market, bool enabled, uint128 maxTradeNotional, uint128 maxMarketNotional)
        public
    {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        if (market >= $.marketCount) revert InvalidTrade();
        validateLimits(maxTradeNotional, maxMarketNotional);
        MarketLimits storage limits = $.limits[market];
        if (msg.sender != $.governance) {
            bool loosens =
                maxTradeNotional > limits.maxTradeNotional || maxMarketNotional > limits.maxMarketNotional;
            if (msg.sender == $.riskOperator) {
                RiskOperatorBounds storage bounds = $.riskOperatorBounds;
                if (
                    loosens
                        && (maxTradeNotional > bounds.maxTradeNotional
                            || maxMarketNotional > bounds.maxMarketNotional)
                ) revert Unauthorized();
            } else if (msg.sender != $.emergencyCouncil || enabled || loosens) {
                revert Unauthorized();
            }
        }
        // The net limit is the funding-rate denominator: accrue at the old rate before changing it.
        if (!$.resolutionRequired) RFQLedger.updateFunding(market);
        $.markets[market].enabled = enabled;
        $.limits[market] = MarketLimits(maxTradeNotional, maxMarketNotional);
        uint64 version = ++$.policyVersion;
        emit IRFQClearingEvents.MarketPolicyUpdated(market, enabled, maxTradeNotional, maxMarketNotional, version);
    }

    function setExposurePolicy(uint8 market, uint128 grossLimit, uint128 sideLimit) public {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        if ($.resolutionRequired || market >= $.marketCount) revert InvalidTrade();
        validateExposureLimits(grossLimit, sideLimit);
        ExposureBook storage book = $.exposure[market];
        if (msg.sender != $.governance) {
            bool loosens = grossLimit > book.grossLimit || sideLimit > book.sideLimit;
            if (msg.sender == $.riskOperator) {
                if (loosens && grossLimit > $.riskOperatorBounds.maxGrossLimit) revert Unauthorized();
            } else if (msg.sender != $.emergencyCouncil || loosens) {
                revert Unauthorized();
            }
        }
        book.grossLimit = grossLimit;
        book.sideLimit = sideLimit;
        ++$.policyVersion;
        emit IRFQClearingEvents.ExposurePolicyUpdated(market, grossLimit, sideLimit);
    }

    function setMarketRisk(uint8 market, uint32 impactK, uint16 shockBps, uint16 marginScaleBps) public {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        if (market >= $.marketCount || $.resolutionRequired) revert InvalidTrade();
        validateRisk(impactK, shockBps, marginScaleBps);
        MarketParams storage params = $.marketParams[market];
        if (msg.sender != $.governance) {
            if (msg.sender != $.riskOperator) revert Unauthorized();
            RiskOperatorBounds storage bounds = $.riskOperatorBounds;
            if (
                (impactK < params.impactK && impactK < bounds.minImpactK)
                    || (shockBps < params.shockBps && shockBps < bounds.minShockBps)
                    || (marginScaleBps < params.marginScaleBps && marginScaleBps < bounds.minMarginScaleBps)
            ) revert Unauthorized();
        }
        params.impactK = impactK;
        params.shockBps = shockBps;
        params.marginScaleBps = marginScaleBps;
        uint64 version = ++$.policyVersion;
        emit IRFQClearingEvents.MarketRiskUpdated(market, impactK, shockBps, marginScaleBps, version);
    }

    /// @notice Sets one market's base spread (`market` < marketCount) or the default (`market` == 255).
    function setSpread(uint8 market, uint16 baseSpreadBps) public {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        if (msg.sender != $.governance && msg.sender != $.riskOperator) revert Unauthorized();
        if (baseSpreadBps != 0 && (baseSpreadBps < MIN_BASE_SPREAD_BPS || baseSpreadBps > MAX_BASE_SPREAD_BPS)) {
            revert InvalidConfiguration();
        }
        if (market == type(uint8).max) {
            $.defaultSpreadBps = baseSpreadBps;
            emit IRFQClearingEvents.DefaultSpreadUpdated(baseSpreadBps);
        } else {
            if (market >= $.marketCount) revert InvalidTrade();
            $.marketSpreadBps[market] = baseSpreadBps;
            emit IRFQClearingEvents.MarketSpreadUpdated(market, baseSpreadBps);
        }
    }

    /// @dev Margin may scale from 0.25x (20x leverage in the first tier) to 5x the base tiers; the stress shock
    /// must be a real move.
    function validateRisk(uint32 impactK, uint16 shockBps, uint16 marginScaleBps) private pure {
        if (
            impactK == 0 || impactK > 1_000_000 || shockBps < 500 || shockBps > 10_000
                || marginScaleBps < MIN_MARGIN_SCALE_BPS || marginScaleBps > MAX_MARGIN_SCALE_BPS
        ) revert InvalidConfiguration();
    }

    function validateLimits(uint128 maxTradeNotional, uint128 maxMarketNotional) private pure {
        if (
            maxTradeNotional == 0 || maxTradeNotional > maxMarketNotional
                || maxTradeNotional > ABSOLUTE_MAX_TRADE_NOTIONAL || maxMarketNotional > ABSOLUTE_MAX_MARKET_NOTIONAL
        ) revert InvalidTrade();
    }

    function validateExposureLimits(uint128 grossLimit, uint128 sideLimit) private pure {
        if (sideLimit == 0 || sideLimit > grossLimit || grossLimit > ABSOLUTE_MAX_MARKET_NOTIONAL) {
            revert InvalidTrade();
        }
    }
}
