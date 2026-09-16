// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;
import "../RFQClearing.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @notice Read-only authorization module. Storage references retain their original proxy slots.
/// @dev All calls are linked delegatecalls; address(this) remains the clearing proxy.
library RFQSignatureVerifier {
    error Stale(); error Replay(); error InvalidTrade(); error InvalidSignature(); error Unauthorized();
    bytes32 private constant DOMAIN_TYPEHASH=keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant INTENT_TYPEHASH=keccak256("TradeIntent(address account,uint8 market,int256 baseDelta,uint256 limitPrice,uint256 maxFee,uint256 nonce,uint64 deadline,bool reduceOnly)");
    bytes32 private constant APPROVAL_TYPEHASH=keccak256("MakerApproval(bytes32 intentHash,uint256 executionPrice,int256 impactCharge,uint256 fee,bytes32 oracleReportHash,uint64 deadline,uint64 leaderEpoch,uint64 signerSetVersion,uint64 policyVersion)");
    function hashTypedData(bytes32 structHash) public view returns(bytes32){return _hash(structHash);}
    function _hash(bytes32 structHash) private view returns(bytes32){bytes32 separator=keccak256(abi.encode(DOMAIN_TYPEHASH,keccak256("RFQ Markets"),keccak256("1"),block.chainid,address(this)));return keccak256(abi.encodePacked("\x19\x01",separator,structHash));}
    function validOwnerSignature(address account,bytes32 digest,bytes calldata signature) public view returns(bool){return SignatureChecker.isValidSignatureNowCalldata(account,digest,signature);}
    function validateIntent(
        RFQClearing.TradeIntent calldata intent,RFQClearing.MakerApproval calldata approval,bytes calldata signature,
        mapping(address=>mapping(uint256=>bool)) storage used,mapping(address=>RFQClearing.Session) storage sessions,uint64[3] memory versions
    ) public view returns(bytes32 digest,address sessionSigner){
        if(block.timestamp>intent.deadline||block.timestamp>approval.deadline||approval.leaderEpoch!=versions[0]||approval.signerSetVersion!=versions[1]||approval.policyVersion!=versions[2])revert Stale();
        if(used[intent.account][intent.nonce]||intent.account==address(0)||approval.fee>intent.maxFee)revert Replay();
        if((intent.baseDelta>0&&approval.executionPrice>intent.limitPrice)||(intent.baseDelta<0&&approval.executionPrice<intent.limitPrice))revert InvalidTrade();
        digest=_hash(keccak256(abi.encode(INTENT_TYPEHASH,intent.account,intent.market,intent.baseDelta,intent.limitPrice,intent.maxFee,intent.nonce,intent.deadline,intent.reduceOnly)));
        if(approval.intentHash!=digest)revert InvalidSignature();
        if(SignatureChecker.isValidSignatureNowCalldata(intent.account,digest,signature))return(digest,address(0));
        sessionSigner=ECDSA.recoverCalldata(digest,signature);RFQClearing.Session storage session=sessions[sessionSigner];
        if(session.account!=intent.account||block.timestamp>session.validUntil||intent.deadline>session.validUntil||session.marketMask&uint8(1<<intent.market)==0||approval.fee>session.maxFee)revert Unauthorized();
    }
    function validateApproval(RFQClearing.MakerApproval calldata approval,bytes calldata one,bytes calldata two,mapping(address=>bool) storage approvers) public view {
        bytes32 digest=_hash(keccak256(abi.encode(APPROVAL_TYPEHASH,approval.intentHash,approval.executionPrice,approval.impactCharge,approval.fee,approval.oracleReportHash,approval.deadline,approval.leaderEpoch,approval.signerSetVersion,approval.policyVersion)));
        address a=ECDSA.recoverCalldata(digest,one);address b=ECDSA.recoverCalldata(digest,two);if(a==b||!approvers[a]||!approvers[b])revert InvalidSignature();
    }
}
