// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

interface IERC1271 {
    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4);
}

library SignatureValidation {
    bytes4 internal constant MAGIC = 0x1626ba7e;
    // secp256k1n / 2, used to reject malleable high-s signatures.
    uint256 internal constant HALF_N =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    function recover(bytes32 digest, bytes calldata signature) internal pure returns (address signer) {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > HALF_N || (v != 27 && v != 28)) return address(0);
        signer = ecrecover(digest, v, r, s);
    }

    function valid(address signer, bytes32 digest, bytes calldata signature) internal view returns (bool) {
        if (signer.code.length == 0) return recover(digest, signature) == signer && signer != address(0);
        (bool ok, bytes memory result) = signer.staticcall(
            abi.encodeCall(IERC1271.isValidSignature, (digest, signature))
        );
        return ok && result.length >= 32 && bytes4(result) == MAGIC;
    }
}

/// @notice Executable authorization boundary for the RFQ design.
/// @dev Reference implementation for review and invariant work; not deployment-ready clearing logic.
contract RFQAuthorization {
    using SignatureValidation for address;

    uint256 public constant RATE = 1e12;
    uint256 public constant USDC = 1e6;
    uint256 public constant K_BTC = 10_000;
    uint256 public constant K_ETH = 12_000;
    uint256 public constant K_CROSS = 6_573;
    uint256 public constant MAX_ABS_TRADE = 25_000e6;
    uint256 public constant MAX_ABS_MARKET_EXPOSURE = 250_000e6;

    bytes32 public constant INTENT_TYPEHASH = keccak256(
        "TradeIntent(address account,uint8 market,int256 notionalDelta,uint256 limitPrice,uint256 maxFee,uint256 nonce,uint64 deadline,uint64 leaderEpoch,uint64 policyVersion)"
    );
    bytes32 public constant APPROVAL_TYPEHASH = keccak256(
        "MakerApproval(bytes32 intentHash,uint256 executionPrice,int256 impactCharge,uint256 fee,bytes32 oracleReportHash,uint64 deadline,uint64 leaderEpoch,uint64 signerSetVersion,uint64 policyVersion)"
    );
    bytes32 private immutable _DOMAIN_SEPARATOR;
    uint256 private immutable _DOMAIN_CHAIN_ID;

    struct TradeIntent {
        address account;
        uint8 market; // 0=BTC, 1=ETH
        int256 notionalDelta; // signed USDC micro-units of customer exposure
        uint256 limitPrice;
        uint256 maxFee;
        uint256 nonce;
        uint64 deadline;
        uint64 leaderEpoch;
        uint64 policyVersion;
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

    address public immutable governance;
    uint256 public immutable baseRiskCapital;
    address[3] public approvers;
    mapping(address => bool) public isApprover;
    mapping(address => mapping(uint256 => bool)) public nonceUsed;
    int256 public btcExposure;
    int256 public ethExposure;
    uint64 public leaderEpoch = 1;
    uint64 public signerSetVersion = 1;
    uint64 public policyVersion = 1;
    bool public paused;

    event TradeAuthorized(bytes32 indexed intentHash, address indexed account, uint8 market, int256 delta);
    event EpochAdvanced(uint64 indexed epoch);

    error InvalidAuthorization();
    error StaleAuthorization();
    error Replay();
    error UnsafeImpactCharge();
    error InvalidTrade();
    error Unauthorized();

    constructor(address governance_, address[3] memory approvers_, uint256 baseRiskCapital_) {
        if (governance_ == address(0) || baseRiskCapital_ == 0) revert Unauthorized();
        governance = governance_;
        baseRiskCapital = baseRiskCapital_;
        for (uint256 i; i < 3; ++i) {
            if (approvers_[i] == address(0) || isApprover[approvers_[i]]) revert InvalidAuthorization();
            approvers[i] = approvers_[i];
            isApprover[approvers_[i]] = true;
        }
        _DOMAIN_CHAIN_ID = block.chainid;
        _DOMAIN_SEPARATOR = _makeDomainSeparator();
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert Unauthorized();
        _;
    }

    function domainSeparator() public view returns (bytes32) {
        return block.chainid == _DOMAIN_CHAIN_ID ? _DOMAIN_SEPARATOR : _makeDomainSeparator();
    }

    function hashIntent(TradeIntent calldata intent) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            INTENT_TYPEHASH, intent.account, intent.market, intent.notionalDelta, intent.limitPrice,
            intent.maxFee, intent.nonce, intent.deadline, intent.leaderEpoch, intent.policyVersion
        ));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function hashApproval(MakerApproval calldata approval) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            APPROVAL_TYPEHASH, approval.intentHash, approval.executionPrice, approval.impactCharge,
            approval.fee, approval.oracleReportHash, approval.deadline, approval.leaderEpoch,
            approval.signerSetVersion, approval.policyVersion
        ));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function authorizeAndApply(
        TradeIntent calldata intent,
        MakerApproval calldata approval,
        bytes calldata userSignature,
        bytes calldata makerSignatureOne,
        bytes calldata makerSignatureTwo
    ) external {
        bytes32 intentHash = _validateIntent(intent, approval, userSignature);
        _validateMakerApproval(approval, makerSignatureOne, makerSignatureTwo);

        int256 required = impactCost(btcExposure, ethExposure, intent.market, intent.notionalDelta);
        if (approval.impactCharge < required) revert UnsafeImpactCharge();

        // Effects precede all external clearing/oracle integration in the final implementation.
        nonceUsed[intent.account][intent.nonce] = true;
        int256 postBtc = btcExposure;
        int256 postEth = ethExposure;
        if (intent.market == 0) postBtc += intent.notionalDelta;
        else postEth += intent.notionalDelta;
        if (_abs(postBtc) > MAX_ABS_MARKET_EXPOSURE || _abs(postEth) > MAX_ABS_MARKET_EXPOSURE) {
            revert InvalidTrade();
        }
        if (stressLoss(postBtc, postEth) > baseRiskCapital / 4) revert InvalidTrade();
        btcExposure = postBtc;
        ethExposure = postEth;
        emit TradeAuthorized(intentHash, intent.account, intent.market, intent.notionalDelta);
    }

    function _validateIntent(
        TradeIntent calldata intent,
        MakerApproval calldata approval,
        bytes calldata userSignature
    ) private view returns (bytes32 intentHash) {
        if (paused) revert InvalidTrade();
        if (
            intent.market > 1 || intent.notionalDelta == 0 || _abs(intent.notionalDelta) > MAX_ABS_TRADE
            || intent.account == address(0)
        ) revert InvalidTrade();
        if (
            block.timestamp > intent.deadline || block.timestamp > approval.deadline
            || intent.leaderEpoch != leaderEpoch || approval.leaderEpoch != leaderEpoch
            || intent.policyVersion != policyVersion || approval.policyVersion != policyVersion
            || approval.signerSetVersion != signerSetVersion
        ) revert StaleAuthorization();

        intentHash = hashIntent(intent);
        if (approval.intentHash != intentHash || !intent.account.valid(intentHash, userSignature)) {
            revert InvalidAuthorization();
        }
        if (nonceUsed[intent.account][intent.nonce]) revert Replay();
        if (approval.fee > intent.maxFee) revert InvalidTrade();
        if (
            (intent.notionalDelta > 0 && approval.executionPrice > intent.limitPrice)
            || (intent.notionalDelta < 0 && approval.executionPrice < intent.limitPrice)
        ) revert InvalidTrade();
    }

    function _validateMakerApproval(
        MakerApproval calldata approval,
        bytes calldata makerSignatureOne,
        bytes calldata makerSignatureTwo
    ) private view {
        bytes32 approvalHash = hashApproval(approval);
        address signerOne = SignatureValidation.recover(approvalHash, makerSignatureOne);
        address signerTwo = SignatureValidation.recover(approvalHash, makerSignatureTwo);
        if (
            signerOne == signerTwo || !isApprover[signerOne] || !isApprover[signerTwo]
            || signerOne == address(0)
        ) revert InvalidAuthorization();

    }

    function impactCost(int256 btc, int256 eth, uint8 market, int256 delta) public pure returns (int256) {
        if (market > 1) revert InvalidTrade();
        int256 beforeValue = potential(btc, eth);
        if (market == 0) btc += delta;
        else eth += delta;
        return potential(btc, eth) - beforeValue;
    }

    function potential(int256 btc, int256 eth) public pure returns (int256) {
        // Launch caps keep products far below int256 range. The production version must
        // preserve explicit cap checks if these constants or market count change.
        int256 numerator = int256(K_BTC) * btc * btc
            + 2 * int256(K_CROSS) * btc * eth
            + int256(K_ETH) * eth * eth;
        return _floorDiv(numerator, int256(2 * RATE * USDC));
    }

    function stressLoss(int256 btc, int256 eth) public pure returns (uint256) {
        int256 greatest;
        greatest = _max(greatest, _scenario(btc, eth, 200_000_000_000, 250_000_000_000));
        greatest = _max(greatest, _scenario(btc, eth, -200_000_000_000, -250_000_000_000));
        greatest = _max(greatest, _scenario(btc, eth, 150_000_000_000, -200_000_000_000));
        greatest = _max(greatest, _scenario(btc, eth, -150_000_000_000, 200_000_000_000));
        greatest = _max(greatest, _scenario(btc, eth, 400_000_000_000, 500_000_000_000));
        greatest = _max(greatest, _scenario(btc, eth, -400_000_000_000, -500_000_000_000));
        return uint256(greatest);
    }

    function advanceEpoch() external onlyGovernance {
        ++leaderEpoch;
        emit EpochAdvanced(leaderEpoch);
    }

    function rotateApprovers(address[3] calldata next) external onlyGovernance {
        for (uint256 i; i < 3; ++i) isApprover[approvers[i]] = false;
        for (uint256 i; i < 3; ++i) {
            if (next[i] == address(0) || isApprover[next[i]]) revert InvalidAuthorization();
            approvers[i] = next[i];
            isApprover[next[i]] = true;
        }
        ++signerSetVersion;
        ++leaderEpoch;
        emit EpochAdvanced(leaderEpoch);
    }

    function setPaused(bool value) external onlyGovernance { paused = value; }

    function _makeDomainSeparator() private view returns (bytes32) {
        return keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("RFQ Markets"), keccak256("1"), block.chainid, address(this)
        ));
    }

    function _abs(int256 value) private pure returns (uint256) {
        return uint256(value < 0 ? -value : value);
    }

    function _floorDiv(int256 numerator, int256 denominator) private pure returns (int256) {
        int256 quotient = numerator / denominator;
        if (numerator < 0 && numerator % denominator != 0) --quotient;
        return quotient;
    }


    function _scenario(int256 btc, int256 eth, int256 btcReturn, int256 ethReturn) private pure returns (int256) {
        return _floorDiv(btc * btcReturn, int256(RATE))
            + _floorDiv(eth * ethReturn, int256(RATE));
    }

    function _max(int256 left, int256 right) private pure returns (int256) {
        return left > right ? left : right;
    }
}
