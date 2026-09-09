export const clearingStateAbi = [
  "function collateralOf(address) view returns(int256)",
  "function nonceUsed(address,uint256) view returns(bool)",
  "function positionOf(address,uint8) view returns(int256 size,uint256 entryPrice,int256 lastFundingIndex)",
  "function markets(uint256) view returns(int256 aggregateBase,int256 fundingIndex,uint64 fundingTime,uint64 lastPriceTime,uint256 lastBid,uint256 lastAsk,bool enabled)",
  "function maintenanceEquity(address) view returns(int256)",
  "function openingEquity(address) view returns(int256)",
  "function initialMargin(address) view returns(uint256)",
  "function maintenanceMargin(address) view returns(uint256)",
  "function sessions(address) view returns(address account,uint64 validUntil,uint8 marketMask,uint128 maxTradeNotional,uint128 maxCumulativeNotional,uint128 usedNotional,uint128 maxFee)",
  "function leaderEpoch() view returns(uint64)",
  "function signerSetVersion() view returns(uint64)",
  "function policyVersion() view returns(uint64)",
  "function paused() view returns(bool)",
  "function resolutionRequired() view returns(bool)",
  "function refreshOracle(bytes) payable returns((uint8 market,uint256 bid,uint256 ask,uint64 observedAt,uint64 validUntil))",
] as const;

export const clearingApiAbi = [
  ...clearingStateAbi,
  "function executeTrade((address account,uint8 market,int256 baseDelta,uint256 limitPrice,uint256 maxFee,uint256 nonce,uint64 deadline,bool reduceOnly),(bytes32 intentHash,uint256 executionPrice,int256 impactCharge,uint256 fee,bytes32 oracleReportHash,uint64 deadline,uint64 leaderEpoch,uint64 signerSetVersion,uint64 policyVersion),bytes,bytes,bytes,bytes) payable",
  "function depositWithAuthorization(address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
  "function withdrawWithSignature(address,address,uint256,uint256,uint64,bytes)",
  "function cancelNonceWithSignature(address,uint256,uint64,bytes)",
  "function closePositionWithSignature(address,uint8,uint256,uint64,bytes,bytes) payable",
  "function grantSessionWithSignature((address account,address session,uint8 marketMask,uint128 maxTradeNotional,uint128 maxCumulativeNotional,uint128 maxFee,uint64 validUntil,uint256 nonce,uint64 deadline),bytes)",
] as const;

export const clearingApproverAbi = [
  ...clearingStateAbi,
  "function isApprover(address) view returns(bool)",
] as const;

export const clearingIndexerAbi = [
  ...clearingStateAbi,
  "event Deposited(address indexed account,uint256 amount)",
  "event Withdrawn(address indexed account,uint256 amount)",
  "event TradeExecuted(bytes32 indexed intentHash,address indexed account,uint8 market,int256 baseDelta,uint256 price,uint256 fee)",
  "event NonceCancelled(address indexed account,uint256 indexed nonce)",
  "event PositionClosed(address indexed account,uint8 indexed market,int256 baseDelta,uint256 price)",
  "event MakerWithdrawn(address indexed recipient,uint256 amount)",
  "event SessionGranted(address indexed account,address indexed session,uint64 validUntil,uint128 maxCumulativeNotional)",
  "event SessionRevoked(address indexed account,address indexed session)",
  "event Liquidated(address indexed account,uint8 market,uint256 closedBase,uint256 penalty,uint256 keeperReward)",
  "event DeficitAbsorbed(address indexed account,uint256 insuranceUsed,uint256 makerUsed,uint256 unresolved)",
  "event EpochAdvanced(uint64 epoch)",
  "event ResolutionStarted(uint64 triggerTime)",
  "event ResolutionPriceReady(uint8 indexed market,uint256 price)",
  "event ResolutionFinalized(uint256 claims,uint256 assets)",
] as const;
