// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

/// @title RFQ Markets signed price oracle
/// @notice Accepts price batches signed by a set of independent oracle nodes and returns, per market, the
/// consensus of at least `threshold` distinct signers.
/// @dev Each node streams prices from several exchanges, takes a filtered median and signs a `PriceBatch`
/// (EIP-712, domain "RFQ Markets Oracle" / "1" / this contract) about once a second. A report is
/// `abi.encode(SignedPriceBatch[])`. For every market present in at least `threshold` of the batches:
/// - the signers' mids must agree within `maxDeviationBps`, otherwise the market is left out;
/// - the price is the median of their bids and the median of their asks (with an even count, the mean of the
///   middle two, rounded down for the bid and up for the ask);
/// - a move larger than the market's jump limit within `jumpWindow` of the last accepted price leaves the
///   market out until the window passes.
/// Markets left out simply have no fresh price, so the clearing house refuses anything that needs one: a
/// disagreement or a jump pauses that market instead of letting a doubtful price through.
contract SignedPriceOracle is IPriceOracle, EIP712, Ownable2Step {
    struct Price {
        uint8 market;
        uint256 bid;
        uint256 ask;
    }

    struct SignedPriceBatch {
        uint64 observedAt;
        Price[] prices; // strictly ascending by market
        bytes signature;
    }

    bytes32 public constant PRICE_TYPEHASH = keccak256("Price(uint8 market,uint256 bid,uint256 ask)");
    bytes32 public constant PRICE_BATCH_TYPEHASH =
        keccak256("PriceBatch(uint64 observedAt,Price[] prices)Price(uint8 market,uint256 bid,uint256 ask)");

    uint256 public constant MAX_SIGNERS = 16;
    /// @dev Reports are valid this long after the oldest batch in them; matches the clearing house's limit.
    uint64 public constant VALIDITY = 15;

    address public clearing;
    address[] private _signers;
    mapping(address => bool) public isSigner;
    uint8 public threshold;
    /// @notice Largest allowed spread between the signers' mids for one market, in basis points.
    uint16 public maxDeviationBps;
    /// @notice Largest allowed gap between the batches' timestamps, in seconds.
    uint64 public maxSkew;
    /// @notice Default jump limit in basis points; 0 disables the jump guard.
    uint16 public defaultMaxJumpBps;
    uint64 public jumpWindow;
    mapping(uint8 market => uint16) public marketMaxJumpBps; // 0 = use the default
    mapping(uint8 market => uint256) public lastMid;
    mapping(uint8 market => uint64) public lastTime;

    event ClearingSet(address indexed clearing);
    event SignersSet(address[] signers, uint8 threshold);
    event ConsensusParamsSet(uint16 maxDeviationBps, uint64 maxSkew);
    event JumpGuardSet(uint16 defaultMaxJumpBps, uint64 jumpWindow);
    event MarketJumpLimitSet(uint8 indexed market, uint16 maxJumpBps);
    event MarketSkipped(uint8 indexed market, uint8 reason); // 1 = signers disagree, 2 = jump

    error Unauthorized();
    error InvalidReport();
    error InvalidConfiguration();

    constructor(
        address owner_,
        address[] memory signers_,
        uint8 threshold_,
        uint16 maxDeviationBps_,
        uint64 maxSkew_,
        uint16 defaultMaxJumpBps_,
        uint64 jumpWindow_
    ) EIP712("RFQ Markets Oracle", "1") Ownable(owner_) {
        _setSigners(signers_, threshold_);
        _setConsensusParams(maxDeviationBps_, maxSkew_);
        _setJumpGuard(defaultMaxJumpBps_, jumpWindow_);
    }

    // =======================================================================
    // Verification
    // =======================================================================

    function verify(bytes calldata report) external payable returns (Observation[] memory observations) {
        if (msg.sender != clearing || clearing == address(0)) revert Unauthorized();
        if (msg.value != 0) revert InvalidReport();
        SignedPriceBatch[] memory batches = abi.decode(report, (SignedPriceBatch[]));
        uint256 count = batches.length;
        if (count < threshold || count > MAX_SIGNERS) revert InvalidReport();

        address[] memory seen = new address[](count);
        uint64 oldest = type(uint64).max;
        uint64 newest;
        uint256 maxPrices;
        for (uint256 i; i < count; ++i) {
            SignedPriceBatch memory batch = batches[i];
            address signer = ECDSA.recover(_hashTypedDataV4(hashBatch(batch.observedAt, batch.prices)), batch.signature);
            if (!isSigner[signer]) revert Unauthorized();
            for (uint256 j; j < i; ++j) {
                if (seen[j] == signer) revert InvalidReport();
            }
            seen[i] = signer;
            Price[] memory prices = batch.prices;
            for (uint256 j; j < prices.length; ++j) {
                if (prices[j].bid == 0 || prices[j].ask < prices[j].bid) revert InvalidReport();
                if (j != 0 && prices[j].market <= prices[j - 1].market) revert InvalidReport();
            }
            if (prices.length > maxPrices) maxPrices = prices.length;
            if (batch.observedAt < oldest) oldest = batch.observedAt;
            if (batch.observedAt > newest) newest = batch.observedAt;
        }
        if (newest - oldest > maxSkew || oldest > block.timestamp) revert InvalidReport();

        observations = new Observation[](maxPrices);
        uint256 produced;
        uint256[] memory cursor = new uint256[](count);
        uint256[] memory bids = new uint256[](count);
        uint256[] memory asks = new uint256[](count);
        uint256[] memory mids = new uint256[](count);
        while (true) {
            // The next market is the smallest one still unread in any batch.
            uint256 market = type(uint256).max;
            for (uint256 i; i < count; ++i) {
                if (cursor[i] < batches[i].prices.length && batches[i].prices[cursor[i]].market < market) {
                    market = batches[i].prices[cursor[i]].market;
                }
            }
            if (market == type(uint256).max) break;
            uint256 signed;
            for (uint256 i; i < count; ++i) {
                if (cursor[i] < batches[i].prices.length && batches[i].prices[cursor[i]].market == market) {
                    Price memory price = batches[i].prices[cursor[i]++];
                    bids[signed] = price.bid;
                    asks[signed] = price.ask;
                    mids[signed] = (price.bid + price.ask) / 2;
                    ++signed;
                }
            }
            if (signed < threshold) continue;
            (Observation memory observation, uint8 skipped) =
                _consensus(uint8(market), bids, asks, mids, signed, oldest);
            if (skipped != 0) {
                emit MarketSkipped(uint8(market), skipped);
                continue;
            }
            observations[produced++] = observation;
        }
        assembly {
            mstore(observations, produced)
        }
    }

    function hashBatch(uint64 observedAt, Price[] memory prices) public pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](prices.length);
        for (uint256 i; i < prices.length; ++i) {
            hashes[i] = keccak256(abi.encode(PRICE_TYPEHASH, prices[i].market, prices[i].bid, prices[i].ask));
        }
        return keccak256(abi.encode(PRICE_BATCH_TYPEHASH, observedAt, keccak256(abi.encodePacked(hashes))));
    }

    /// @notice The EIP-712 digest a node signs for `observedAt` and `prices`.
    function batchDigest(uint64 observedAt, Price[] memory prices) external view returns (bytes32) {
        return _hashTypedDataV4(hashBatch(observedAt, prices));
    }

    // =======================================================================
    // Configuration (owner = governance)
    // =======================================================================

    /// @notice Points the oracle at the clearing house, the only caller allowed to verify.
    function setClearing(address next) external onlyOwner {
        if (next == address(0)) revert InvalidConfiguration();
        clearing = next;
        emit ClearingSet(next);
    }

    function setSigners(address[] calldata next, uint8 threshold_) external onlyOwner {
        _setSigners(next, threshold_);
    }

    function setConsensusParams(uint16 maxDeviationBps_, uint64 maxSkew_) external onlyOwner {
        _setConsensusParams(maxDeviationBps_, maxSkew_);
    }

    function setJumpGuard(uint16 defaultMaxJumpBps_, uint64 jumpWindow_) external onlyOwner {
        _setJumpGuard(defaultMaxJumpBps_, jumpWindow_);
    }

    /// @notice Overrides the jump limit for one market; 0 falls back to the default.
    function setMarketJumpLimit(uint8 market, uint16 maxJumpBps) external onlyOwner {
        if (maxJumpBps > 10_000) revert InvalidConfiguration();
        marketMaxJumpBps[market] = maxJumpBps;
        emit MarketJumpLimitSet(market, maxJumpBps);
    }

    function signers() external view returns (address[] memory) {
        return _signers;
    }

    // =======================================================================
    // Internals
    // =======================================================================

    function _consensus(
        uint8 market,
        uint256[] memory bids,
        uint256[] memory asks,
        uint256[] memory mids,
        uint256 signed,
        uint64 observedAt
    ) private returns (Observation memory observation, uint8 skipped) {
        uint256 low = type(uint256).max;
        uint256 high;
        for (uint256 i; i < signed; ++i) {
            if (mids[i] < low) low = mids[i];
            if (mids[i] > high) high = mids[i];
        }
        if ((high - low) * 10_000 > low * maxDeviationBps) return (observation, 1);

        uint256 bid = _median(bids, signed, false);
        uint256 ask = _median(asks, signed, true);
        uint256 mid = (bid + ask) / 2;
        uint256 limit = marketMaxJumpBps[market];
        if (limit == 0) limit = defaultMaxJumpBps;
        uint256 previous = lastMid[market];
        uint64 previousTime = lastTime[market];
        if (limit != 0 && previous != 0 && observedAt < previousTime + jumpWindow) {
            uint256 move = mid > previous ? mid - previous : previous - mid;
            if (move * 10_000 > previous * limit) return (observation, 2);
        }
        if (observedAt > previousTime) {
            lastMid[market] = mid;
            lastTime[market] = observedAt;
        }
        observation = Observation(market, bid, ask, observedAt, observedAt + VALIDITY);
    }

    /// @dev Sorts the first `n` values in place (n <= MAX_SIGNERS) and returns their median.
    function _median(uint256[] memory values, uint256 n, bool roundUp) private pure returns (uint256) {
        for (uint256 i = 1; i < n; ++i) {
            uint256 value = values[i];
            uint256 j = i;
            while (j != 0 && values[j - 1] > value) {
                values[j] = values[j - 1];
                --j;
            }
            values[j] = value;
        }
        if (n % 2 == 1) return values[n / 2];
        uint256 sum = values[n / 2 - 1] + values[n / 2];
        return roundUp ? (sum + 1) / 2 : sum / 2;
    }

    function _setSigners(address[] memory next, uint8 threshold_) private {
        // A majority threshold means two disjoint signer subsets can never both produce a price.
        if (next.length == 0 || next.length > MAX_SIGNERS || threshold_ == 0 || uint256(threshold_) * 2 <= next.length)
        {
            revert InvalidConfiguration();
        }
        if (threshold_ > next.length) revert InvalidConfiguration();
        for (uint256 i; i < _signers.length; ++i) {
            isSigner[_signers[i]] = false;
        }
        for (uint256 i; i < next.length; ++i) {
            if (next[i] == address(0) || isSigner[next[i]]) revert InvalidConfiguration();
            isSigner[next[i]] = true;
        }
        _signers = next;
        threshold = threshold_;
        emit SignersSet(next, threshold_);
    }

    function _setConsensusParams(uint16 maxDeviationBps_, uint64 maxSkew_) private {
        if (maxDeviationBps_ == 0 || maxDeviationBps_ > 1_000 || maxSkew_ > VALIDITY) revert InvalidConfiguration();
        maxDeviationBps = maxDeviationBps_;
        maxSkew = maxSkew_;
        emit ConsensusParamsSet(maxDeviationBps_, maxSkew_);
    }

    function _setJumpGuard(uint16 defaultMaxJumpBps_, uint64 jumpWindow_) private {
        if (defaultMaxJumpBps_ > 10_000 || jumpWindow_ > 1 days) revert InvalidConfiguration();
        defaultMaxJumpBps = defaultMaxJumpBps_;
        jumpWindow = jumpWindow_;
        emit JumpGuardSet(defaultMaxJumpBps_, jumpWindow_);
    }
}
