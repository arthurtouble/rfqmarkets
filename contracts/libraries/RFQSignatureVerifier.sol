// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {RFQClearingNamespace, RFQClearingStorage} from "../RFQClearingStorage.sol";
import "../RFQTypes.sol";

/// @notice EIP-712 authorization for RFQClearing: trader intents, owner actions and the 2-of-3 approver quorum.
/// @dev Linked library run by DELEGATECALL, so `address(this)` is the clearing proxy and the domain binds to it.
library RFQSignatureVerifier {
    function hashTypedData(bytes32 structHash) public view returns (bytes32) {
        return _hashTypedData(structHash);
    }

    /// @notice Verifies an owner-signed action (withdraw, cancel, close, session grant) and burns its nonce.
    /// @dev EOAs, ERC-1271 contract wallets and EIP-7702 accounts are all accepted.
    function consumeOwnerAuthorization(
        address account,
        uint256 nonce,
        uint64 deadline,
        bytes32 structHash,
        bytes calldata signature
    ) public {
        mapping(uint256 => bool) storage used = RFQClearingStorage.layout().nonceUsed[account];
        if (block.timestamp > deadline || account == address(0) || used[nonce]) revert Replay();
        if (!SignatureChecker.isValidSignatureNowCalldata(account, _hashTypedData(structHash), signature)) {
            revert InvalidSignature();
        }
        used[nonce] = true;
    }

    /// @notice Validates a trade intent against its maker approval.
    /// @return digest The intent's EIP-712 digest (the `intentHash` the approvers signed).
    /// @return sessionSigner The session key that signed, or zero when the account signed directly.
    function validateIntent(TradeIntent calldata intent, MakerApproval calldata approval, bytes calldata signature)
        public
        view
        returns (bytes32 digest, address sessionSigner)
    {
        RFQClearingNamespace.Layout storage $ = RFQClearingStorage.layout();
        // Approvals are fenced by the current leader epoch, signer set and policy versions.
        if (
            block.timestamp > intent.deadline || block.timestamp > approval.deadline
                || approval.leaderEpoch != $.leaderEpoch || approval.signerSetVersion != $.signerSetVersion
                || approval.policyVersion != $.policyVersion
        ) revert Stale();
        if ($.nonceUsed[intent.account][intent.nonce] || intent.account == address(0) || approval.fee > intent.maxFee) {
            revert Replay();
        }
        bool worseThanLimit = intent.baseDelta > 0
            ? approval.executionPrice > intent.limitPrice
            : approval.executionPrice < intent.limitPrice;
        if (worseThanLimit) revert InvalidTrade();

        digest = _hashTypedData(
            keccak256(
                abi.encode(
                    TRADE_INTENT_TYPEHASH,
                    intent.account,
                    intent.market,
                    intent.baseDelta,
                    intent.limitPrice,
                    intent.maxFee,
                    intent.nonce,
                    intent.deadline,
                    intent.reduceOnly
                )
            )
        );
        if (approval.intentHash != digest) revert InvalidSignature();
        if (SignatureChecker.isValidSignatureNowCalldata(intent.account, digest, signature)) {
            return (digest, address(0));
        }

        // Otherwise the signer must be a live session key of this account, scoped to this market and fee.
        sessionSigner = ECDSA.recoverCalldata(digest, signature);
        Session storage session = $.sessions[sessionSigner];
        if (
            session.account != intent.account || block.timestamp > session.validUntil
                || intent.deadline > session.validUntil || session.marketMask & (uint256(1) << intent.market) == 0
                || approval.fee > session.maxFee
        ) revert Unauthorized();
    }

    /// @notice Requires two distinct current approvers to have signed the same approval.
    function validateApproval(MakerApproval calldata approval, bytes calldata first, bytes calldata second)
        public
        view
    {
        bytes32 digest = _hashTypedData(
            keccak256(
                abi.encode(
                    MAKER_APPROVAL_TYPEHASH,
                    approval.intentHash,
                    approval.executionPrice,
                    approval.impactCharge,
                    approval.fee,
                    approval.oracleReportHash,
                    approval.deadline,
                    approval.leaderEpoch,
                    approval.signerSetVersion,
                    approval.policyVersion
                )
            )
        );
        mapping(address => bool) storage isApprover = RFQClearingStorage.layout().isApprover;
        address a = ECDSA.recoverCalldata(digest, first);
        address b = ECDSA.recoverCalldata(digest, second);
        if (a == b || !isApprover[a] || !isApprover[b]) revert InvalidSignature();
    }

    function _hashTypedData(bytes32 structHash) private view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, EIP712_NAME_HASH, EIP712_VERSION_HASH, block.chainid, address(this))
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }
}
