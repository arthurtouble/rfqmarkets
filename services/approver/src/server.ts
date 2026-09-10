import Fastify from "fastify";
import { DatabaseSync } from "node:sqlite";
import { AbiCoder, Contract, Interface, JsonRpcProvider, Wallet, getAddress, keccak256, toBeHex } from "ethers";
import { z } from "zod";
import { clearingApproverAbi } from "../../../packages/shared/src/abi.js";
import { DOMAIN_NAME, DOMAIN_VERSION, hashApproval, hashIntent, recoverIntentSigner, type MakerApproval, type SigningDomain, type TradeIntent } from "../../../packages/shared/src/eip712.js";
import { BASE, impactCost, type Exposure } from "../../../packages/shared/src/policy.js";
import { decodeStreamsV3Envelope } from "../../../packages/shared/src/streams.js";
import { hedgeAdmission, type HedgeRiskSnapshot } from "../../../packages/shared/src/hedge-risk.js";

const unsigned=z.string().regex(/^\d+$/); const signed=z.string().regex(/^-?\d+$/); const hex32=z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const requestSchema=z.object({
  domain:z.object({name:z.string(),version:z.string(),chainId:unsigned,verifyingContract:z.string()}),
  intent:z.object({account:z.string(),market:z.number().int().min(0).max(1),baseDelta:signed,limitPrice:unsigned,maxFee:unsigned,nonce:unsigned,deadline:unsigned,reduceOnly:z.boolean()}),
  userSignature:z.string().regex(/^0x[0-9a-fA-F]+$/),
  approval:z.object({intentHash:hex32,executionPrice:unsigned,impactCharge:signed,fee:unsigned,oracleReportHash:hex32,deadline:unsigned,leaderEpoch:unsigned,signerSetVersion:unsigned,policyVersion:unsigned}),
  quote:z.object({quoteId:z.string().uuid(),market:z.enum(["BTC","ETH"]),side:z.enum(["buy","sell"]),amount:unsigned,baseDelta:signed,expectedPrice:unsigned,worstPrice:unsigned,fee:unsigned,impactCharge:signed,expiresAtMs:z.number().int(),observedAtMs:z.number().int(),bid:unsigned,ask:unsigned}),
  report:z.string().regex(/^0x[0-9a-fA-F]*$/),
  oracleAgeMs:z.number().nonnegative(),
});

export interface ApproverOptions { privateKey:string; transportToken:string; databasePath:string; expectedEpoch?:number; expectedPolicyVersion?:number; expectedSignerSetVersion?:number; expectedChainId?:bigint; expectedVerifyingContract?:string; rpcUrl?:string; secondaryRpcUrl?:string; maxFutureSeconds?:number; oracleMode?:"local"|"chainlink"|"pyth"; dataStreams?:{feedIds:[string,string];feedDecimals:[number,number]};hedgeRisk?:{url:string;token:string;maxAgeMs?:number} }

export function buildApprover(options:ApproverOptions) {
  const app=Fastify({logger:false,bodyLimit:16_384}); const wallet=new Wallet(options.privateKey); const database=new DatabaseSync(options.databasePath);
  const provider=options.rpcUrl?new JsonRpcProvider(options.rpcUrl):undefined;
  const secondaryProvider=options.secondaryRpcUrl?new JsonRpcProvider(options.secondaryRpcUrl):undefined;
  const clearing=provider&&options.expectedVerifyingContract?new Contract(options.expectedVerifyingContract,clearingApproverAbi,provider):undefined;
  database.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS approvals (digest TEXT PRIMARY KEY, epoch INTEGER NOT NULL, expiry_ms INTEGER NOT NULL, signature TEXT NOT NULL, created_ms INTEGER NOT NULL)");
  app.get("/health",async()=>({ok:true,signer:wallet.address}));
  app.post("/approve",async(request,reply)=>{
    if(request.headers.authorization!==`Bearer ${options.transportToken}`)return reply.code(401).send({error:"unauthorized"});
    const parsed=requestSchema.safeParse(request.body); if(!parsed.success)return reply.code(400).send({error:"invalid request"}); const input=parsed.data;
    let domain:SigningDomain,intent:TradeIntent,approval:MakerApproval;
    try {
      domain={...input.domain,chainId:BigInt(input.domain.chainId),verifyingContract:getAddress(input.domain.verifyingContract)};
      intent={...input.intent,account:getAddress(input.intent.account),baseDelta:BigInt(input.intent.baseDelta),limitPrice:BigInt(input.intent.limitPrice),maxFee:BigInt(input.intent.maxFee),nonce:BigInt(input.intent.nonce),deadline:BigInt(input.intent.deadline)};
      approval={...input.approval,executionPrice:BigInt(input.approval.executionPrice),impactCharge:BigInt(input.approval.impactCharge),fee:BigInt(input.approval.fee),deadline:BigInt(input.approval.deadline),leaderEpoch:BigInt(input.approval.leaderEpoch),signerSetVersion:BigInt(input.approval.signerSetVersion),policyVersion:BigInt(input.approval.policyVersion)};
    } catch{return reply.code(400).send({error:"invalid typed data"});}
    if(domain.name!==DOMAIN_NAME||domain.version!==DOMAIN_VERSION||(options.expectedChainId!==undefined&&domain.chainId!==options.expectedChainId)||(options.expectedVerifyingContract&&domain.verifyingContract!==getAddress(options.expectedVerifyingContract)))return reply.code(409).send({error:"domain mismatch"});
    const now=Date.now(),expiryMs=Number(approval.deadline)*1_000;
    if(!clearing&&(Number(intent.deadline)*1_000<=now||expiryMs<=now||expiryMs>now+(31+(options.maxFutureSeconds??5))*1_000))return reply.code(409).send({error:"invalid expiry"});
    if((options.expectedEpoch!==undefined&&approval.leaderEpoch!==BigInt(options.expectedEpoch))||(options.expectedPolicyVersion!==undefined&&approval.policyVersion!==BigInt(options.expectedPolicyVersion))||(options.expectedSignerSetVersion!==undefined&&approval.signerSetVersion!==BigInt(options.expectedSignerSetVersion)))return reply.code(409).send({error:"version mismatch"});
    const market=input.quote.market==="BTC"?0:1;
    const priceOutsideLimit=(intent.baseDelta>0n&&approval.executionPrice>intent.limitPrice)||(intent.baseDelta<0n&&approval.executionPrice<intent.limitPrice);
    if(intent.market!==market||intent.baseDelta.toString()!==input.quote.baseDelta||intent.maxFee<approval.fee||priceOutsideLimit||approval.executionPrice.toString()!==input.quote.expectedPrice||approval.impactCharge.toString()!==input.quote.impactCharge||approval.fee.toString()!==input.quote.fee||approval.deadline>intent.deadline)return reply.code(409).send({error:"inconsistent envelope"});
    const intentHash=hashIntent(domain,intent);
    let intentSigner:string|undefined;
    try { intentSigner=recoverIntentSigner(domain,intent,input.userSignature); }
    catch{}
    if(approval.intentHash!==intentHash||(!clearing&&intentSigner!==intent.account))return reply.code(401).send({error:"invalid user signature"});
    const notional=BigInt(input.quote.amount),requiredFee=(notional*2n+9_999n)/10_000n,observedAge=now-input.quote.observedAtMs,mid=(BigInt(input.quote.bid)+BigInt(input.quote.ask))/2n;
    const signedBaseMagnitude=intent.baseDelta<0n?-intent.baseDelta:intent.baseDelta,baseMagnitude=notional*BASE/mid,baseRounding=signedBaseMagnitude>baseMagnitude?signedBaseMagnitude-baseMagnitude:baseMagnitude-signedBaseMagnitude,executionNotional=signedBaseMagnitude*approval.executionPrice/BASE,positiveImpact=approval.impactCharge>0n?approval.impactCharge:0n,minimumCharge=(notional*2n+9_999n)/10_000n+positiveImpact,anchor=intent.baseDelta>0n?BigInt(input.quote.ask):BigInt(input.quote.bid),minimumPremium=(anchor*minimumCharge+notional-1n)/notional;
    const underpriced=intent.baseDelta>0n?approval.executionPrice<anchor+minimumPremium:approval.executionPrice>anchor-minimumPremium;
    if(observedAge<0||observedAge>8_000||baseRounding*mid/BASE>1n||notional>1_000_000n*1_000_000n||approval.fee<requiredFee||underpriced)return reply.code(409).send({error:"policy rejected"});
    let reportObservation:{market:bigint;bid:bigint;ask:bigint;observedAt:bigint;validUntil:bigint}|undefined;
    if(input.report!=="0x"){
      try {
        if(keccak256(input.report)!==approval.oracleReportHash)return reply.code(409).send({error:"oracle hash mismatch"});
        if(options.oracleMode==="pyth"){const [reportMarket]=AbiCoder.defaultAbiCoder().decode(["uint8","bytes[]"],input.report);if(reportMarket!==BigInt(market))throw new Error("Pyth market mismatch");}
        else if(options.dataStreams){const observation=decodeStreamsV3Envelope(input.report,options.dataStreams.feedIds[market],options.dataStreams.feedDecimals[market]);reportObservation={market:BigInt(market),bid:observation.bid,ask:observation.ask,observedAt:BigInt(observation.observedAt),validUntil:BigInt(observation.validUntil)};}
        else [reportObservation]=AbiCoder.defaultAbiCoder().decode(["tuple(uint8 market,uint256 bid,uint256 ask,uint64 observedAt,uint64 validUntil)"],input.report);
        const observation=reportObservation;if(options.oracleMode!=="pyth"&&!observation)throw new Error("missing oracle observation");
        if(observation){const nowSeconds=BigInt(Math.floor(now/1_000)),wallTimeInvalid=!clearing&&(observation.observedAt>nowSeconds+BigInt(options.maxFutureSeconds??5)||nowSeconds>observation.validUntil||(observation.observedAt<=nowSeconds&&nowSeconds-observation.observedAt>8n));if(observation.market!==BigInt(market)||observation.bid!==BigInt(input.quote.bid)||observation.ask!==BigInt(input.quote.ask)||observation.bid<=0n||observation.ask<observation.bid||wallTimeInvalid)return reply.code(409).send({error:"oracle report rejected"});}
      } catch{return reply.code(409).send({error:"oracle report rejected"});}
    }
    if(clearing&&provider){
      try{
        const blockNumber=Number(BigInt(await provider.send("eth_blockNumber",[])));
        const contractWallet=new Contract(intent.account,["function isValidSignature(bytes32,bytes) view returns(bytes4)"],provider);
        const [block,secondaryBlock,epoch,setVersion,policy,paused,resolution,member,btc,eth,marketLimitWord,accountSignature,session]=await Promise.all([
          provider.getBlock(blockNumber),secondaryProvider?.getBlock(blockNumber),
          clearing.leaderEpoch({blockTag:blockNumber}),clearing.signerSetVersion({blockTag:blockNumber}),clearing.policyVersion({blockTag:blockNumber}),
          clearing.paused({blockTag:blockNumber}),clearing.resolutionRequired({blockTag:blockNumber}),clearing.isApprover(wallet.address,{blockTag:blockNumber}),
          clearing.markets(0,{blockTag:blockNumber}),clearing.markets(1,{blockTag:blockNumber}),clearing.marketLimitWord(market,{blockTag:blockNumber}),
          intentSigner===intent.account?Promise.resolve(true):contractWallet.isValidSignature(intentHash,input.userSignature,{blockTag:blockNumber}).then((value:string)=>value.toLowerCase()==="0x1626ba7e").catch(()=>false),
          intentSigner===intent.account||intentSigner===undefined?Promise.resolve(undefined):clearing.sessions(intentSigner,{blockTag:blockNumber}),
        ]);
        if(secondaryProvider&&(!secondaryBlock||secondaryBlock.hash!==block?.hash))return reply.code(409).send({error:"rpc divergence"});
        if(!block||BigInt(epoch)!==approval.leaderEpoch||BigInt(setVersion)!==approval.signerSetVersion||BigInt(policy)!==approval.policyVersion||paused||resolution||!member)return reply.code(409).send({error:"independent chain policy rejected"});
        if(options.oracleMode==="pyth"){
          const oracleAddress=await clearing.oracle({blockTag:blockNumber}),adapterInterface=new Interface(["function updateFee(bytes) view returns(uint256)","function verify(bytes) payable returns((uint8 market,uint256 bid,uint256 ask,uint64 observedAt,uint64 validUntil))"]),adapter=new Contract(oracleAddress,adapterInterface,provider),fee=await adapter.updateFee(input.report,{blockTag:blockNumber});
          const raw=await provider.send("eth_call",[{to:oracleAddress,from:domain.verifyingContract,data:adapterInterface.encodeFunctionData("verify",[input.report]),value:toBeHex(fee)},toBeHex(blockNumber)]),[value]=adapterInterface.decodeFunctionResult("verify",raw);reportObservation={market:BigInt(value.market),bid:BigInt(value.bid),ask:BigInt(value.ask),observedAt:BigInt(value.observedAt),validUntil:BigInt(value.validUntil)};
          if(reportObservation.market!==BigInt(market)||reportObservation.bid!==BigInt(input.quote.bid)||reportObservation.ask!==BigInt(input.quote.ask))return reply.code(409).send({error:"oracle report rejected"});
        }
        if(executionNotional>(BigInt(marketLimitWord)&((1n<<128n)-1n)))return reply.code(409).send({error:"market trade limit exceeded"});
        if(intent.deadline<=BigInt(block.timestamp)||approval.deadline<=BigInt(block.timestamp)||approval.deadline>BigInt(block.timestamp+31+(options.maxFutureSeconds??5)))return reply.code(409).send({error:"chain-time expiry rejected"});
        if(!accountSignature&&(!session||getAddress(session.account)!==intent.account||BigInt(session.validUntil)<intent.deadline||(Number(session.marketMask)&(1<<intent.market))===0||BigInt(session.maxFee)<approval.fee||BigInt(session.usedNotional)+notional>BigInt(session.maxCumulativeNotional)||notional>BigInt(session.maxTradeNotional)))return reply.code(409).send({error:"user authorization rejected"});
        const selected=market===0?btc:eth;if(!selected.enabled)return reply.code(409).send({error:"market disabled"});
        if(options.hedgeRisk){let risk:HedgeRiskSnapshot;try{const response=await fetch(options.hedgeRisk.url,{headers:{authorization:`Bearer ${options.hedgeRisk.token}`},signal:AbortSignal.timeout(500)});if(!response.ok)throw new Error();risk=await response.json() as HedgeRiskSnapshot;}catch{return reply.code(503).send({error:"hedge health unavailable"});}const reported=risk.markets[input.quote.market]?.mode??"reduce_only",mode=!risk.healthy||!risk.observedAtMs||now-risk.observedAtMs>(options.hedgeRisk.maxAgeMs??3_000)?"reduce_only":reported,admission=hedgeAdmission(mode,BigInt(selected.aggregateBase),intent.baseDelta,BigInt(marketLimitWord)&((1n<<128n)-1n));if(!admission.allowed)return reply.code(409).send({error:"hedge risk requires exposure reduction"});if(executionNotional>admission.maxTradeNotional)return reply.code(409).send({error:"guarded hedge limit exceeded"});}
        if(reportObservation&&(reportObservation.observedAt>BigInt(block.timestamp+(options.maxFutureSeconds??5))||BigInt(block.timestamp)>reportObservation.validUntil||(reportObservation.observedAt<=BigInt(block.timestamp)&&BigInt(block.timestamp)-reportObservation.observedAt>8n)))return reply.code(409).send({error:"chain-time oracle rejected"});
        const mark=(BigInt(input.quote.bid)+BigInt(input.quote.ask))/2n;
        const marketNotional=(state:typeof btc,currentMark?:bigint)=>BigInt(state.aggregateBase)*(currentMark??(BigInt(state.lastBid)+BigInt(state.lastAsk))/2n)/BASE;
        const exposure:Exposure={BTC:marketNotional(btc,market===0?mark:undefined),ETH:marketNotional(eth,market===1?mark:undefined)};
        const delta=BigInt(intent.baseDelta)*mark/BASE;
        if(approval.impactCharge<impactCost(exposure,input.quote.market,delta))return reply.code(409).send({error:"independent impact check rejected"});
      }catch(error){return reply.code(503).send({error:"independent chain read unavailable",detail:process.env.NODE_ENV==="test"?String(error):undefined});}
    }
    const digest=hashApproval(domain,approval); const existing=database.prepare("SELECT signature FROM approvals WHERE digest = ?").get(digest) as {signature:string}|undefined;
    if(existing)return {digest,signer:wallet.address,signature:existing.signature};
    const signature=wallet.signingKey.sign(digest).serialized;
    database.prepare("INSERT INTO approvals VALUES (?, ?, ?, ?, ?)").run(digest,Number(approval.leaderEpoch),expiryMs,signature,now);
    return {digest,signer:wallet.address,signature};
  });
  app.addHook("onClose",async()=>database.close()); return app;
}
