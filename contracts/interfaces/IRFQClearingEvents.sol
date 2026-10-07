// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @notice Every event the clearing proxy emits. Linked libraries emit these from the proxy's context
/// (`emit IRFQClearingEvents.X(...)`), and RFQClearing inherits the interface so its ABI lists them all.
interface IRFQClearingEvents {
    event Deposited(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event NonceCancelled(address indexed account, uint256 indexed nonce);
    event PositionClosed(address indexed account, uint8 indexed market, int256 baseDelta, uint256 price);
    event TradeExecuted(
        bytes32 indexed intentHash, address indexed account, uint8 market, int256 baseDelta, uint256 price, uint256 fee
    );
    event FundingSettled(address indexed account, uint8 indexed market, int256 payment);
    event Liquidated(address indexed account, uint8 market, uint256 closedBase, uint256 penalty, uint256 keeperReward);
    event DeficitAbsorbed(address indexed account, uint256 insuranceUsed, uint256 makerUsed, uint256 unresolved);
    event SessionGranted(
        address indexed account, address indexed session, uint64 validUntil, uint128 maxCumulativeNotional
    );
    event SessionRevoked(address indexed account, address indexed session);

    event MakerFunded(address indexed from, uint256 amount);
    event InsuranceFunded(address indexed from, uint256 amount);
    event MakerWithdrawn(address indexed recipient, uint256 amount);

    event EpochAdvanced(uint64 epoch);
    event PauseChanged(bool paused);
    event MarketPolicyUpdated(
        uint8 indexed market, bool enabled, uint128 maxTradeNotional, uint128 maxMarketNotional, uint64 policyVersion
    );
    event ExposurePolicyUpdated(uint8 indexed market, uint128 grossLimit, uint128 sideLimit);
    event OracleUpdated(address indexed oracle);
    event ApproversRotated(address[3] approvers, uint64 signerSetVersion);
    event GovernanceTransferStarted(address indexed current, address indexed pending);
    event GovernanceTransferred(address indexed previous, address indexed current);
    event EmergencyCouncilUpdated(address indexed emergencyCouncil);

    event MakerIncidentReported(uint64 since);
    event MakerIncidentCleared();
    event MakerIncidentGracePeriodUpdated(uint64 gracePeriod);
    event ResolutionStarted(uint64 triggerTime);
    event ResolutionPriceReady(uint8 indexed market, uint256 price);
    event ResolutionFinalized(uint256 claims, uint256 assets);
    event ResolutionClaimed(address indexed account, uint256 amount);
    event ResolutionRecoveryAdded(address indexed from, uint256 amount);
    event ResolutionSurplusWithdrawn(address indexed recipient, uint256 amount);
}
