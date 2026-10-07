// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {RFQClearingNamespace, RFQClearingStorage} from "./RFQClearingStorage.sol";
import {IRFQClearingEvents} from "./interfaces/IRFQClearingEvents.sol";
import {RFQLedger} from "./libraries/RFQLedger.sol";
import {RFQLiquidation} from "./libraries/RFQLiquidation.sol";
import {RFQResolution} from "./libraries/RFQResolution.sol";
import {RFQRiskMath} from "./libraries/RFQRiskMath.sol";
import {RFQSettlement} from "./libraries/RFQSettlement.sol";
import {RFQSignatureVerifier} from "./libraries/RFQSignatureVerifier.sol";
import "./RFQTypes.sol";

interface IERC3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title RFQ Markets clearing house
/// @notice Custody and clearing for USDC-margined BTC and ETH perpetuals filled by request-for-quote.
/// The protocol's maker is the only counterparty. Every fill needs the trader's signature (or a scoped
/// session key) plus two of three approvers, and this contract re-checks price limits, the
/// inventory-impact floor, exposure caps, stress loss and margin before applying it.
///
/// Roles:
/// - `governance` unpauses, upgrades (through the ProxyAdmin it owns), rotates approvers, sets the oracle,
///   loosens limits and moves maker capital. It is any address: an EOA or Safe while the venue is in
///   development, a timelock in production. Handover is two-step (`transferGovernance` / `acceptGovernance`).
/// - `emergencyCouncil` pauses, fences approvals and disables or tightens markets. It cannot unpause.
/// - Anyone may liquidate, refresh prices, top up maker or insurance capital and run resolution steps.
///
/// The proxy is deployed paused with the launch caps passed to `initialize`.
/// @custom:oz-upgrades
contract RFQClearing is IRFQClearingEvents, RFQClearingNamespace, Initializable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    // =======================================================================
    // Setup
    // =======================================================================

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Starts the venue paused, with the given launch limits. Governance unpauses when ready.
    function initialize(
        address usdc_,
        address oracle_,
        address governance_,
        address emergencyCouncil_,
        address[3] calldata approvers_,
        uint256 baseRiskCapitalTarget_,
        MarketConfig[2] calldata markets_
    ) external initializer {
        if (
            usdc_ == address(0) || oracle_ == address(0) || governance_ == address(0) || emergencyCouncil_ == address(0)
                || governance_ == emergencyCouncil_ || baseRiskCapitalTarget_ == 0
        ) revert InvalidConfiguration();
        RFQClearingNamespace.Layout storage $ = _s();
        $.usdc = IERC20(usdc_);
        $.oracle = IPriceOracle(oracle_);
        $.governance = governance_;
        $.emergencyCouncil = emergencyCouncil_;
        $.baseRiskCapitalTarget = baseRiskCapitalTarget_;
        $.leaderEpoch = 1;
        $.signerSetVersion = 1;
        $.policyVersion = 1;
        $.paused = true;
        $.makerIncidentGracePeriod = DEFAULT_INCIDENT_GRACE_PERIOD;
        for (uint8 i; i < MARKET_COUNT; ++i) {
            MarketConfig calldata config = markets_[i];
            _validateLimits(config.maxTradeNotional, config.maxMarketNotional);
            _validateExposureLimits(config.grossLimit, config.sideLimit);
            $.markets[i].enabled = config.enabled;
            $.markets[i].fundingTime = uint64(block.timestamp);
            $.limits[i] = MarketLimits(config.maxTradeNotional, config.maxMarketNotional);
            $.exposure[i].grossLimit = config.grossLimit;
            $.exposure[i].sideLimit = config.sideLimit;
        }
        RFQRiskMath.setApprovers(approvers_);
        emit GovernanceTransferred(address(0), governance_);
        emit EmergencyCouncilUpdated(emergencyCouncil_);
        emit PauseChanged(true);
    }

    modifier onlyGovernance() {
        if (msg.sender != _s().governance) revert Unauthorized();
        _;
    }

    modifier onlyEmergencyOrGovernance() {
        RFQClearingNamespace.Layout storage $ = _s();
        if (msg.sender != $.governance && msg.sender != $.emergencyCouncil) revert Unauthorized();
        _;
    }

    // =======================================================================
    // Collateral
    // =======================================================================

    function deposit(uint256 amount) external nonReentrant {
        _pull(amount);
        _creditDeposit(msg.sender, amount);
    }

    /// @notice Gas-sponsored deposit using native USDC's EIP-3009 `receiveWithAuthorization`.
    function depositWithAuthorization(
        address from,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 authorizationNonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        RFQClearingNamespace.Layout storage $ = _s();
        if (amount == 0 || $.resolutionRequired) revert InvalidTrade();
        IERC20 usdc_ = $.usdc;
        uint256 beforeBalance = usdc_.balanceOf(address(this));
        IERC3009(address(usdc_))
            .receiveWithAuthorization(from, address(this), amount, validAfter, validBefore, authorizationNonce, v, r, s);
        if (usdc_.balanceOf(address(this)) - beforeBalance != amount) revert InvalidTrade();
        _creditDeposit(from, amount);
    }

    function withdraw(uint256 amount) external nonReentrant {
        RFQSettlement.withdraw(msg.sender, msg.sender, amount);
    }

    /// @notice Gas-sponsored withdrawal authorized by the collateral owner's signature.
    function withdrawWithSignature(
        address account,
        address recipient,
        uint256 amount,
        uint256 nonce,
        uint64 deadline,
        bytes calldata signature
    ) external nonReentrant {
        RFQSignatureVerifier.consumeOwnerAuthorization(
            account,
            nonce,
            deadline,
            keccak256(abi.encode(WITHDRAWAL_TYPEHASH, account, recipient, amount, nonce, deadline)),
            signature
        );
        RFQSettlement.withdraw(account, recipient, amount);
    }

    /// @notice Adds maker backing. Anyone may top up.
    function fundMaker(uint256 amount) external nonReentrant {
        _pull(amount);
        _s().makerBacking += amount;
        emit MakerFunded(msg.sender, amount);
    }

    /// @notice Adds to the insurance fund. Anyone may top up.
    function fundInsurance(uint256 amount) external nonReentrant {
        _pull(amount);
        _s().insuranceBalance += amount;
        emit InsuranceFunded(msg.sender, amount);
    }

    /// @notice Releases maker capital. What remains, after setting aside customers' unrealized gains, must
    /// cover both the opening floor and four times the live stress loss.
    function withdrawMakerExcess(address recipient, uint256 amount) external onlyGovernance nonReentrant {
        RFQClearingNamespace.Layout storage $ = _s();
        if ($.resolutionRequired || recipient == address(0) || amount == 0 || amount > $.makerBacking) {
            revert InvalidTrade();
        }
        uint256 remaining = $.makerBacking - amount;
        uint256 owed = RFQRiskMath.customerUnrealizedGain();
        if (remaining < $.baseRiskCapitalTarget + owed) revert Margin();
        (int256 btc, int256 eth) = RFQRiskMath.portfolioExposure();
        if (RFQRiskMath.stressLoss(btc, eth) > (remaining - owed) / 4) revert Margin();
        $.makerBacking = remaining;
        $.usdc.safeTransfer(recipient, amount);
        emit MakerWithdrawn(recipient, amount);
    }

    // =======================================================================
    // Nonces and sessions
    // =======================================================================

    /// @notice Invalidates a trade or action nonce without trusting the API.
    function cancelNonce(uint256 nonce) external {
        mapping(uint256 => bool) storage used = _s().nonceUsed[msg.sender];
        if (used[nonce]) revert Replay();
        used[nonce] = true;
        emit NonceCancelled(msg.sender, nonce);
    }

    /// @notice Gas-sponsored nonce cancellation authorized by the account owner.
    function cancelNonceWithSignature(address account, uint256 nonce, uint64 deadline, bytes calldata signature)
        external
    {
        RFQSignatureVerifier.consumeOwnerAuthorization(
            account, nonce, deadline, keccak256(abi.encode(CANCEL_TYPEHASH, account, nonce, deadline)), signature
        );
        emit NonceCancelled(account, nonce);
    }

    /// @notice Registers a scoped session key that can sign trade intents for the account.
    function grantSessionWithSignature(SessionGrant calldata grant, bytes calldata signature) external {
        bytes32 structHash = keccak256(
            abi.encode(
                SESSION_GRANT_TYPEHASH,
                grant.account,
                grant.session,
                grant.marketMask,
                grant.maxTradeNotional,
                grant.maxCumulativeNotional,
                grant.maxFee,
                grant.validUntil,
                grant.nonce,
                grant.deadline
            )
        );
        RFQSignatureVerifier.consumeOwnerAuthorization(
            grant.account, grant.nonce, grant.deadline, structHash, signature
        );
        RFQRiskMath.validateSessionConfiguration(grant);
        _s().sessions[grant.session] = Session(
            grant.account,
            grant.validUntil,
            grant.marketMask,
            grant.maxTradeNotional,
            grant.maxCumulativeNotional,
            0,
            grant.maxFee
        );
        emit SessionGranted(grant.account, grant.session, grant.validUntil, grant.maxCumulativeNotional);
    }

    function revokeSession(address session) external {
        RFQClearingNamespace.Layout storage $ = _s();
        if ($.sessions[session].account != msg.sender) revert Unauthorized();
        delete $.sessions[session];
        emit SessionRevoked(msg.sender, session);
    }

    // =======================================================================
    // Trading
    // =======================================================================

    /// @notice Settles an RFQ fill. Anyone may relay it; authority comes only from the signatures.
    function executeTrade(
        TradeIntent calldata intent,
        MakerApproval calldata approval,
        bytes calldata report,
        bytes calldata userSignature,
        bytes calldata makerSignatureOne,
        bytes calldata makerSignatureTwo
    ) external payable nonReentrant {
        RFQSettlement.executeTrade(intent, approval, report, userSignature, makerSignatureOne, makerSignatureTwo);
    }

    /// @notice Records a fresh oracle report and accrues funding. Older reports never overwrite newer ones.
    function refreshOracle(bytes calldata report)
        external
        payable
        nonReentrant
        returns (IPriceOracle.Observation memory observation)
    {
        if (_s().resolutionRequired) revert InvalidTrade();
        observation = RFQLedger.touchOracle(report, type(uint8).max);
    }

    /// @notice Owner exit at the oracle side while trading is paused, without approvers.
    function closePosition(uint8 market, bytes calldata report) external payable nonReentrant {
        RFQLiquidation.closePosition(msg.sender, market, report);
    }

    /// @notice Gas-sponsored paused-market close authorized by the account owner.
    function closePositionWithSignature(
        address account,
        uint8 market,
        uint256 nonce,
        uint64 deadline,
        bytes calldata report,
        bytes calldata signature
    ) external payable nonReentrant {
        RFQSignatureVerifier.consumeOwnerAuthorization(
            account, nonce, deadline, keccak256(abi.encode(CLOSE_TYPEHASH, account, market, nonce, deadline)), signature
        );
        RFQLiquidation.closePosition(account, market, report);
    }

    // =======================================================================
    // Liquidation
    // =======================================================================

    /// @notice Liquidates an account below maintenance margin; see RFQLiquidation. Anyone may call.
    function liquidate(address account, uint8 market, bytes calldata report) external payable nonReentrant {
        RFQLiquidation.liquidate(account, market, report, msg.sender);
    }

    // =======================================================================
    // Governance and emergency controls
    // =======================================================================

    function pause() external onlyEmergencyOrGovernance {
        _s().paused = true;
        emit PauseChanged(true);
        RFQLedger.advanceEpoch();
    }

    function unpause() external onlyGovernance {
        RFQClearingNamespace.Layout storage $ = _s();
        if ($.resolutionRequired) revert Insolvent();
        $.paused = false;
        emit PauseChanged(false);
    }

    /// @notice Fences every outstanding approval. Compare-and-swap so concurrent fencers do not double-advance.
    function advanceLeaderEpoch(uint64 expectedEpoch) external onlyEmergencyOrGovernance {
        if (expectedEpoch != _s().leaderEpoch) revert Stale();
        RFQLedger.advanceEpoch();
    }

    function rotateApprovers(address[3] calldata next) external onlyGovernance {
        RFQClearingNamespace.Layout storage $ = _s();
        RFQRiskMath.setApprovers(next);
        ++$.signerSetVersion;
        emit ApproversRotated(next, $.signerSetVersion);
        RFQLedger.advanceEpoch();
    }

    /// @notice Replaces the oracle adapter. Allowed during resolution until its prices are fixed, so a broken
    /// feed cannot strand the wind-down.
    function setOracle(address next) external onlyGovernance {
        RFQClearingNamespace.Layout storage $ = _s();
        if ($.resolution.pricesReady || next == address(0)) revert InvalidConfiguration();
        $.oracle = IPriceOracle(next);
        ++$.policyVersion;
        emit OracleUpdated(next);
    }

    /// @notice Sets a market's per-trade and net limits. The emergency council may only disable the market
    /// while keeping or tightening limits; governance may change anything.
    function setMarketPolicy(uint8 market, bool enabled, uint128 maxTradeNotional, uint128 maxMarketNotional)
        external
        onlyEmergencyOrGovernance
    {
        RFQClearingNamespace.Layout storage $ = _s();
        if (market >= MARKET_COUNT) revert InvalidTrade();
        _validateLimits(maxTradeNotional, maxMarketNotional);
        MarketLimits storage limits = $.limits[market];
        if (
            msg.sender != $.governance
                && (enabled
                    || maxTradeNotional > limits.maxTradeNotional
                    || maxMarketNotional > limits.maxMarketNotional)
        ) revert Unauthorized();
        // The net limit is the funding-rate denominator: accrue at the old rate before changing it.
        if (!$.resolutionRequired) RFQLedger.updateFunding(market);
        $.markets[market].enabled = enabled;
        $.limits[market] = MarketLimits(maxTradeNotional, maxMarketNotional);
        uint64 version = ++$.policyVersion;
        emit MarketPolicyUpdated(market, enabled, maxTradeNotional, maxMarketNotional, version);
    }

    /// @notice Sets a market's gross and per-side limits (valued at the ask). Only while paused.
    function setExposurePolicy(uint8 market, uint128 grossLimit, uint128 sideLimit) external onlyGovernance {
        RFQClearingNamespace.Layout storage $ = _s();
        if (!$.paused || $.resolutionRequired || market >= MARKET_COUNT) revert InvalidTrade();
        _validateExposureLimits(grossLimit, sideLimit);
        $.exposure[market].grossLimit = grossLimit;
        $.exposure[market].sideLimit = sideLimit;
        ++$.policyVersion;
        emit ExposurePolicyUpdated(market, grossLimit, sideLimit);
    }

    /// @notice First step of a governance handover. Pass zero to cancel a pending transfer.
    /// @dev Moving to production governance is: deploy a timelock, `transferGovernance(timelock)`, have the
    /// timelock call `acceptGovernance()`, and transfer the ProxyAdmin's ownership to the same timelock.
    function transferGovernance(address next) external onlyGovernance {
        RFQClearingNamespace.Layout storage $ = _s();
        $.pendingGovernance = next;
        emit GovernanceTransferStarted($.governance, next);
    }

    function acceptGovernance() external {
        RFQClearingNamespace.Layout storage $ = _s();
        address next = $.pendingGovernance;
        if (msg.sender != next || next == $.emergencyCouncil) revert Unauthorized();
        emit GovernanceTransferred($.governance, next);
        $.governance = next;
        $.pendingGovernance = address(0);
    }

    function setEmergencyCouncil(address next) external onlyGovernance {
        RFQClearingNamespace.Layout storage $ = _s();
        if (next == address(0) || next == $.governance) revert InvalidConfiguration();
        $.emergencyCouncil = next;
        emit EmergencyCouncilUpdated(next);
    }

    function setMakerIncidentGracePeriod(uint64 gracePeriod) external onlyGovernance {
        if (gracePeriod < MIN_INCIDENT_GRACE_PERIOD || gracePeriod > MAX_INCIDENT_GRACE_PERIOD) {
            revert InvalidConfiguration();
        }
        _s().makerIncidentGracePeriod = gracePeriod;
        emit MakerIncidentGracePeriodUpdated(gracePeriod);
    }

    // =======================================================================
    // Maker incidents and global resolution
    // =======================================================================

    /// @notice Starts the incident clock when maker backing is objectively short. Anyone may call.
    /// @dev Resolution is irreversible, so a dip below the opening floor only starts a grace period in which
    /// the maker can recapitalize. Trades that add risk are already blocked while backing is short.
    function reportMakerIncident() external {
        RFQResolution.reportMakerIncident();
    }

    /// @notice Stops the incident clock once the maker is healthy again. Anyone may call.
    function clearMakerIncident() external {
        RFQResolution.clearMakerIncident();
    }

    /// @notice Governance may resolve a paused venue. Anyone may resolve once a reported maker incident has
    /// lasted the full grace period and still holds.
    function declareResolution() external {
        RFQResolution.declareResolution(msg.sender);
    }

    function submitResolutionObservation(bytes calldata report) external payable nonReentrant {
        RFQResolution.submitObservation(report);
    }

    function processResolution(uint256 maxAccounts) external nonReentrant {
        RFQResolution.process(maxAccounts);
    }

    function claimResolution() external nonReentrant {
        RFQResolution.claim(msg.sender);
    }

    function addResolutionRecovery(uint256 amount) external nonReentrant {
        RFQResolution.addRecovery(msg.sender, amount);
    }

    /// @notice Returns assets beyond 100% of all claims (leftover maker and insurance capital).
    function withdrawResolutionSurplus(address recipient) external onlyGovernance nonReentrant {
        RFQResolution.withdrawSurplus(recipient);
    }

    // =======================================================================
    // Views
    // =======================================================================

    function usdc() external view returns (IERC20) {
        return _s().usdc;
    }

    function oracle() external view returns (IPriceOracle) {
        return _s().oracle;
    }

    function governance() external view returns (address) {
        return _s().governance;
    }

    function pendingGovernance() external view returns (address) {
        return _s().pendingGovernance;
    }

    function emergencyCouncil() external view returns (address) {
        return _s().emergencyCouncil;
    }

    function approvers(uint256 index) external view returns (address) {
        return _s().approvers[index];
    }

    function isApprover(address signer) external view returns (bool) {
        return _s().isApprover[signer];
    }

    function collateralOf(address account) external view returns (int256) {
        return _s().accounts[account].collateral;
    }

    function positionOf(address account, uint8 market) external view returns (Position memory) {
        return _s().accounts[account].positions[market];
    }

    function accountRegistered(address account) external view returns (bool) {
        return _s().accountRegistered[account];
    }

    function accountCount() external view returns (uint256) {
        return _s().accountList.length;
    }

    function nonceUsed(address account, uint256 nonce) external view returns (bool) {
        return _s().nonceUsed[account][nonce];
    }

    function sessions(address session) external view returns (Session memory) {
        return _s().sessions[session];
    }

    function markets(uint256 market)
        external
        view
        returns (
            int256 aggregateBase,
            int256 fundingIndex,
            uint64 fundingTime,
            uint64 lastPriceTime,
            uint256 lastBid,
            uint256 lastAsk,
            bool enabled
        )
    {
        Market storage m = _s().markets[market];
        return (m.aggregateBase, m.fundingIndex, m.fundingTime, m.lastPriceTime, m.lastBid, m.lastAsk, m.enabled);
    }

    function marketLimits(uint8 market) external view returns (MarketLimits memory) {
        return _s().limits[market];
    }

    /// @notice Per-trade limit in the low 128 bits, net market limit in the high 128 bits.
    function marketLimitWord(uint8 market) external view returns (uint256) {
        MarketLimits storage limits = _s().limits[market];
        return uint256(limits.maxTradeNotional) | (uint256(limits.maxMarketNotional) << 128);
    }

    /// @return longBase Gross customer long base.
    /// @return shortBase Gross customer short base.
    /// @return limits Gross limit in the low 128 bits, per-side limit in the high 128 bits.
    /// @return cursor Always 0; kept for interface compatibility with the pre-v1 migration cursor.
    /// @return ready Always true; v1 tracks exposure from the first trade.
    function exposureState(uint8 market)
        external
        view
        returns (uint256 longBase, uint256 shortBase, uint256 limits, uint256 cursor, bool ready)
    {
        if (market >= MARKET_COUNT) revert InvalidTrade();
        ExposureBook storage book = _s().exposure[market];
        return (book.longBase, book.shortBase, uint256(book.grossLimit) | (uint256(book.sideLimit) << 128), 0, true);
    }

    function makerBacking() external view returns (uint256) {
        return _s().makerBacking;
    }

    function insuranceBalance() external view returns (uint256) {
        return _s().insuranceBalance;
    }

    function totalCustomerCollateral() external view returns (int256) {
        return _s().totalCustomerCollateral;
    }

    function baseRiskCapitalTarget() external view returns (uint256) {
        return _s().baseRiskCapitalTarget;
    }

    function leaderEpoch() external view returns (uint64) {
        return _s().leaderEpoch;
    }

    function signerSetVersion() external view returns (uint64) {
        return _s().signerSetVersion;
    }

    function policyVersion() external view returns (uint64) {
        return _s().policyVersion;
    }

    function paused() external view returns (bool) {
        return _s().paused;
    }

    function resolutionRequired() external view returns (bool) {
        return _s().resolutionRequired;
    }

    function makerIncidentSince() external view returns (uint64) {
        return _s().makerIncidentSince;
    }

    function makerIncidentGracePeriod() external view returns (uint64) {
        return _s().makerIncidentGracePeriod;
    }

    function customerUnrealizedGain() external view returns (uint256) {
        return RFQRiskMath.customerUnrealizedGain();
    }

    function makerIncident() external view returns (bool) {
        return RFQRiskMath.makerIncident();
    }

    function maintenanceEquity(address account) external view returns (int256) {
        return RFQRiskMath.accountEquity(account, true);
    }

    function openingEquity(address account) external view returns (int256) {
        return RFQRiskMath.accountEquity(account, false);
    }

    function initialMargin(address account) external view returns (uint256) {
        return RFQRiskMath.accountMargin(account, true);
    }

    function maintenanceMargin(address account) external view returns (uint256) {
        return RFQRiskMath.accountMargin(account, false);
    }

    function resolutionTriggerTime() external view returns (uint64) {
        return _s().resolution.triggerTime;
    }

    function resolutionSampleCount(uint256 market) external view returns (uint8) {
        return _s().resolution.sampleCount[market];
    }

    function resolutionPrice(uint256 market) external view returns (uint256) {
        return _s().resolution.price[market];
    }

    function resolutionPricesReady() external view returns (bool) {
        return _s().resolution.pricesReady;
    }

    function resolutionCursor() external view returns (uint256) {
        return _s().resolution.cursor;
    }

    function totalResolutionClaims() external view returns (uint256) {
        return _s().resolution.totalClaims;
    }

    function resolutionAssets() external view returns (uint256) {
        return _s().resolution.assets;
    }

    function resolutionFinalized() external view returns (bool) {
        return _s().resolution.finalized;
    }

    function resolutionClaim(address account) external view returns (uint256) {
        return _s().resolution.claim[account];
    }

    function resolutionPaid(address account) external view returns (uint256) {
        return _s().resolution.paid[account];
    }

    // =======================================================================
    // Internals
    // =======================================================================

    function _s() private pure returns (RFQClearingNamespace.Layout storage) {
        return RFQClearingStorage.layout();
    }

    /// @dev Pulls exactly `amount` from the caller; deposits and top-ups stop once resolution starts.
    function _pull(uint256 amount) private {
        RFQClearingNamespace.Layout storage $ = _s();
        if (amount == 0 || $.resolutionRequired) revert InvalidTrade();
        RFQRiskMath.pullExact($.usdc, msg.sender, amount);
    }

    function _creditDeposit(address account, uint256 amount) private {
        RFQClearingNamespace.Layout storage $ = _s();
        if (!$.accountRegistered[account]) {
            if (amount < MIN_FIRST_DEPOSIT) revert InvalidTrade();
            $.accountRegistered[account] = true;
            $.accountList.push(account);
        }
        RFQLedger.changeCollateral(account, int256(amount));
        emit Deposited(account, amount);
    }

    function _validateLimits(uint128 maxTradeNotional, uint128 maxMarketNotional) private pure {
        if (
            maxTradeNotional == 0 || maxTradeNotional > maxMarketNotional
                || maxTradeNotional > ABSOLUTE_MAX_TRADE_NOTIONAL || maxMarketNotional > ABSOLUTE_MAX_MARKET_NOTIONAL
        ) revert InvalidTrade();
    }

    function _validateExposureLimits(uint128 grossLimit, uint128 sideLimit) private pure {
        if (sideLimit == 0 || sideLimit > grossLimit || grossLimit > ABSOLUTE_MAX_MARKET_NOTIONAL) {
            revert InvalidTrade();
        }
    }
}
