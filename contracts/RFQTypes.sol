// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

// Shared types and constants for the clearing contract and its linked libraries.
//
// Units used everywhere:
// - USDC amounts are 6-decimal micro-units (1 USDC = 1e6).
// - Base sizes are 18-decimal token units (1 BTC = 1e18).
// - Prices are USDC micro-units per whole token, so notional = size * price / 1e18.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

uint256 constant BASE_UNIT = 1e18;
/// @dev Markets are registered by governance with ids 0, 1, 2, ... up to this many. It bounds the loops over
/// all markets (exposure, stress, resolution) and fits a session's market mask in one word.
uint8 constant MAX_MARKETS = 128;

/// @dev Oracle reports older than this are rejected, and open legs must have a price this fresh.
uint256 constant MAX_ORACLE_AGE = 15;
/// @dev Maximum bid/ask width accepted from the oracle, in basis points of mid.
uint256 constant MAX_ORACLE_WIDTH_BPS = 100;

uint256 constant ABSOLUTE_MAX_TRADE_NOTIONAL = 1_000_000e6;
uint256 constant ABSOLUTE_MAX_MARKET_NOTIONAL = 5_000_000e6;

/// @dev Anti-spam floor for an account's first deposit; registered accounts are walked during resolution.
uint256 constant MIN_FIRST_DEPOSIT = 10e6;
uint256 constant MAX_SESSION_DURATION = 30 days;

/// @dev Resolution prices are the median of three post-trigger oracle samples spanning at least 30 seconds.
uint8 constant RESOLUTION_SAMPLES = 3;
uint64 constant RESOLUTION_MIN_SAMPLE_SPAN = 30;

/// @dev A reported maker incident must persist this long before anyone may force resolution.
uint64 constant DEFAULT_INCIDENT_GRACE_PERIOD = 72 hours;
uint64 constant MIN_INCIDENT_GRACE_PERIOD = 1 hours;
uint64 constant MAX_INCIDENT_GRACE_PERIOD = 30 days;

// ---------------------------------------------------------------------------
// EIP-712
// ---------------------------------------------------------------------------

bytes32 constant EIP712_DOMAIN_TYPEHASH =
    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
bytes32 constant EIP712_NAME_HASH = keccak256("RFQ Markets");
bytes32 constant EIP712_VERSION_HASH = keccak256("1");

bytes32 constant TRADE_INTENT_TYPEHASH = keccak256(
    "TradeIntent(address account,uint8 market,int256 baseDelta,uint256 limitPrice,uint256 maxFee,uint256 nonce,uint64 deadline,bool reduceOnly)"
);
bytes32 constant MAKER_APPROVAL_TYPEHASH = keccak256(
    "MakerApproval(bytes32 intentHash,uint256 executionPrice,int256 impactCharge,uint256 fee,bytes32 oracleReportHash,uint64 deadline,uint64 leaderEpoch,uint64 signerSetVersion,uint64 policyVersion)"
);
bytes32 constant WITHDRAWAL_TYPEHASH =
    keccak256("WithdrawalIntent(address account,address recipient,uint256 amount,uint256 nonce,uint64 deadline)");
bytes32 constant CANCEL_TYPEHASH = keccak256("CancelIntent(address account,uint256 nonce,uint64 deadline)");
bytes32 constant CLOSE_TYPEHASH = keccak256("CloseIntent(address account,uint8 market,uint256 nonce,uint64 deadline)");
bytes32 constant SESSION_GRANT_TYPEHASH = keccak256(
    "SessionGrant(address account,address session,uint256 marketMask,uint128 maxTradeNotional,uint128 maxCumulativeNotional,uint128 maxFee,uint64 validUntil,uint256 nonce,uint64 deadline)"
);

// ---------------------------------------------------------------------------
// Accounts and markets
// ---------------------------------------------------------------------------

struct Position {
    int256 size; // signed base units; positive is long
    uint256 entryPrice;
    int256 lastFundingIndex;
}

struct Account {
    int256 collateral;
    mapping(uint8 market => Position) positions;
    uint256 openMarkets; // bit i set while the account holds a position in market i
}

struct Market {
    int256 aggregateBase; // net customer base; the maker holds the opposite
    int256 fundingIndex;
    uint64 fundingTime;
    uint64 lastPriceTime; // never decreases: older reports cannot overwrite newer ones
    uint256 lastBid;
    uint256 lastAsk;
    bool enabled;
}

/// @notice Notional limits for one market, in USDC micro-units.
struct MarketLimits {
    uint128 maxTradeNotional; // per trade
    uint128 maxMarketNotional; // net customer skew; also the funding-rate denominator
}

/// @notice Gross customer book for one market, in base units, and its limits valued at the ask.
struct ExposureBook {
    uint256 longBase;
    uint256 shortBase;
    uint128 grossLimit;
    uint128 sideLimit;
}

/// @notice Per-market risk parameters, set by governance.
struct MarketParams {
    bytes32 symbol; // e.g. "BTC"; one market unit is 1e18 base units of this symbol
    uint32 impactK; // inventory-impact coefficient (BTC 10_000, ETH 12_000; see ECONOMIC-SPECIFICATION.md)
    uint16 shockBps; // stress move applied to the market's net customer skew (BTC 4_000 = 40%)
    uint16 marginScaleBps; // multiplier on the tiered margin rates; 10_000 = the base tiers
}

/// @notice Configuration for a market, used by `initialize` and `addMarket`.
struct MarketConfig {
    bytes32 symbol;
    bool enabled;
    uint128 maxTradeNotional;
    uint128 maxMarketNotional;
    uint128 grossLimit;
    uint128 sideLimit;
    uint32 impactK;
    uint16 shockBps;
    uint16 marginScaleBps;
}

// ---------------------------------------------------------------------------
// Signed messages
// ---------------------------------------------------------------------------

struct TradeIntent {
    address account;
    uint8 market;
    int256 baseDelta;
    uint256 limitPrice;
    uint256 maxFee;
    uint256 nonce;
    uint64 deadline;
    bool reduceOnly;
}

struct MakerApproval {
    bytes32 intentHash;
    uint256 executionPrice;
    int256 impactCharge;
    uint256 fee;
    bytes32 oracleReportHash;
    uint64 deadline;
    uint64 leaderEpoch;
    uint64 signerSetVersion;
    uint64 policyVersion;
}

struct Session {
    address account;
    uint64 validUntil;
    uint256 marketMask;
    uint128 maxTradeNotional;
    uint128 maxCumulativeNotional;
    uint128 usedNotional;
    uint128 maxFee;
}

struct SessionGrant {
    address account;
    address session;
    uint256 marketMask;
    uint128 maxTradeNotional;
    uint128 maxCumulativeNotional;
    uint128 maxFee;
    uint64 validUntil;
    uint256 nonce;
    uint64 deadline;
}

// ---------------------------------------------------------------------------
// Global resolution
// ---------------------------------------------------------------------------

struct ResolutionState {
    uint64 triggerTime;
    bool pricesReady;
    bool finalized;
    mapping(uint8 market => uint8) sampleCount;
    mapping(uint8 market => uint64) firstSampleTime;
    mapping(uint8 market => uint64) lastSampleTime;
    mapping(uint8 market => uint256[3]) samples;
    mapping(uint8 market => uint256) price;
    uint256 cursor;
    uint256 totalClaims;
    uint256 assets;
    mapping(address => uint256) claim;
    mapping(address => uint256) paid;
}

// ---------------------------------------------------------------------------
// Errors (shared, so a revert decodes the same whether it comes from the clearing contract or a library)
// ---------------------------------------------------------------------------

error Unauthorized();
error InvalidTrade();
error InvalidSignature();
error Stale();
error Replay();
error Margin();
error OracleInvalid();
error Insolvent();
error InvalidConfiguration();
error IncidentGracePeriod();
error NoSurplus();
