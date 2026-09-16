// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "../interfaces/IPriceOracle.sol";
import "./RFQRiskMathBaseline.sol";

interface IERC3009Baseline {
    function receiveWithAuthorization(
        address from, address to, uint256 value, uint256 validAfter, uint256 validBefore,
        bytes32 nonce, uint8 v, bytes32 r, bytes32 s
    ) external;
}

/// @notice Frozen upgrade regression reference from commit 6c04310. It is deliberately capped at BTC/ETH.
/// @custom:oz-upgrades
contract RFQClearingBaseline is Initializable {
    using SafeERC20 for IERC20;

    uint256 internal constant BASE = 1e18;
    uint256 internal constant MAX_ORACLE_AGE = 15;
    uint256 internal constant MAX_WIDTH_BPS = 100;
    uint256 internal constant ABSOLUTE_MAX_TRADE_NOTIONAL = 1_000_000e6;
    uint256 internal constant ABSOLUTE_MAX_MARKET_NOTIONAL = 5_000_000e6;
    uint256 internal constant LIQUIDATION_PENALTY_BPS = 50;
    uint256 internal constant KEEPER_REWARD_BPS = 10;
    uint256 internal constant MAX_SESSION_DURATION = 30 days;
    bytes32 internal constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant NAME_HASH = keccak256("RFQ Markets");
    bytes32 internal constant VERSION_HASH = keccak256("1");

    bytes32 internal constant INTENT_TYPEHASH = keccak256(
        "TradeIntent(address account,uint8 market,int256 baseDelta,uint256 limitPrice,uint256 maxFee,uint256 nonce,uint64 deadline,bool reduceOnly)"
    );
    bytes32 internal constant APPROVAL_TYPEHASH = keccak256(
        "MakerApproval(bytes32 intentHash,uint256 executionPrice,int256 impactCharge,uint256 fee,bytes32 oracleReportHash,uint64 deadline,uint64 leaderEpoch,uint64 signerSetVersion,uint64 policyVersion)"
    );
    bytes32 internal constant WITHDRAWAL_TYPEHASH = keccak256(
        "WithdrawalIntent(address account,address recipient,uint256 amount,uint256 nonce,uint64 deadline)"
    );
    bytes32 internal constant CANCEL_TYPEHASH = keccak256(
        "CancelIntent(address account,uint256 nonce,uint64 deadline)"
    );
    bytes32 internal constant CLOSE_TYPEHASH = keccak256(
        "CloseIntent(address account,uint8 market,uint256 nonce,uint64 deadline)"
    );
    bytes32 internal constant SESSION_GRANT_TYPEHASH = keccak256(
        "SessionGrant(address account,address session,uint8 marketMask,uint128 maxTradeNotional,uint128 maxCumulativeNotional,uint128 maxFee,uint64 validUntil,uint256 nonce,uint64 deadline)"
    );
    struct Position { int256 size; uint256 entryPrice; int256 lastFundingIndex; }
    struct Account { int256 collateral; mapping(uint8 => Position) positions; }
    struct Market {
        int256 aggregateBase;
        int256 fundingIndex;
        uint64 fundingTime;
        uint64 lastPriceTime;
        uint256 lastBid;
        uint256 lastAsk;
        bool enabled;
    }
    struct TradeIntent {
        address account; uint8 market; int256 baseDelta; uint256 limitPrice; uint256 maxFee;
        uint256 nonce; uint64 deadline; bool reduceOnly;
    }
    struct MakerApproval {
        bytes32 intentHash; uint256 executionPrice; int256 impactCharge; uint256 fee;
        bytes32 oracleReportHash; uint64 deadline; uint64 leaderEpoch;
        uint64 signerSetVersion; uint64 policyVersion;
    }
    struct Session {
        address account; uint64 validUntil; uint8 marketMask; uint128 maxTradeNotional;
        uint128 maxCumulativeNotional; uint128 usedNotional; uint128 maxFee;
    }
    struct SessionGrant {
        address account; address session; uint8 marketMask; uint128 maxTradeNotional;
        uint128 maxCumulativeNotional; uint128 maxFee; uint64 validUntil; uint256 nonce; uint64 deadline;
    }

    IERC20 public usdc;
    IPriceOracle public oracle;
    address public governance; // production: self-administered 72-hour timelock
    address public emergencyCouncil; // production: separate 2-of-3 multisig
    address[3] public approvers;
    mapping(address => bool) public isApprover;
    mapping(address => Account) private _accounts;
    mapping(address => bool) public accountRegistered;
    address[] private _accountList;
    mapping(address => mapping(uint256 => bool)) public nonceUsed;
    Market[2] public markets;
    uint256 public makerBacking;
    uint256 public insuranceBalance;
    int256 public totalCustomerCollateral;
    uint256 public baseRiskCapitalTarget;
    uint64 public leaderEpoch;
    uint64 public signerSetVersion;
    uint64 public policyVersion;
    bool public paused;
    bool public resolutionRequired;
    uint256 private _entered;
    uint64 public resolutionTriggerTime;
    uint8[2] public resolutionSampleCount;
    uint64[2] private _firstResolutionObservationTime;
    uint64[2] private _lastResolutionObservationTime;
    uint256[3][2] private _resolutionSamples;
    uint256[2] public resolutionPrice;
    bool public resolutionPricesReady;
    uint256 public resolutionCursor;
    uint256 public totalResolutionClaims;
    uint256 public resolutionAssets;
    bool public resolutionFinalized;
    mapping(address => uint256) public resolutionClaim;
    mapping(address => uint256) public resolutionPaid;
    mapping(address => Session) public sessions;
    // First append-only extension; future implementations must add storage after this field.
    mapping(uint8 => uint256) public marketLimitWord;

    event Deposited(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event NonceCancelled(address indexed account, uint256 indexed nonce);
    event PositionClosed(address indexed account, uint8 indexed market, int256 baseDelta, uint256 price);
    event MakerWithdrawn(address indexed recipient, uint256 amount);
    event SessionGranted(address indexed account, address indexed session, uint64 validUntil, uint128 maxCumulativeNotional);
    event SessionRevoked(address indexed account, address indexed session);
    event TradeExecuted(bytes32 indexed intentHash, address indexed account, uint8 market, int256 baseDelta, uint256 price, uint256 fee);
    event FundingSettled(address indexed account, uint8 indexed market, int256 payment);
    event Liquidated(address indexed account, uint8 market, uint256 closedBase, uint256 penalty, uint256 keeperReward);
    event DeficitAbsorbed(address indexed account, uint256 insuranceUsed, uint256 makerUsed, uint256 unresolved);
    event EpochAdvanced(uint64 epoch);
    event ResolutionStarted(uint64 triggerTime);
    event ResolutionPriceReady(uint8 indexed market, uint256 price);
    event ResolutionFinalized(uint256 claims, uint256 assets);
    event MarketPolicyUpdated(uint8 indexed market, bool enabled, uint128 maxTradeNotional, uint128 maxMarketNotional, uint64 policyVersion);

    error Unauthorized(); error InvalidTrade(); error InvalidSignature(); error Stale();
    error Replay(); error Margin(); error OracleInvalid(); error Insolvent();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(
        address usdc_, address oracle_, address governance_, address emergencyCouncil_,
        address[3] calldata approvers_, uint256 baseRiskCapitalTarget_
    ) external initializer {
        if (
            usdc_ == address(0) || oracle_ == address(0) || governance_ == address(0)
                || emergencyCouncil_ == address(0) || governance_ == emergencyCouncil_ || baseRiskCapitalTarget_ == 0
        ) revert Unauthorized();
        _entered = 1;
        usdc = IERC20(usdc_); oracle = IPriceOracle(oracle_); governance = governance_;
        emergencyCouncil = emergencyCouncil_; baseRiskCapitalTarget = baseRiskCapitalTarget_;
        leaderEpoch = 1; signerSetVersion = 1; policyVersion = 1;
        markets[0].enabled = true; markets[1].enabled = true;
        uint256 initialLimits = ABSOLUTE_MAX_TRADE_NOTIONAL | (ABSOLUTE_MAX_MARKET_NOTIONAL << 128);
        marketLimitWord[0] = initialLimits; marketLimitWord[1] = initialLimits;
        markets[0].fundingTime = uint64(block.timestamp); markets[1].fundingTime = uint64(block.timestamp);
        _setApprovers(approvers_);
    }

    modifier onlyGovernance() { if (msg.sender != governance) revert Unauthorized(); _; }
    modifier onlyEmergencyOrGovernance() { if (msg.sender != governance && msg.sender != emergencyCouncil) revert Unauthorized(); _; }
    modifier nonReentrant() { if (_entered != 1) revert Unauthorized(); _entered = 2; _; _entered = 1; }

    function _hashTypedDataV4(bytes32 structHash) private view returns (bytes32) {
        bytes32 separator = keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
        return keccak256(abi.encodePacked("\x19\x01", separator, structHash));
    }

    function collateralOf(address account) external view returns (int256) { return _accounts[account].collateral; }
    function positionOf(address account, uint8 market) external view returns (Position memory) { return _accounts[account].positions[market]; }

    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0 || resolutionRequired) revert InvalidTrade();
        _pullExact(msg.sender, amount);
        _creditDeposit(msg.sender, amount);
        emit Deposited(msg.sender, amount);
    }

    /// @notice Gas-sponsored atomic deposit for native USDC implementations supporting EIP-3009.
    function depositWithAuthorization(
        address from, uint256 amount, uint256 validAfter, uint256 validBefore,
        bytes32 authorizationNonce, uint8 v, bytes32 r, bytes32 s
    ) external nonReentrant {
        if (amount == 0 || resolutionRequired) revert InvalidTrade();
        uint256 beforeBalance = usdc.balanceOf(address(this));
        IERC3009Baseline(address(usdc)).receiveWithAuthorization(
            from, address(this), amount, validAfter, validBefore, authorizationNonce, v, r, s
        );
        if (usdc.balanceOf(address(this)) - beforeBalance != amount) revert InvalidTrade();
        _creditDeposit(from, amount);
        emit Deposited(from, amount);
    }

    function fundMaker(uint256 amount) external nonReentrant {
        if (resolutionRequired || amount == 0) revert InvalidTrade();
        _pullExact(msg.sender, amount);
        makerBacking += amount;
    }

    function fundInsurance(uint256 amount) external nonReentrant {
        if (resolutionRequired || amount == 0) revert InvalidTrade();
        _pullExact(msg.sender, amount);
        insuranceBalance += amount;
    }

    function refreshOracle(bytes calldata report) external payable nonReentrant returns (IPriceOracle.Observation memory observation) {
        observation = _verifyReport(report, type(uint8).max);
        _recordObservation(observation);
        _updateFunding(observation.market, (observation.bid + observation.ask) / 2);
    }

    function withdraw(uint256 amount) external nonReentrant {
        _withdraw(msg.sender, msg.sender, amount);
    }

    /// @notice Gas-sponsored withdrawal authorized by the collateral owner.
    function withdrawWithSignature(
        address account, address recipient, uint256 amount, uint256 nonce, uint64 deadline, bytes calldata signature
    ) external nonReentrant {
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(WITHDRAWAL_TYPEHASH, account, recipient, amount, nonce, deadline)));
        _consumeUserAuthorization(account, nonce, deadline, digest, signature);
        _withdraw(account, recipient, amount);
    }

    /// @notice Invalidates a trade or action nonce without trusting the API.
    function cancelNonce(uint256 nonce) external {
        _cancelNonce(msg.sender, nonce);
    }

    /// @notice Gas-sponsored nonce cancellation authorized by the account owner.
    function cancelNonceWithSignature(address account, uint256 nonce, uint64 deadline, bytes calldata signature) external {
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CANCEL_TYPEHASH, account, nonce, deadline)));
        if (block.timestamp > deadline || account == address(0) || nonceUsed[account][nonce]) revert Replay();
        if (!SignatureChecker.isValidSignatureNowCalldata(account, digest, signature)) revert InvalidSignature();
        _cancelNonce(account, nonce);
    }

    /// @notice Conservative owner exit while trading is paused but before global resolution.
    function closePosition(uint8 market, bytes calldata report) external payable nonReentrant {
        _closePosition(msg.sender, market, report);
    }

    /// @notice Gas-sponsored paused-market close authorized by the account owner.
    function closePositionWithSignature(
        address account, uint8 market, uint256 nonce, uint64 deadline, bytes calldata report, bytes calldata signature
    ) external payable nonReentrant {
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CLOSE_TYPEHASH, account, market, nonce, deadline)));
        _consumeUserAuthorization(account, nonce, deadline, digest, signature);
        _closePosition(account, market, report);
    }

    function executeTrade(
        TradeIntent calldata intent, MakerApproval calldata approval, bytes calldata report,
        bytes calldata userSignature, bytes calldata makerSignatureOne, bytes calldata makerSignatureTwo
    ) external payable nonReentrant {
        if (paused || resolutionRequired || intent.market > 1 || !markets[intent.market].enabled || intent.baseDelta == 0) revert InvalidTrade();
        IPriceOracle.Observation memory observation = _verifyReport(report, intent.market);
        _recordObservation(observation);
        _updateFunding(intent.market, (observation.bid + observation.ask) / 2);
        _settleFunding(intent.account, intent.market);
        (bytes32 intentHash, address sessionSigner) = _validateIntent(intent, approval, userSignature);
        _validateApproval(approval, makerSignatureOne, makerSignatureTwo);
        if (approval.oracleReportHash != keccak256(report)) revert OracleInvalid();
        uint256 notional = _validateEconomics(intent, approval, observation, sessionSigner);
        _applyAuthorizedTrade(intent, approval, intentHash, sessionSigner, notional);
    }

    function _applyAuthorizedTrade(TradeIntent calldata intent, MakerApproval calldata approval, bytes32 intentHash, address sessionSigner, uint256 notional) private {
        nonceUsed[intent.account][intent.nonce] = true;
        if (sessionSigner != address(0)) sessions[sessionSigner].usedNotional += uint128(notional);
        _applyPosition(intent.account, intent.market, intent.baseDelta, approval.executionPrice);
        _chargeFee(intent.account, approval.fee);
        _enforceAggregateRisk();
        if (_accounts[intent.account].collateral < 0 || openingEquity(intent.account) < int256(initialMargin(intent.account))) revert Margin();
        emit TradeExecuted(intentHash, intent.account, intent.market, intent.baseDelta, approval.executionPrice, approval.fee);
    }

    function _validateEconomics(TradeIntent calldata intent, MakerApproval calldata approval, IPriceOracle.Observation memory observation, address sessionSigner) private view returns (uint256 notional) {
        int256 btc = markets[0].aggregateBase * int256(_mid(0)) / int256(BASE);
        int256 eth = markets[1].aggregateBase * int256(_mid(1)) / int256(BASE);
        int256 required; int256 deliveredImpact; bool reduces;
        (notional, required, deliveredImpact, reduces) = RFQRiskMathBaseline.tradeAssessment(
            btc, eth, _accounts[intent.account].positions[intent.market].size, intent.market,
            intent.baseDelta, approval.executionPrice, observation.bid, observation.ask
        );
        if (notional > _tradeLimit(intent.market)) revert InvalidTrade();
        if (sessionSigner != address(0)) {
            Session storage session = sessions[sessionSigner];
            if (notional > session.maxTradeNotional || uint256(session.usedNotional) + notional > session.maxCumulativeNotional) revert Unauthorized();
        }
        if (intent.reduceOnly && !reduces) revert InvalidTrade();
        if (approval.impactCharge < required) revert InvalidTrade();
        if (deliveredImpact < approval.impactCharge) revert InvalidTrade();
    }

    function liquidate(address account, uint8 market, bytes calldata report) external payable nonReentrant {
        if (market > 1) revert InvalidTrade();
        IPriceOracle.Observation memory observation = _verifyReport(report, market);
        _recordObservation(observation); _updateFunding(market, (observation.bid + observation.ask) / 2);
        // Cross-margin solvency includes every open position. A keeper must
        // refresh any other stale market before liquidation can price equity.
        _requireFreshPositions(account);
        _settleAllFunding(account);
        (uint256 closed, uint256 mark) = _liquidationClose(account, market, observation);
        (uint256 penalty, uint256 reward) = _collectLiquidationPenalty(account, closed, mark);
        if (reward != 0) usdc.safeTransfer(msg.sender, reward);
        (uint256 insuranceUsed, uint256 makerUsed, uint256 unresolved) = _absorbDeficit(account);
        if (unresolved != 0) _startResolution();
        emit Liquidated(account, market, closed, penalty, reward);
        emit DeficitAbsorbed(account, insuranceUsed, makerUsed, unresolved);
    }

    function _liquidationClose(address account, uint8 market, IPriceOracle.Observation memory observation) private returns (uint256 closed, uint256 mark) {
        int256 equity = maintenanceEquity(account);
        if (equity >= int256(maintenanceMargin(account))) revert Margin();
        Position storage position = _accounts[account].positions[market];
        if (position.size == 0) revert InvalidTrade();
        mark = position.size > 0 ? observation.bid : observation.ask;
        closed = RFQRiskMathBaseline.liquidationClose(position.size, mark, equity);
        int256 delta = position.size > 0 ? -int256(closed) : int256(closed);
        _applyPosition(account, market, delta, mark);
    }

    function _collectLiquidationPenalty(address account, uint256 closed, uint256 mark) private returns (uint256 penalty, uint256 reward) {
        uint256 available = _accounts[account].collateral > 0 ? uint256(_accounts[account].collateral) : 0;
        (penalty, reward) = RFQRiskMathBaseline.liquidationCharge(closed, mark, available);
        _changeCollateral(account, -int256(penalty));
        insuranceBalance += penalty - reward;
    }

    function maintenanceEquity(address account) public view returns (int256) { return _equity(account, true); }
    function openingEquity(address account) public view returns (int256) {
        int256 value = _accounts[account].collateral;
        for (uint8 i; i < 2; ++i) { int256 pnl = _unrealized(account, i); if (pnl < 0) value += pnl; }
        return value;
    }
    function initialMargin(address account) public view returns (uint256 total) {
        for (uint8 i; i < 2; ++i) { uint256 n = _positionNotional(account, i); uint256 rate = RFQRiskMathBaseline.marginRate(n, true); if (rate == type(uint256).max) revert Margin(); total += n * rate / 10_000; }
    }
    function maintenanceMargin(address account) public view returns (uint256 total) {
        for (uint8 i; i < 2; ++i) { uint256 n = _positionNotional(account, i); uint256 rate = RFQRiskMathBaseline.marginRate(n, false); if (rate == type(uint256).max) revert Margin(); total += n * rate / 10_000; }
    }

    function pause() external onlyEmergencyOrGovernance { paused = true; ++leaderEpoch; emit EpochAdvanced(leaderEpoch); }
    function unpause() external onlyGovernance { if (resolutionRequired) revert Insolvent(); paused = false; }
    function advanceLeaderEpoch(uint64 expectedEpoch) external onlyEmergencyOrGovernance {
        if (expectedEpoch != leaderEpoch) revert Stale(); ++leaderEpoch; emit EpochAdvanced(leaderEpoch);
    }
    function rotateApprovers(address[3] calldata next) external onlyGovernance { _setApprovers(next); ++signerSetVersion; ++leaderEpoch; emit EpochAdvanced(leaderEpoch); }
    function setOracle(address next) external onlyGovernance { if (next == address(0)) revert Unauthorized(); oracle = IPriceOracle(next); ++policyVersion; }
    function setMarketPolicy(uint8 market, bool enabled, uint128 maxTradeNotional, uint128 maxMarketNotional) external onlyEmergencyOrGovernance {
        if (market > 1 || maxTradeNotional == 0 || maxTradeNotional > maxMarketNotional || maxTradeNotional > ABSOLUTE_MAX_TRADE_NOTIONAL || maxMarketNotional > ABSOLUTE_MAX_MARKET_NOTIONAL) revert InvalidTrade();
        if (msg.sender != governance && (enabled || maxTradeNotional > _tradeLimit(market) || maxMarketNotional > _marketLimit(market))) revert Unauthorized();
        markets[market].enabled = enabled;
        marketLimitWord[market] = uint256(maxTradeNotional) | (uint256(maxMarketNotional) << 128); ++policyVersion;
        emit MarketPolicyUpdated(market, enabled, maxTradeNotional, maxMarketNotional, policyVersion);
    }

    /// @notice Releases only maker capital above both the configured floor and live stress requirement.
    function withdrawMakerExcess(address recipient, uint256 amount) external onlyGovernance nonReentrant {
        if (resolutionRequired || recipient == address(0) || amount == 0 || amount > makerBacking) revert InvalidTrade();
        uint256 remaining = makerBacking - amount;
        if (remaining < baseRiskCapitalTarget) revert Margin();
        int256 btc = markets[0].aggregateBase * int256(_mid(0)) / int256(BASE);
        int256 eth = markets[1].aggregateBase * int256(_mid(1)) / int256(BASE);
        if (RFQRiskMathBaseline.stressLoss(btc, eth) > remaining / 4) revert Margin();
        makerBacking = remaining;
        usdc.safeTransfer(recipient, amount);
        emit MakerWithdrawn(recipient, amount);
    }

    function grantSessionWithSignature(SessionGrant calldata grant, bytes calldata signature) external {
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            SESSION_GRANT_TYPEHASH, grant.account, grant.session, grant.marketMask, grant.maxTradeNotional,
            grant.maxCumulativeNotional, grant.maxFee, grant.validUntil, grant.nonce, grant.deadline
        )));
        _consumeUserAuthorization(grant.account, grant.nonce, grant.deadline, digest, signature);
        _setSession(grant.account, grant.session, grant.marketMask, grant.maxTradeNotional, grant.maxCumulativeNotional, grant.maxFee, grant.validUntil);
    }

    function revokeSession(address session) external {
        Session storage current = sessions[session];
        if (current.account != msg.sender) revert Unauthorized();
        delete sessions[session];
        emit SessionRevoked(msg.sender, session);
    }

    function declareResolution() external onlyGovernance {
        if (!paused) revert InvalidTrade();
        _startResolution();
    }

    /// @notice Records the first three qualifying post-trigger reports per market.
    function submitResolutionObservation(bytes calldata report) external payable nonReentrant {
        if (!resolutionRequired || resolutionPricesReady) revert InvalidTrade();
        IPriceOracle.Observation memory o = _verifyReport(report, type(uint8).max);
        if (o.observedAt < resolutionTriggerTime) revert Stale();
        uint8 count = resolutionSampleCount[o.market];
        if (count >= 3 || (count != 0 && o.observedAt <= _lastResolutionObservationTime[o.market])) revert InvalidTrade();
        if (count == 0) _firstResolutionObservationTime[o.market] = o.observedAt;
        if (count == 2 && o.observedAt < _firstResolutionObservationTime[o.market] + 30) revert Stale();
        _resolutionSamples[o.market][count] = (o.bid + o.ask) / 2;
        resolutionSampleCount[o.market] = count + 1;
        _lastResolutionObservationTime[o.market] = o.observedAt;
        if (count == 2) {
            resolutionPrice[o.market] = _median3(
                _resolutionSamples[o.market][0], _resolutionSamples[o.market][1], _resolutionSamples[o.market][2]
            );
            emit ResolutionPriceReady(o.market, resolutionPrice[o.market]);
        }
        resolutionPricesReady = resolutionSampleCount[0] == 3 && resolutionSampleCount[1] == 3;
    }

    /// @notice Permissionless bounded crystallization; no account can jump the queue.
    function processResolution(uint256 maxAccounts) external {
        if (!resolutionPricesReady || resolutionFinalized || maxAccounts == 0) revert InvalidTrade();
        uint256 end = resolutionCursor + maxAccounts;
        if (end > _accountList.length) end = _accountList.length;
        for (uint256 i = resolutionCursor; i < end; ++i) {
            address account = _accountList[i];
            int256 equity = _resolutionEquity(account);
            uint256 claim = equity > 0 ? uint256(equity) : 0;
            resolutionClaim[account] = claim;
            totalResolutionClaims += claim;
            _accounts[account].collateral = 0;
            delete _accounts[account].positions[0];
            delete _accounts[account].positions[1];
        }
        resolutionCursor = end;
        if (end == _accountList.length) {
            resolutionFinalized = true;
            resolutionAssets = usdc.balanceOf(address(this));
            totalCustomerCollateral = 0;
            makerBacking = 0;
            insuranceBalance = 0;
            markets[0].aggregateBase = 0;
            markets[1].aggregateBase = 0;
            emit ResolutionFinalized(totalResolutionClaims, resolutionAssets);
        }
    }

    function claimResolution() external nonReentrant {
        if (!resolutionFinalized || totalResolutionClaims == 0) revert InvalidTrade();
        uint256 distributable = resolutionAssets < totalResolutionClaims ? resolutionAssets : totalResolutionClaims;
        uint256 entitlement = resolutionClaim[msg.sender] * distributable / totalResolutionClaims;
        uint256 amount = entitlement - resolutionPaid[msg.sender];
        if (amount == 0) revert InvalidTrade();
        resolutionPaid[msg.sender] = entitlement;
        usdc.safeTransfer(msg.sender, amount);
    }

    function addResolutionRecovery(uint256 amount) external nonReentrant {
        if (!resolutionFinalized || amount == 0) revert InvalidTrade();
        uint256 credited = resolutionAssets < totalResolutionClaims ? resolutionAssets : totalResolutionClaims;
        if (amount > totalResolutionClaims - credited) revert InvalidTrade();
        _pullExact(msg.sender, amount);
        resolutionAssets += amount;
    }

    function _consumeUserAuthorization(
        address account, uint256 nonce, uint64 deadline, bytes32 digest, bytes calldata signature
    ) private {
        if (block.timestamp > deadline || account == address(0) || nonceUsed[account][nonce]) revert Replay();
        if (!SignatureChecker.isValidSignatureNowCalldata(account, digest, signature)) revert InvalidSignature();
        nonceUsed[account][nonce] = true;
    }

    function _cancelNonce(address account, uint256 nonce) private {
        if (nonceUsed[account][nonce]) revert Replay();
        nonceUsed[account][nonce] = true;
        emit NonceCancelled(account, nonce);
    }

    function _withdraw(address account, address recipient, uint256 amount) private {
        if (resolutionRequired || recipient == address(0) || amount == 0) revert InvalidTrade();
        _requireFreshPositions(account);
        _settleAllFunding(account);
        _changeCollateral(account, -int256(amount));
        if (_accounts[account].collateral < 0 || openingEquity(account) < int256(initialMargin(account))) revert Margin();
        usdc.safeTransfer(recipient, amount);
        emit Withdrawn(account, amount);
    }

    function _closePosition(address account, uint8 market, bytes calldata report) private {
        if (!paused || resolutionRequired || market > 1) revert InvalidTrade();
        IPriceOracle.Observation memory observation = _verifyReport(report, market);
        _recordObservation(observation);
        _updateFunding(market, (observation.bid + observation.ask) / 2);
        _settleFunding(account, market);
        int256 size = _accounts[account].positions[market].size;
        if (size == 0) revert InvalidTrade();
        uint256 price = size > 0 ? observation.bid : observation.ask;
        _applyPosition(account, market, -size, price);
        emit PositionClosed(account, market, -size, price);
    }

    function _startResolution() private {
        if (!resolutionRequired) {
            resolutionRequired = true; paused = true; resolutionTriggerTime = uint64(block.timestamp); ++leaderEpoch;
            emit EpochAdvanced(leaderEpoch); emit ResolutionStarted(resolutionTriggerTime);
        }
    }

    function _verifyReport(bytes calldata report, uint8 expectedMarket) private returns (IPriceOracle.Observation memory o) {
        o = oracle.verify{value: msg.value}(report);
        if (o.market > 1 || (expectedMarket != type(uint8).max && o.market != expectedMarket) || o.bid == 0 || o.ask < o.bid) revert OracleInvalid();
        if (block.timestamp < o.observedAt || block.timestamp > o.validUntil || block.timestamp - o.observedAt > MAX_ORACLE_AGE) revert Stale();
        uint256 mid = (o.bid + o.ask) / 2;
        if ((o.ask - o.bid) * 10_000 > mid * MAX_WIDTH_BPS) revert OracleInvalid();
    }
    function _recordObservation(IPriceOracle.Observation memory o) private {
        Market storage market = markets[o.market]; market.lastBid = o.bid; market.lastAsk = o.ask; market.lastPriceTime = o.observedAt;
    }
    function _requireFreshPositions(address account) private view {
        for (uint8 i; i < 2; ++i) if (_accounts[account].positions[i].size != 0 && block.timestamp - markets[i].lastPriceTime > MAX_ORACLE_AGE) revert Stale();
    }
    function _validateIntent(TradeIntent calldata intent, MakerApproval calldata approval, bytes calldata signature) private view returns (bytes32 digest, address sessionSigner) {
        if (block.timestamp > intent.deadline || block.timestamp > approval.deadline || approval.leaderEpoch != leaderEpoch || approval.policyVersion != policyVersion || approval.signerSetVersion != signerSetVersion) revert Stale();
        if (nonceUsed[intent.account][intent.nonce] || intent.account == address(0) || approval.fee > intent.maxFee) revert Replay();
        if ((intent.baseDelta > 0 && approval.executionPrice > intent.limitPrice) || (intent.baseDelta < 0 && approval.executionPrice < intent.limitPrice)) revert InvalidTrade();
        bytes32 structHash = keccak256(abi.encode(INTENT_TYPEHASH, intent.account, intent.market, intent.baseDelta, intent.limitPrice, intent.maxFee, intent.nonce, intent.deadline, intent.reduceOnly));
        digest = _hashTypedDataV4(structHash);
        if (approval.intentHash != digest) revert InvalidSignature();
        if (SignatureChecker.isValidSignatureNowCalldata(intent.account, digest, signature)) return (digest, address(0));
        sessionSigner = ECDSA.recoverCalldata(digest, signature);
        Session storage session = sessions[sessionSigner];
        if (session.account != intent.account || block.timestamp > session.validUntil || intent.deadline > session.validUntil || session.marketMask & uint8(1 << intent.market) == 0 || approval.fee > session.maxFee) revert Unauthorized();
    }
    function _validateApproval(MakerApproval calldata approval, bytes calldata one, bytes calldata two) private view {
        bytes32 structHash = keccak256(abi.encode(APPROVAL_TYPEHASH, approval.intentHash, approval.executionPrice, approval.impactCharge, approval.fee, approval.oracleReportHash, approval.deadline, approval.leaderEpoch, approval.signerSetVersion, approval.policyVersion));
        bytes32 digest = _hashTypedDataV4(structHash); address a = ECDSA.recoverCalldata(digest, one); address b = ECDSA.recoverCalldata(digest, two);
        if (a == b || !isApprover[a] || !isApprover[b]) revert InvalidSignature();
    }
    function _setApprovers(address[3] calldata next) private {
        for (uint256 i; i < 3; ++i) isApprover[approvers[i]] = false;
        for (uint256 i; i < 3; ++i) { if (next[i] == address(0) || isApprover[next[i]]) revert InvalidSignature(); approvers[i] = next[i]; isApprover[next[i]] = true; }
    }
    function _setSession(
        address account, address session, uint8 marketMask, uint128 maxTradeNotional,
        uint128 maxCumulativeNotional, uint128 maxFee, uint64 validUntil
    ) private {
        if (account == address(0) || session == address(0) || session == account || marketMask == 0 || marketMask > 3 || maxTradeNotional == 0 || maxTradeNotional > maxCumulativeNotional || maxFee == 0 || validUntil <= block.timestamp || validUntil > block.timestamp + MAX_SESSION_DURATION) revert InvalidTrade();
        sessions[session] = Session(account, validUntil, marketMask, maxTradeNotional, maxCumulativeNotional, 0, maxFee);
        emit SessionGranted(account, session, validUntil, maxCumulativeNotional);
    }
    function _updateFunding(uint8 marketId, uint256 mark) private {
        Market storage market = markets[marketId];
        (market.fundingIndex, market.fundingTime) = RFQRiskMathBaseline.fundingStep(
            market.aggregateBase, mark, market.fundingIndex, market.fundingTime, uint64(block.timestamp), _marketLimit(marketId)
        );
    }
    function _settleAllFunding(address account) private { for (uint8 i; i < 2; ++i) _settleFunding(account, i); }
    function _settleFunding(address account, uint8 marketId) private {
        Position storage p = _accounts[account].positions[marketId]; int256 change = markets[marketId].fundingIndex - p.lastFundingIndex;
        if (change != 0 && p.size != 0) { int256 payment = p.size * change / int256(BASE); _changeCollateral(account, -payment); _changeMaker(payment); emit FundingSettled(account, marketId, payment); }
        p.lastFundingIndex = markets[marketId].fundingIndex;
    }
    function _applyPosition(address account, uint8 marketId, int256 delta, uint256 price) private {
        Position storage p = _accounts[account].positions[marketId];
        (int256 next, uint256 entry, int256 pnl) = RFQRiskMathBaseline.positionTransition(p.size, p.entryPrice, delta, price);
        if (pnl != 0) { _changeCollateral(account, pnl); _changeMaker(-pnl); }
        p.size = next; p.entryPrice = entry; p.lastFundingIndex = markets[marketId].fundingIndex; markets[marketId].aggregateBase += delta;
    }
    function _chargeFee(address account, uint256 fee) private {
        _changeCollateral(account, -int256(fee));
        uint256 insuranceShare = insuranceBalance < baseRiskCapitalTarget / 4 ? fee / 5 : fee / 10;
        insuranceBalance += insuranceShare; makerBacking += fee - insuranceShare;
    }
    function _changeCollateral(address account, int256 delta) private { _accounts[account].collateral += delta; totalCustomerCollateral += delta; }
    function _pullExact(address from, uint256 amount) private {
        uint256 beforeBalance = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(from, address(this), amount);
        if (usdc.balanceOf(address(this)) - beforeBalance != amount) revert InvalidTrade();
    }
    function _creditDeposit(address account, uint256 amount) private {
        if (!accountRegistered[account]) { if (amount < 10e6) revert InvalidTrade(); accountRegistered[account] = true; _accountList.push(account); }
        _changeCollateral(account, int256(amount));
    }
    function _changeMaker(int256 delta) private { if (delta >= 0) makerBacking += uint256(delta); else { uint256 debit = uint256(-delta); if (debit > makerBacking) revert Insolvent(); makerBacking -= debit; } }
    function _absorbDeficit(address account) private returns (uint256 insuranceUsed, uint256 makerUsed, uint256 unresolved) {
        int256 value = _accounts[account].collateral; if (value >= 0) return (0, 0, 0); uint256 deficit = uint256(-value);
        _changeCollateral(account, int256(deficit)); insuranceUsed = deficit < insuranceBalance ? deficit : insuranceBalance; insuranceBalance -= insuranceUsed; deficit -= insuranceUsed;
        makerUsed = deficit < makerBacking ? deficit : makerBacking; makerBacking -= makerUsed; deficit -= makerUsed; unresolved = deficit;
    }
    function _equity(address account, bool includePositive) private view returns (int256 value) {
        value = _accounts[account].collateral; for (uint8 i; i < 2; ++i) { int256 pnl = _unrealized(account, i); if (includePositive || pnl < 0) value += pnl; }
    }
    function _unrealized(address account, uint8 marketId) private view returns (int256) {
        Position storage p = _accounts[account].positions[marketId]; if (p.size == 0) return 0;
        uint256 mark = p.size > 0 ? markets[marketId].lastBid : markets[marketId].lastAsk;
        return RFQRiskMathBaseline.positionPnl(p.size, p.entryPrice, mark);
    }
    function _positionNotional(address account, uint8 marketId) private view returns (uint256) {
        Position storage p = _accounts[account].positions[marketId]; return _abs(p.size) * markets[marketId].lastAsk / BASE;
    }
    function _enforceAggregateRisk() private view {
        int256 btc = markets[0].aggregateBase * int256(_mid(0)) / int256(BASE); int256 eth = markets[1].aggregateBase * int256(_mid(1)) / int256(BASE);
        if (_abs(btc) > _marketLimit(0) || _abs(eth) > _marketLimit(1) || RFQRiskMathBaseline.stressLoss(btc, eth) > makerBacking / 4) revert Margin();
    }
    function _mid(uint8 market) private view returns (uint256) { Market storage m=markets[market]; if (m.aggregateBase != 0 && (m.lastPriceTime == 0 || block.timestamp-m.lastPriceTime>MAX_ORACLE_AGE)) revert Stale(); return (m.lastBid+m.lastAsk)/2; }
    function _tradeLimit(uint8 market) private view returns (uint256) { return uint128(marketLimitWord[market]); }
    function _marketLimit(uint8 market) private view returns (uint256) { return marketLimitWord[market] >> 128; }
    function _abs(int256 value) private pure returns (uint256) { return uint256(value < 0 ? -value : value); }
    function _median3(uint256 a,uint256 b,uint256 c) private pure returns(uint256){if(a>b)(a,b)=(b,a);if(b>c)(b,c)=(c,b);if(a>b)(a,b)=(b,a);return b;}
    function _resolutionEquity(address account) private view returns (int256 value) {
        Account storage a = _accounts[account]; value = a.collateral;
        for (uint8 i; i < 2; ++i) { Position storage p=a.positions[i]; value += RFQRiskMathBaseline.positionPnl(p.size, p.entryPrice, resolutionPrice[i]); }
    }
}
