// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import "./interfaces/IPriceOracle.sol";

interface IERC3009 {
    function receiveWithAuthorization(
        address from, address to, uint256 value, uint256 validAfter, uint256 validBefore,
        bytes32 nonce, uint8 v, bytes32 r, bytes32 s
    ) external;
}

/// @notice First executable clearing prototype. It is deliberately capped at BTC/ETH.
/// @custom:oz-upgrades
contract RFQClearing is Initializable, EIP712Upgradeable, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    uint256 internal constant BASE = 1e18;
    uint256 internal constant RATE = 1e12;
    uint256 internal constant YEAR = 365 days;
    uint256 internal constant MAX_ORACLE_AGE = 8;
    uint256 internal constant MAX_WIDTH_BPS = 100;
    uint256 internal constant MAX_TRADE_NOTIONAL = 25_000e6;
    uint256 internal constant MAX_MARKET_NOTIONAL = 250_000e6;
    uint256 internal constant K_BTC = 10_000;
    uint256 internal constant K_ETH = 12_000;
    uint256 internal constant K_CROSS = 6_573;
    uint256 internal constant LIQUIDATION_PENALTY_BPS = 50;
    uint256 internal constant KEEPER_REWARD_BPS = 10;

    bytes32 internal constant INTENT_TYPEHASH = keccak256(
        "TradeIntent(address account,uint8 market,int256 baseDelta,uint256 limitPrice,uint256 maxFee,uint256 nonce,uint64 deadline,uint64 leaderEpoch,uint64 policyVersion,bool reduceOnly)"
    );
    bytes32 internal constant APPROVAL_TYPEHASH = keccak256(
        "MakerApproval(bytes32 intentHash,uint256 executionPrice,int256 impactCharge,uint256 fee,bytes32 oracleReportHash,uint64 deadline,uint64 leaderEpoch,uint64 signerSetVersion,uint64 policyVersion)"
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
        uint256 nonce; uint64 deadline; uint64 leaderEpoch; uint64 policyVersion; bool reduceOnly;
    }
    struct MakerApproval {
        bytes32 intentHash; uint256 executionPrice; int256 impactCharge; uint256 fee;
        bytes32 oracleReportHash; uint64 deadline; uint64 leaderEpoch;
        uint64 signerSetVersion; uint64 policyVersion;
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

    event Deposited(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event TradeExecuted(bytes32 indexed intentHash, address indexed account, uint8 market, int256 baseDelta, uint256 price, uint256 fee);
    event Liquidated(address indexed account, uint8 market, uint256 closedBase, uint256 penalty, uint256 keeperReward);
    event DeficitAbsorbed(address indexed account, uint256 insuranceUsed, uint256 makerUsed, uint256 unresolved);
    event EpochAdvanced(uint64 epoch);
    event ResolutionStarted(uint64 triggerTime);
    event ResolutionPriceReady(uint8 indexed market, uint256 price);
    event ResolutionFinalized(uint256 claims, uint256 assets);

    error Unauthorized(); error InvalidTrade(); error InvalidSignature(); error Stale();
    error Replay(); error Margin(); error OracleInvalid(); error Insolvent();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(
        address usdc_, address oracle_, address governance_, address emergencyCouncil_,
        address[3] calldata approvers_, uint256 baseRiskCapitalTarget_
    ) external initializer {
        if (usdc_ == address(0) || oracle_ == address(0) || governance_ == address(0) || emergencyCouncil_ == address(0)) revert Unauthorized();
        __EIP712_init("RFQ Markets", "1");
        _entered = 1;
        usdc = IERC20(usdc_); oracle = IPriceOracle(oracle_); governance = governance_;
        emergencyCouncil = emergencyCouncil_; baseRiskCapitalTarget = baseRiskCapitalTarget_;
        leaderEpoch = 1; signerSetVersion = 1; policyVersion = 1;
        markets[0].enabled = true; markets[1].enabled = true;
        markets[0].fundingTime = uint64(block.timestamp); markets[1].fundingTime = uint64(block.timestamp);
        _setApprovers(approvers_);
    }

    modifier onlyGovernance() { if (msg.sender != governance) revert Unauthorized(); _; }
    modifier onlyEmergencyOrGovernance() { if (msg.sender != governance && msg.sender != emergencyCouncil) revert Unauthorized(); _; }
    modifier nonReentrant() { if (_entered != 1) revert Unauthorized(); _entered = 2; _; _entered = 1; }

    function collateralOf(address account) external view returns (int256) { return _accounts[account].collateral; }
    function positionOf(address account, uint8 market) external view returns (Position memory) { return _accounts[account].positions[market]; }

    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0 || resolutionRequired) revert InvalidTrade();
        uint256 beforeBalance = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        if (usdc.balanceOf(address(this)) - beforeBalance != amount) revert InvalidTrade();
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
        IERC3009(address(usdc)).receiveWithAuthorization(
            from, address(this), amount, validAfter, validBefore, authorizationNonce, v, r, s
        );
        if (usdc.balanceOf(address(this)) - beforeBalance != amount) revert InvalidTrade();
        _creditDeposit(from, amount);
        emit Deposited(from, amount);
    }

    function fundMaker(uint256 amount) external nonReentrant {
        if (resolutionRequired) revert InvalidTrade();
        uint256 beforeBalance = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        if (usdc.balanceOf(address(this)) - beforeBalance != amount) revert InvalidTrade();
        makerBacking += amount;
    }

    function fundInsurance(uint256 amount) external nonReentrant {
        if (resolutionRequired) revert InvalidTrade();
        uint256 beforeBalance = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        if (usdc.balanceOf(address(this)) - beforeBalance != amount) revert InvalidTrade();
        insuranceBalance += amount;
    }

    function refreshOracle(bytes calldata report) external payable nonReentrant returns (IPriceOracle.Observation memory observation) {
        observation = _verifyReport(report, type(uint8).max);
        _recordObservation(observation);
        _updateFunding(observation.market, (observation.bid + observation.ask) / 2);
    }

    function withdraw(uint256 amount) external nonReentrant {
        if (resolutionRequired || amount == 0) revert InvalidTrade();
        _requireFreshPositions(msg.sender);
        _settleAllFunding(msg.sender);
        _changeCollateral(msg.sender, -int256(amount));
        if (_accounts[msg.sender].collateral < 0 || openingEquity(msg.sender) < int256(initialMargin(msg.sender))) revert Margin();
        usdc.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
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
        bytes32 intentHash = _validateIntent(intent, approval, userSignature);
        _validateApproval(approval, makerSignatureOne, makerSignatureTwo);
        if (approval.oracleReportHash != keccak256(report)) revert OracleInvalid();
        _validateEconomics(intent, approval, observation);
        _applyAuthorizedTrade(intent, approval, intentHash);
    }

    function _applyAuthorizedTrade(TradeIntent calldata intent, MakerApproval calldata approval, bytes32 intentHash) private {
        nonceUsed[intent.account][intent.nonce] = true;
        _applyPosition(intent.account, intent.market, intent.baseDelta, approval.executionPrice);
        _chargeFee(intent.account, approval.fee);
        _enforceAggregateRisk();
        if (_accounts[intent.account].collateral < 0 || openingEquity(intent.account) < int256(initialMargin(intent.account))) revert Margin();
        emit TradeExecuted(intentHash, intent.account, intent.market, intent.baseDelta, approval.executionPrice, approval.fee);
    }

    function _validateEconomics(TradeIntent calldata intent, MakerApproval calldata approval, IPriceOracle.Observation memory observation) private view {
        uint256 absoluteBase = _abs(intent.baseDelta);
        uint256 notional = absoluteBase * approval.executionPrice / BASE;
        if (notional > MAX_TRADE_NOTIONAL) revert InvalidTrade();
        if (intent.reduceOnly && !_reduces(_accounts[intent.account].positions[intent.market].size, intent.baseDelta)) revert InvalidTrade();
        int256 required = _impactCost(intent.market, intent.baseDelta, (observation.bid + observation.ask) / 2);
        if (approval.impactCharge < required) revert InvalidTrade();
        int256 deliveredImpact = intent.baseDelta > 0
            ? int256(absoluteBase * approval.executionPrice / BASE) - int256(absoluteBase * observation.ask / BASE)
            : int256(absoluteBase * observation.bid / BASE) - int256(absoluteBase * approval.executionPrice / BASE);
        if (deliveredImpact < approval.impactCharge) revert InvalidTrade();
    }

    function liquidate(address account, uint8 market, bytes calldata report) external payable nonReentrant {
        if (market > 1) revert InvalidTrade();
        IPriceOracle.Observation memory observation = _verifyReport(report, market);
        _recordObservation(observation); _updateFunding(market, (observation.bid + observation.ask) / 2);
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
        if (maintenanceEquity(account) >= int256(maintenanceMargin(account))) revert Margin();
        Position storage position = _accounts[account].positions[market];
        uint256 absoluteBase = _abs(position.size);
        mark = position.size > 0 ? observation.bid : observation.ask;
        uint256 notional = absoluteBase * mark / BASE;
        int256 equity = maintenanceEquity(account);
        if (notional <= 10_000e6 || equity <= 0) closed = absoluteBase;
        else {
            uint256 shortfall = 2_200 * notional > uint256(equity) * 10_000
                ? 2_200 * notional - uint256(equity) * 10_000 : 0;
            uint256 neededNotional = (shortfall + 2_149) / 2_150;
            uint256 closeNotional = neededNotional < notional / 4 ? neededNotional : notional / 4;
            closed = (closeNotional * BASE + mark - 1) / mark;
            if (closed > absoluteBase) closed = absoluteBase;
        }
        int256 delta = position.size > 0 ? -int256(closed) : int256(closed);
        _applyPosition(account, market, delta, mark);
    }

    function _collectLiquidationPenalty(address account, uint256 closed, uint256 mark) private returns (uint256 penalty, uint256 reward) {
        penalty = closed * mark / BASE * LIQUIDATION_PENALTY_BPS / 10_000;
        uint256 available = _accounts[account].collateral > 0 ? uint256(_accounts[account].collateral) : 0;
        penalty = penalty < available ? penalty : available;
        reward = closed * mark / BASE * KEEPER_REWARD_BPS / 10_000;
        uint256 rewardCap = penalty / 5;
        if (reward > rewardCap) reward = rewardCap;
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
        for (uint8 i; i < 2; ++i) { uint256 n = _positionNotional(account, i); total += n * _marginRate(n, true) / 10_000; }
    }
    function maintenanceMargin(address account) public view returns (uint256 total) {
        for (uint8 i; i < 2; ++i) { uint256 n = _positionNotional(account, i); total += n * _marginRate(n, false) / 10_000; }
    }

    function pause() external onlyEmergencyOrGovernance { paused = true; ++leaderEpoch; emit EpochAdvanced(leaderEpoch); }
    function unpause() external onlyGovernance { if (resolutionRequired) revert Insolvent(); paused = false; }
    function rotateApprovers(address[3] calldata next) external onlyGovernance { _setApprovers(next); ++signerSetVersion; ++leaderEpoch; emit EpochAdvanced(leaderEpoch); }
    function setOracle(address next) external onlyGovernance { if (next == address(0)) revert Unauthorized(); oracle = IPriceOracle(next); ++policyVersion; }
    function setMarketEnabled(uint8 market, bool enabled) external onlyEmergencyOrGovernance {
        if (market > 1 || (enabled && msg.sender != governance)) revert Unauthorized(); markets[market].enabled = enabled;
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
            _accounts[account].positions[0].size = 0;
            _accounts[account].positions[1].size = 0;
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
        uint256 beforeBalance = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = usdc.balanceOf(address(this)) - beforeBalance;
        if (received != amount) revert InvalidTrade();
        resolutionAssets += received;
    }

    function _authorizeUpgrade(address) internal override onlyGovernance {}

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
    function _validateIntent(TradeIntent calldata intent, MakerApproval calldata approval, bytes calldata signature) private view returns (bytes32 digest) {
        if (block.timestamp > intent.deadline || block.timestamp > approval.deadline || intent.leaderEpoch != leaderEpoch || approval.leaderEpoch != leaderEpoch || intent.policyVersion != policyVersion || approval.policyVersion != policyVersion || approval.signerSetVersion != signerSetVersion) revert Stale();
        if (nonceUsed[intent.account][intent.nonce] || intent.account == address(0) || approval.fee > intent.maxFee) revert Replay();
        if ((intent.baseDelta > 0 && approval.executionPrice > intent.limitPrice) || (intent.baseDelta < 0 && approval.executionPrice < intent.limitPrice)) revert InvalidTrade();
        bytes32 structHash = keccak256(abi.encode(INTENT_TYPEHASH, intent.account, intent.market, intent.baseDelta, intent.limitPrice, intent.maxFee, intent.nonce, intent.deadline, intent.leaderEpoch, intent.policyVersion, intent.reduceOnly));
        digest = _hashTypedDataV4(structHash);
        if (approval.intentHash != digest || !SignatureChecker.isValidSignatureNowCalldata(intent.account, digest, signature)) revert InvalidSignature();
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
    function _updateFunding(uint8 marketId, uint256 mark) private {
        Market storage market = markets[marketId]; uint256 elapsed = block.timestamp - market.fundingTime; if (elapsed == 0) return;
        if (elapsed > 7 days) elapsed = 7 days;
        int256 skewNotional = market.aggregateBase * int256(mark) / int256(BASE);
        int256 apr = skewNotional * int256(RATE) / int256(MAX_MARKET_NOTIONAL);
        if (apr > int256(RATE)) apr = int256(RATE); if (apr < -int256(RATE)) apr = -int256(RATE);
        market.fundingIndex += int256(mark) * apr * int256(elapsed) / int256(RATE * YEAR);
        market.fundingTime += uint64(elapsed);
    }
    function _settleAllFunding(address account) private { for (uint8 i; i < 2; ++i) _settleFunding(account, i); }
    function _settleFunding(address account, uint8 marketId) private {
        Position storage p = _accounts[account].positions[marketId]; int256 change = markets[marketId].fundingIndex - p.lastFundingIndex;
        if (change != 0 && p.size != 0) { int256 payment = p.size * change / int256(BASE); _changeCollateral(account, -payment); _changeMaker(payment); }
        p.lastFundingIndex = markets[marketId].fundingIndex;
    }
    function _applyPosition(address account, uint8 marketId, int256 delta, uint256 price) private {
        Position storage p = _accounts[account].positions[marketId]; int256 old = p.size; int256 next = old + delta;
        if (old == 0 || (old > 0) == (delta > 0)) {
            uint256 combined = _abs(next); p.entryPrice = combined == 0 ? 0 : (_abs(old) * p.entryPrice + _abs(delta) * price) / combined;
        } else {
            uint256 closed = _abs(delta) < _abs(old) ? _abs(delta) : _abs(old);
            int256 pnl = old > 0 ? int256(closed * price / BASE) - int256(closed * p.entryPrice / BASE) : int256(closed * p.entryPrice / BASE) - int256(closed * price / BASE);
            _changeCollateral(account, pnl); _changeMaker(-pnl);
            if (next == 0) p.entryPrice = 0; else if ((next > 0) != (old > 0)) p.entryPrice = price;
        }
        p.size = next; p.lastFundingIndex = markets[marketId].fundingIndex; markets[marketId].aggregateBase += delta;
    }
    function _chargeFee(address account, uint256 fee) private {
        _changeCollateral(account, -int256(fee));
        uint256 insuranceShare = insuranceBalance < baseRiskCapitalTarget / 4 ? fee / 5 : fee / 10;
        insuranceBalance += insuranceShare; makerBacking += fee - insuranceShare;
    }
    function _changeCollateral(address account, int256 delta) private { _accounts[account].collateral += delta; totalCustomerCollateral += delta; }
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
        return p.size > 0 ? int256(_abs(p.size) * mark / BASE) - int256(_abs(p.size) * p.entryPrice / BASE) : int256(_abs(p.size) * p.entryPrice / BASE) - int256(_abs(p.size) * mark / BASE);
    }
    function _positionNotional(address account, uint8 marketId) private view returns (uint256) {
        Position storage p = _accounts[account].positions[marketId]; return _abs(p.size) * markets[marketId].lastAsk / BASE;
    }
    function _marginRate(uint256 notional, bool initial) private pure returns (uint256) {
        if (notional <= 25_000e6) return initial ? 2_000 : 1_200; if (notional <= 50_000e6) return initial ? 2_500 : 1_500; if (notional <= 100_000e6) return initial ? 3_300 : 2_000; revert Margin();
    }
    function _enforceAggregateRisk() private view {
        int256 btc = markets[0].aggregateBase * int256(_mid(0)) / int256(BASE); int256 eth = markets[1].aggregateBase * int256(_mid(1)) / int256(BASE);
        if (_abs(btc) > MAX_MARKET_NOTIONAL || _abs(eth) > MAX_MARKET_NOTIONAL || _stressLoss(btc, eth) > makerBacking / 4) revert Margin();
    }
    function _impactCost(uint8 market, int256 baseDelta, uint256 mark) private view returns (int256) {
        int256 btc = markets[0].aggregateBase * int256(_mid(0)) / int256(BASE); int256 eth = markets[1].aggregateBase * int256(_mid(1)) / int256(BASE); int256 delta = baseDelta * int256(mark) / int256(BASE);
        int256 beforeValue = _potential(btc, eth); if (market == 0) btc += delta; else eth += delta; return _potential(btc, eth) - beforeValue;
    }
    function _potential(int256 btc, int256 eth) private pure returns (int256) { return _floorDiv(int256(K_BTC) * btc * btc + 2 * int256(K_CROSS) * btc * eth + int256(K_ETH) * eth * eth, int256(2 * RATE * 1e6)); }
    function _stressLoss(int256 btc, int256 eth) private pure returns (uint256) {
        int256 best; best = _max(best, _scenario(btc,eth,20,25)); best = _max(best,_scenario(btc,eth,-20,-25)); best = _max(best,_scenario(btc,eth,15,-20)); best = _max(best,_scenario(btc,eth,-15,20)); best = _max(best,_scenario(btc,eth,40,50)); best = _max(best,_scenario(btc,eth,-40,-50)); return uint256(best);
    }
    function _scenario(int256 btc,int256 eth,int256 br,int256 er) private pure returns (int256) { return _floorDiv(btc*br,100)+_floorDiv(eth*er,100); }
    function _mid(uint8 market) private view returns (uint256) { Market storage m=markets[market]; if (m.aggregateBase != 0 && (m.lastPriceTime == 0 || block.timestamp-m.lastPriceTime>MAX_ORACLE_AGE)) revert Stale(); return (m.lastBid+m.lastAsk)/2; }
    function _reduces(int256 old, int256 delta) private pure returns (bool) { int256 next=old+delta; return old != 0 && _abs(next)<_abs(old) && (next==0 || (next>0)==(old>0)); }
    function _abs(int256 value) private pure returns (uint256) { return uint256(value < 0 ? -value : value); }
    function _max(int256 a,int256 b) private pure returns(int256){return a>b?a:b;}
    function _floorDiv(int256 n,int256 d) private pure returns(int256 q){q=n/d;if(n<0&&n%d!=0)--q;}
    function _median3(uint256 a,uint256 b,uint256 c) private pure returns(uint256){if(a>b)(a,b)=(b,a);if(b>c)(b,c)=(c,b);if(a>b)(a,b)=(b,a);return b;}
    function _resolutionEquity(address account) private view returns (int256 value) {
        Account storage a = _accounts[account]; value = a.collateral;
        for (uint8 i; i < 2; ++i) { Position storage p=a.positions[i]; if(p.size==0) continue; uint256 price=resolutionPrice[i]; value += p.size>0 ? int256(_abs(p.size)*price/BASE)-int256(_abs(p.size)*p.entryPrice/BASE) : int256(_abs(p.size)*p.entryPrice/BASE)-int256(_abs(p.size)*price/BASE); }
    }
}
