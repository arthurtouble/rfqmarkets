import Fastify from "fastify";
import cors from "@fastify/cors";
import { DatabaseSync } from "node:sqlite";
import { AbiCoder, Contract, JsonRpcProvider, Wallet, getAddress, keccak256, parseUnits, recoverAddress, toUtf8Bytes } from "ethers";
import { z } from "zod";
import { clearingApiAbi } from "../../../packages/shared/src/abi.js";
import { approvalToWire, cancelToWire, cancelTypes, closeToWire, closeTypes, depositToWire, depositTypes, DOMAIN_NAME, DOMAIN_VERSION, hashApproval, hashIntent, intentToWire, intentTypes, recoverCancelSigner, recoverCloseSigner, recoverDepositSigner, recoverIntentSigner, recoverSessionGrantSigner, recoverWithdrawalSigner, sessionGrantToWire, sessionGrantTypes, withdrawalToWire, withdrawalTypes, type CancelIntent, type CloseIntent, type DepositIntent, type MakerApproval, type SessionGrant, type SigningDomain, type TradeIntent, type WithdrawalIntent } from "../../../packages/shared/src/eip712.js";
import { BASE, constructQuote, quoteRequestSchema, type Exposure, type PriceSnapshot, type Quote } from "../../../packages/shared/src/policy.js";
import { quoteToWire } from "../../../packages/shared/src/wire.js";
import { DurableSender } from "./sender.js";

export interface ApiOptions {
  prices?: Record<"BTC" | "ETH", PriceSnapshot>;
  approvers?: Array<{ url: string; token: string }>;
  fetchImpl?: typeof fetch;
  corsOrigin?: string;
  chainId?: bigint;
  verifyingContract?: string;
  chain?: { rpcUrl:string; sponsorPrivateKey:string; clearingAddress:string; tokenAddress:string; devFund?:boolean };
  journalPath?:string;
}

const intentRequestSchema = z.object({ quoteId:z.string().uuid(), account:z.string(), nonce:z.string().regex(/^\d+$/) });
const approvalRequestSchema = intentRequestSchema.extend({ userSignature:z.string().regex(/^0x[0-9a-fA-F]+$/) });
const depositQuoteSchema=z.object({account:z.string(),fromChainId:z.number().int().positive(),fromToken:z.enum(["USDC","USDT","ETH"]),amount:z.string().regex(/^\d+(\.\d{1,18})?$/)});
const depositExecuteSchema=z.object({routeId:z.string().regex(/^0x[0-9a-fA-F]{64}$/),userSignature:z.string().regex(/^0x[0-9a-fA-F]+$/)});
const actionBaseSchema=z.object({account:z.string(),nonce:z.string().regex(/^\d+$/)});
const signedActionSchema=z.object({userSignature:z.string().regex(/^0x[0-9a-fA-F]+$/)});
const withdrawalPrepareSchema=actionBaseSchema.extend({recipient:z.string().optional(),amount:z.string().regex(/^\d+(\.\d{1,6})?$/)});
const withdrawalExecuteSchema=signedActionSchema.extend({intent:z.object({account:z.string(),recipient:z.string(),amount:z.string().regex(/^\d+$/),nonce:z.string().regex(/^\d+$/),deadline:z.string().regex(/^\d+$/)})});
const cancelExecuteSchema=signedActionSchema.extend({intent:z.object({account:z.string(),nonce:z.string().regex(/^\d+$/),deadline:z.string().regex(/^\d+$/)})});
const closePrepareSchema=actionBaseSchema.extend({market:z.enum(["BTC","ETH"])});
const closeExecuteSchema=signedActionSchema.extend({intent:z.object({account:z.string(),market:z.number().int().min(0).max(1),nonce:z.string().regex(/^\d+$/),deadline:z.string().regex(/^\d+$/)})});
const sessionPrepareSchema=actionBaseSchema.extend({session:z.string(),marketMask:z.number().int().min(1).max(3),maxTradeAmount:z.string().regex(/^\d+(\.\d{1,6})?$/),maxCumulativeAmount:z.string().regex(/^\d+(\.\d{1,6})?$/),maxFee:z.string().regex(/^\d+(\.\d{1,6})?$/),durationSeconds:z.number().int().min(300).max(2_592_000)});
const sessionExecuteSchema=signedActionSchema.extend({grant:z.object({account:z.string(),session:z.string(),marketMask:z.number().int().min(1).max(3),maxTradeNotional:z.string().regex(/^\d+$/),maxCumulativeNotional:z.string().regex(/^\d+$/),maxFee:z.string().regex(/^\d+$/),validUntil:z.string().regex(/^\d+$/),nonce:z.string().regex(/^\d+$/),deadline:z.string().regex(/^\d+$/)})});
type DepositRoute={intent:DepositIntent;fromToken:"USDC"|"USDT"|"ETH";amount:string;expectedUsdc:bigint;status:"quoted"|"authorized"|"deposited";destinationTxHash?:string;transaction?:{hash:string;blockNumber:number;collateral:string}};
type ProtocolVersions={leaderEpoch:bigint;signerSetVersion:bigint;policyVersion:bigint;blockNumber:number;blockTimestamp:number};

export function buildApi(options: ApiOptions = {}) {
  const app = Fastify({ logger:false, bodyLimit:16_384 });
  app.register(cors, { origin:options.corsOrigin ?? "http://127.0.0.1:4173" });
  const settled:Exposure = { BTC:0n, ETH:0n };
  const pending:Array<{quoteId:string;market:"BTC"|"ETH";delta:bigint;expiresAtMs:number}> = [];
  const journal=options.journalPath?new DatabaseSync(options.journalPath):undefined;
  journal?.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS commitments (quote_id TEXT PRIMARY KEY, market TEXT NOT NULL, delta TEXT NOT NULL, expires_ms INTEGER NOT NULL, status TEXT NOT NULL, intent_json TEXT NOT NULL, user_signature TEXT NOT NULL, approval_json TEXT, tx_hash TEXT, updated_ms INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS deposit_routes (route_id TEXT PRIMARY KEY, account TEXT NOT NULL, from_chain TEXT NOT NULL, from_token TEXT NOT NULL, source_amount TEXT NOT NULL, expected_usdc TEXT NOT NULL, minimum_usdc TEXT NOT NULL, deadline INTEGER NOT NULL, nonce TEXT NOT NULL, status TEXT NOT NULL, destination_tx TEXT, updated_ms INTEGER NOT NULL)");
  for(const row of journal?.prepare("SELECT quote_id, market, delta, expires_ms FROM commitments WHERE status IN ('reserved','approved','submitted') AND expires_ms > ?").all(Date.now())??[]){const item=row as {quote_id:string;market:"BTC"|"ETH";delta:string;expires_ms:number};pending.push({quoteId:item.quote_id,market:item.market,delta:BigInt(item.delta),expiresAtMs:item.expires_ms});}
  const quotes = new Map<string,Quote>();
  const quoteVersions = new Map<string,ProtocolVersions>();
  const quoteBindings = new Map<string,{account:string;nonce:string}>();
  const deposits=new Map<string,DepositRoute>();
  for(const row of journal?.prepare("SELECT route_id, account, from_chain, from_token, source_amount, expected_usdc, minimum_usdc, deadline, nonce, status, destination_tx FROM deposit_routes WHERE status = 'deposited' OR (status IN ('quoted','authorized') AND deadline > ?)").all(Math.floor(Date.now()/1_000))??[]){
    const item=row as {route_id:string;account:string;from_chain:string;from_token:"USDC"|"USDT"|"ETH";source_amount:string;expected_usdc:string;minimum_usdc:string;deadline:number;nonce:string;status:"quoted"|"authorized"|"deposited";destination_tx:string|null};
    deposits.set(item.route_id,{intent:{account:item.account,routeId:item.route_id,sourceChainId:BigInt(item.from_chain),sourceTokenHash:keccak256(toUtf8Bytes(item.from_token)),sourceAmount:BigInt(item.source_amount),minimumUsdc:BigInt(item.minimum_usdc),deadline:BigInt(item.deadline),nonce:BigInt(item.nonce)},fromToken:item.from_token,amount:item.source_amount,expectedUsdc:BigInt(item.expected_usdc),status:item.status,destinationTxHash:item.destination_tx??undefined});
  }
  const prices = options.prices ?? {
    BTC:{market:"BTC",bid:99_990n*1_000_000n,ask:100_010n*1_000_000n,observedAtMs:Date.now()},
    ETH:{market:"ETH",bid:3_999n*1_000_000n,ask:4_001n*1_000_000n,observedAtMs:Date.now()},
  };
  const fetchImpl = options.fetchImpl ?? fetch;
  const provider=options.chain?new JsonRpcProvider(options.chain.rpcUrl):undefined;
  if(provider&&options.chain?.devFund)provider.pollingInterval=50;
  const sponsor=provider&&options.chain?new Wallet(options.chain.sponsorPrivateKey,provider):undefined;
  const sender=provider&&sponsor?new DurableSender(provider,sponsor,journal):undefined;
  const clearing=options.chain&&provider?new Contract(options.chain.clearingAddress,clearingApiAbi,provider):undefined;
  const token=options.chain&&provider?new Contract(options.chain.tokenAddress,["function mint(address,uint256)"],provider):undefined;
  const domain:SigningDomain = {
    name:DOMAIN_NAME, version:DOMAIN_VERSION, chainId:options.chainId ?? 31_337n,
    verifyingContract:getAddress(options.verifyingContract ?? "0x0000000000000000000000000000000000000001"),
  };

  function prune(now=Date.now()) {
    for (let index=pending.length-1; index>=0; index--) if (pending[index].expiresAtMs<=now) pending.splice(index,1);
    for (const [id,quote] of quotes) if (quote.expiresAtMs+60_000<=now) { quotes.delete(id); quoteVersions.delete(id); quoteBindings.delete(id); }
  }
  function makeIntent(quote:Quote,versions:ProtocolVersions,account:string,nonce:string):TradeIntent {
    return { account:getAddress(account),market:quote.market==="BTC"?0:1,baseDelta:quote.baseDelta,limitPrice:quote.worstPrice,maxFee:quote.fee,nonce:BigInt(nonce),deadline:BigInt(versions.blockTimestamp+30),leaderEpoch:versions.leaderEpoch,policyVersion:versions.policyVersion,reduceOnly:false };
  }
  async function readProtocolVersions():Promise<ProtocolVersions>{
    if(!clearing||!provider)return {leaderEpoch:1n,signerSetVersion:1n,policyVersion:1n,blockNumber:0,blockTimestamp:Math.floor(Date.now()/1_000)};
    const blockNumber=Number(BigInt(await provider.send("eth_blockNumber",[])));
    const [block,leaderEpoch,signerSetVersion,policyVersion,paused,resolutionRequired]=await Promise.all([
      provider.getBlock(blockNumber),
      clearing.leaderEpoch({blockTag:blockNumber}),clearing.signerSetVersion({blockTag:blockNumber}),clearing.policyVersion({blockTag:blockNumber}),
      clearing.paused({blockTag:blockNumber}),clearing.resolutionRequired({blockTag:blockNumber}),
    ]);
    if(!block||paused||resolutionRequired)throw new Error("market is paused");
    return {leaderEpoch:BigInt(leaderEpoch),signerSetVersion:BigInt(signerSetVersion),policyVersion:BigInt(policyVersion),blockNumber,blockTimestamp:block.timestamp};
  }
  async function advanceLocalChainTime(){
    if(!provider)throw new Error("local chain unavailable");
    const latest=await provider.send("eth_getBlockByNumber",["latest",false]) as {timestamp:string};
    const timestamp=Math.max(Math.floor(Date.now()/1_000),Number(BigInt(latest.timestamp))+1);
    await provider.send("evm_setNextBlockTimestamp",[timestamp]);await provider.send("evm_mine",[]);return timestamp;
  }

  app.get("/health",async()=>({ok:true,role:"leader",epoch:(clearing?await clearing.leaderEpoch():1n).toString(),chain:options.chain?{chainId:domain.chainId.toString(),clearingAddress:domain.verifyingContract}:null,sender:sender?.status()}));
  app.get("/v1/config",async()=>({chainId:`0x${domain.chainId.toString(16)}`,chainName:options.chain?.devFund?"RFQ Local":"Base",rpcUrl:options.chain?.rpcUrl,clearingAddress:domain.verifyingContract,tokenAddress:options.chain?.tokenAddress}));
  app.get("/v1/account/:address",async(request,reply)=>{
    if(!clearing)return reply.code(503).send({error:"chain unavailable"});
    try {const account=getAddress((request.params as {address:string}).address);const [collateral,btc,eth]=await Promise.all([clearing.collateralOf(account),clearing.positionOf(account,0),clearing.positionOf(account,1)]);return {account,collateral:collateral.toString(),positions:{BTC:{size:btc.size.toString(),entryPrice:btc.entryPrice.toString()},ETH:{size:eth.size.toString(),entryPrice:eth.entryPrice.toString()}}};}
    catch{return reply.code(400).send({error:"invalid account"});}
  });
  app.post("/v1/deposit/quote",async(request,reply)=>{
    const parsed=depositQuoteSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid deposit request"});
    try {
      const account=getAddress(parsed.data.account),decimals=parsed.data.fromToken==="ETH"?18:6,sourceAmount=parseUnits(parsed.data.amount,decimals);
      if(sourceAmount<=0n)throw new Error();
      const grossUsdc=parsed.data.fromToken==="ETH"?sourceAmount*2_500n*1_000_000n/10n**18n:sourceAmount;
      const expectedUsdc=grossUsdc*9_970n/10_000n,minimumUsdc=expectedUsdc*9_950n/10_000n;
      if(minimumUsdc<10n*1_000_000n)throw new Error("minimum deposit is 10 USDC");
      const routeId=keccak256(toUtf8Bytes(crypto.randomUUID())),deadline=BigInt(Math.floor(Date.now()/1_000)+120),nonce=BigInt(`0x${crypto.randomUUID().replaceAll("-","")}`);
      const intent:DepositIntent={account,routeId,sourceChainId:BigInt(parsed.data.fromChainId),sourceTokenHash:keccak256(toUtf8Bytes(parsed.data.fromToken)),sourceAmount,minimumUsdc,deadline,nonce};
      const route:DepositRoute={intent,fromToken:parsed.data.fromToken,amount:parsed.data.amount,expectedUsdc,status:"quoted"};deposits.set(routeId,route);
      journal?.prepare("INSERT INTO deposit_routes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'quoted', NULL, ?)").run(routeId,account,parsed.data.fromChainId.toString(),parsed.data.fromToken,sourceAmount.toString(),expectedUsdc.toString(),minimumUsdc.toString(),Number(deadline),nonce.toString(),Date.now());
      return {provider:"local-simulator",routeId,fromChainId:parsed.data.fromChainId,fromToken:parsed.data.fromToken,amount:parsed.data.amount,expectedUsdc:expectedUsdc.toString(),minimumUsdc:minimumUsdc.toString(),estimatedSeconds:2,domain:{...domain,chainId:domain.chainId.toString()},types:depositTypes,intent:depositToWire(intent)};
    } catch(error){return reply.code(409).send({error:error instanceof Error&&error.message?error.message:"deposit route rejected"});}
  });
  app.post("/v1/deposit/execute",async(request,reply)=>{
    const parsed=depositExecuteSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid deposit execution"});
    const route=deposits.get(parsed.data.routeId);if(!route)return reply.code(404).send({error:"deposit route not found"});
    try {if(recoverDepositSigner(domain,route.intent,parsed.data.userSignature)!==route.intent.account)return reply.code(401).send({error:"invalid deposit signature"});}
    catch{return reply.code(401).send({error:"invalid deposit signature"});}
    if(route.transaction)return {status:"deposited",routeId:parsed.data.routeId,transaction:route.transaction};
    if(!options.chain?.devFund||!token||!clearing||!provider||!sender)return reply.code(503).send({error:"live route adapter is not configured"});
    if(route.destinationTxHash){
      const existing=await provider.getTransactionReceipt(route.destinationTxHash);
      if(!existing)return reply.code(202).send({status:"submitted",routeId:parsed.data.routeId,transaction:{hash:route.destinationTxHash}});
      if(existing.status===1){const collateral=await clearing.collateralOf(route.intent.account);route.status="deposited";route.transaction={hash:route.destinationTxHash,blockNumber:existing.blockNumber,collateral:collateral.toString()};journal?.prepare("UPDATE deposit_routes SET status='deposited', updated_ms=? WHERE route_id=?").run(Date.now(),parsed.data.routeId);return {status:"deposited",routeId:parsed.data.routeId,expectedUsdc:route.expectedUsdc.toString(),transaction:route.transaction};}
    }
    if(Number(route.intent.deadline)*1_000<=Date.now())return reply.code(409).send({error:"deposit route expired"});
    journal?.prepare("UPDATE deposit_routes SET status='authorized', updated_ms=? WHERE route_id=?").run(Date.now(),parsed.data.routeId);route.status="authorized";
    try {
      const timestamp=await advanceLocalChainTime();
      await sender.submit(`deposit-mint:${route.intent.routeId}`,{to:options.chain.tokenAddress,data:token.interface.encodeFunctionData("mint",[route.intent.account,route.expectedUsdc])});
      const receipt=await sender.submit(`deposit:${route.intent.routeId}`,{to:options.chain.clearingAddress,data:clearing.interface.encodeFunctionData("depositWithAuthorization",[route.intent.account,route.expectedUsdc,timestamp-60,timestamp+600,route.intent.routeId,27,"0x"+"00".repeat(32),"0x"+"00".repeat(32)])});route.destinationTxHash=receipt.hash;journal?.prepare("UPDATE deposit_routes SET destination_tx=?, updated_ms=? WHERE route_id=?").run(receipt.hash,Date.now(),parsed.data.routeId);
      const collateral=await clearing.collateralOf(route.intent.account);route.status="deposited";route.transaction={hash:receipt.hash,blockNumber:receipt.blockNumber,collateral:collateral.toString()};
      journal?.prepare("UPDATE deposit_routes SET status='deposited', updated_ms=? WHERE route_id=?").run(Date.now(),parsed.data.routeId);return {status:"deposited",routeId:parsed.data.routeId,expectedUsdc:route.expectedUsdc.toString(),transaction:route.transaction};
    } catch(error){return reply.code(409).send({error:error instanceof Error?`deposit failed: ${error.message}`:"deposit failed"});}
  });
  app.post("/v1/withdraw/prepare",async(request,reply)=>{const parsed=withdrawalPrepareSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid withdrawal request"});try{const account=getAddress(parsed.data.account),recipient=getAddress(parsed.data.recipient??parsed.data.account),amount=parseUnits(parsed.data.amount,6);if(amount<=0n)throw new Error();const intent:WithdrawalIntent={account,recipient,amount,nonce:BigInt(parsed.data.nonce),deadline:BigInt(Math.floor(Date.now()/1_000)+120)};return {domain:{...domain,chainId:domain.chainId.toString()},types:withdrawalTypes,intent:withdrawalToWire(intent)};}catch{return reply.code(400).send({error:"invalid withdrawal request"});}});
  app.post("/v1/withdraw/execute",async(request,reply)=>{const parsed=withdrawalExecuteSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid signed withdrawal"});try{const intent:WithdrawalIntent={account:getAddress(parsed.data.intent.account),recipient:getAddress(parsed.data.intent.recipient),amount:BigInt(parsed.data.intent.amount),nonce:BigInt(parsed.data.intent.nonce),deadline:BigInt(parsed.data.intent.deadline)};if(Number(intent.deadline)*1_000<=Date.now()||recoverWithdrawalSigner(domain,intent,parsed.data.userSignature)!==intent.account)return reply.code(401).send({error:"invalid withdrawal signature"});if(!clearing||!sender||!options.chain)return reply.code(503).send({error:"chain unavailable"});const receipt=await sender.submit(`withdraw:${intent.account}:${intent.nonce}`,{to:options.chain.clearingAddress,data:clearing.interface.encodeFunctionData("withdrawWithSignature",[intent.account,intent.recipient,intent.amount,intent.nonce,intent.deadline,parsed.data.userSignature])});return {status:"included",transaction:{hash:receipt.hash,blockNumber:receipt.blockNumber},collateral:(await clearing.collateralOf(intent.account)).toString()};}catch(error){return reply.code(409).send({error:error instanceof Error?`withdrawal failed: ${error.message}`:"withdrawal failed"});}});
  app.post("/v1/nonce/cancel/prepare",async(request,reply)=>{const parsed=actionBaseSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid cancellation request"});try{const intent:CancelIntent={account:getAddress(parsed.data.account),nonce:BigInt(parsed.data.nonce),deadline:BigInt(Math.floor(Date.now()/1_000)+120)};return {domain:{...domain,chainId:domain.chainId.toString()},types:cancelTypes,intent:cancelToWire(intent)};}catch{return reply.code(400).send({error:"invalid cancellation request"});}});
  app.post("/v1/nonce/cancel/execute",async(request,reply)=>{const parsed=cancelExecuteSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid signed cancellation"});try{const intent:CancelIntent={account:getAddress(parsed.data.intent.account),nonce:BigInt(parsed.data.intent.nonce),deadline:BigInt(parsed.data.intent.deadline)};if(Number(intent.deadline)*1_000<=Date.now()||recoverCancelSigner(domain,intent,parsed.data.userSignature)!==intent.account)return reply.code(401).send({error:"invalid cancellation signature"});if(!clearing||!sender||!options.chain)return reply.code(503).send({error:"chain unavailable"});const receipt=await sender.submit(`cancel:${intent.account}:${intent.nonce}`,{to:options.chain.clearingAddress,data:clearing.interface.encodeFunctionData("cancelNonceWithSignature",[intent.account,intent.nonce,intent.deadline,parsed.data.userSignature])});return {status:"included",transaction:{hash:receipt.hash,blockNumber:receipt.blockNumber}};}catch(error){return reply.code(409).send({error:error instanceof Error?`cancellation failed: ${error.message}`:"cancellation failed"});}});
  app.post("/v1/close/prepare",async(request,reply)=>{const parsed=closePrepareSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid close request"});try{const intent:CloseIntent={account:getAddress(parsed.data.account),market:parsed.data.market==="BTC"?0:1,nonce:BigInt(parsed.data.nonce),deadline:BigInt(Math.floor(Date.now()/1_000)+120)};return {domain:{...domain,chainId:domain.chainId.toString()},types:closeTypes,intent:closeToWire(intent)};}catch{return reply.code(400).send({error:"invalid close request"});}});
  app.post("/v1/close/execute",async(request,reply)=>{const parsed=closeExecuteSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid signed close"});try{const intent:CloseIntent={account:getAddress(parsed.data.intent.account),market:parsed.data.intent.market,nonce:BigInt(parsed.data.intent.nonce),deadline:BigInt(parsed.data.intent.deadline)};if(Number(intent.deadline)*1_000<=Date.now()||recoverCloseSigner(domain,intent,parsed.data.userSignature)!==intent.account)return reply.code(401).send({error:"invalid close signature"});if(!clearing||!sender||!provider||!options.chain)return reply.code(503).send({error:"chain unavailable"});const market=intent.market===0?"BTC":"ETH",timestamp=options.chain.devFund?await advanceLocalChainTime():Number(BigInt((await provider.send("eth_getBlockByNumber",["latest",false]) as {timestamp:string}).timestamp));const snapshot=prices[market];const report=AbiCoder.defaultAbiCoder().encode(["tuple(uint8 market,uint256 bid,uint256 ask,uint64 observedAt,uint64 validUntil)"],[[intent.market,snapshot.bid,snapshot.ask,BigInt(timestamp),BigInt(timestamp+60)]]);const receipt=await sender.submit(`close:${intent.account}:${intent.market}:${intent.nonce}`,{to:options.chain.clearingAddress,data:clearing.interface.encodeFunctionData("closePositionWithSignature",[intent.account,intent.market,intent.nonce,intent.deadline,report,parsed.data.userSignature])});const position=await clearing.positionOf(intent.account,intent.market);return {status:"included",transaction:{hash:receipt.hash,blockNumber:receipt.blockNumber},position:{size:position.size.toString(),entryPrice:position.entryPrice.toString()}};}catch(error){return reply.code(409).send({error:error instanceof Error?`close failed: ${error.message}`:"close failed"});}});
  app.post("/v1/session/prepare",async(request,reply)=>{const parsed=sessionPrepareSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid session request"});try{const account=getAddress(parsed.data.account),session=getAddress(parsed.data.session),now=Math.floor(Date.now()/1_000);const grant:SessionGrant={account,session,marketMask:parsed.data.marketMask,maxTradeNotional:parseUnits(parsed.data.maxTradeAmount,6),maxCumulativeNotional:parseUnits(parsed.data.maxCumulativeAmount,6),maxFee:parseUnits(parsed.data.maxFee,6),validUntil:BigInt(now+parsed.data.durationSeconds),nonce:BigInt(parsed.data.nonce),deadline:BigInt(now+120)};if(grant.maxTradeNotional<=0n||grant.maxTradeNotional>grant.maxCumulativeNotional)throw new Error();return {domain:{...domain,chainId:domain.chainId.toString()},types:sessionGrantTypes,grant:sessionGrantToWire(grant)};}catch{return reply.code(400).send({error:"invalid session request"});}});
  app.post("/v1/session/execute",async(request,reply)=>{const parsed=sessionExecuteSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid signed session"});try{const grant:SessionGrant={...parsed.data.grant,account:getAddress(parsed.data.grant.account),session:getAddress(parsed.data.grant.session),maxTradeNotional:BigInt(parsed.data.grant.maxTradeNotional),maxCumulativeNotional:BigInt(parsed.data.grant.maxCumulativeNotional),maxFee:BigInt(parsed.data.grant.maxFee),validUntil:BigInt(parsed.data.grant.validUntil),nonce:BigInt(parsed.data.grant.nonce),deadline:BigInt(parsed.data.grant.deadline)};if(Number(grant.deadline)*1_000<=Date.now()||recoverSessionGrantSigner(domain,grant,parsed.data.userSignature)!==grant.account)return reply.code(401).send({error:"invalid session signature"});if(!clearing||!sender||!options.chain)return reply.code(503).send({error:"chain unavailable"});const receipt=await sender.submit(`session:${grant.account}:${grant.session}:${grant.nonce}`,{to:options.chain.clearingAddress,data:clearing.interface.encodeFunctionData("grantSessionWithSignature",[grant,parsed.data.userSignature])});return {status:"active",session:grant.session,validUntil:grant.validUntil.toString(),transaction:{hash:receipt.hash,blockNumber:receipt.blockNumber}};}catch(error){return reply.code(409).send({error:error instanceof Error?`session failed: ${error.message}`:"session failed"});}});
  app.post("/v1/quote",async(request,reply)=>{
    const parsed=quoteRequestSchema.safeParse(request.body);
    if(!parsed.success)return reply.code(400).send({error:"invalid quote request"});
    try {
      prune(); prices[parsed.data.market].observedAtMs=Date.now();
      let versions:ProtocolVersions;
      if(clearing&&provider){
        // A local automining chain stops advancing while idle. Synchronize it before
        // pinning the block so the next transaction cannot jump past the deadline.
        if(options.chain?.devFund)await advanceLocalChainTime();
        const readSnapshot=async()=>{const blockNumber=Number(BigInt(await provider.send("eth_blockNumber",[])));const values=await Promise.all([
          provider.getBlock(blockNumber),clearing.markets(0,{blockTag:blockNumber}),clearing.markets(1,{blockTag:blockNumber}),
          clearing.leaderEpoch({blockTag:blockNumber}),clearing.signerSetVersion({blockTag:blockNumber}),clearing.policyVersion({blockTag:blockNumber}),
          clearing.paused({blockTag:blockNumber}),clearing.resolutionRequired({blockTag:blockNumber}),
        ]);return {blockNumber,values};};
        let {blockNumber,values}=await readSnapshot();let [block,btc,eth,leaderEpoch,signerSetVersion,policyVersion,paused,resolutionRequired]=values;
        if(!block||paused||resolutionRequired)throw new Error("market is paused");
        // The production system uses an independent keeper. Locally, catch up an
        // exposed nontraded market only when its mark would otherwise block risk checks.
        const otherMarket=parsed.data.market==="BTC"?"ETH":"BTC",otherIndex=otherMarket==="BTC"?0:1,otherState=otherIndex===0?btc:eth;
        if(options.chain?.devFund&&sender&&BigInt(otherState.aggregateBase)!==0n&&block.timestamp-Number(otherState.lastPriceTime)>8){
          const snapshot=prices[otherMarket],report=AbiCoder.defaultAbiCoder().encode(["tuple(uint8 market,uint256 bid,uint256 ask,uint64 observedAt,uint64 validUntil)"],[[otherIndex,snapshot.bid,snapshot.ask,BigInt(block.timestamp),BigInt(block.timestamp+60)]]);
          await sender.submit(`local-oracle:${otherMarket}:${blockNumber}`,{to:options.chain.clearingAddress,data:clearing.interface.encodeFunctionData("refreshOracle",[report])});
          ({blockNumber,values}=await readSnapshot());[block,btc,eth,leaderEpoch,signerSetVersion,policyVersion,paused,resolutionRequired]=values;
          if(!block||paused||resolutionRequired)throw new Error("market is paused");
        }
        settled.BTC=BigInt(btc.aggregateBase)*(prices.BTC.bid+prices.BTC.ask)/2n/BASE;
        settled.ETH=BigInt(eth.aggregateBase)*(prices.ETH.bid+prices.ETH.ask)/2n/BASE;
        versions={leaderEpoch:BigInt(leaderEpoch),signerSetVersion:BigInt(signerSetVersion),policyVersion:BigInt(policyVersion),blockNumber,blockTimestamp:block.timestamp};
      } else versions=await readProtocolVersions();
      const quote=constructQuote(parsed.data,{...prices[parsed.data.market]},settled,pending,Date.now());
      quotes.set(quote.quoteId,quote);quoteVersions.set(quote.quoteId,versions); return quoteToWire(quote);
    } catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"quote rejected"});}
  });
  app.post("/v1/prepare",async(request,reply)=>{
    const parsed=intentRequestSchema.safeParse(request.body);
    if(!parsed.success)return reply.code(400).send({error:"invalid intent request"});
    const quote=quotes.get(parsed.data.quoteId);
    const versions=quoteVersions.get(parsed.data.quoteId);
    if(!quote||!versions||quote.expiresAtMs<=Date.now())return reply.code(409).send({error:"quote expired"});
    try {
      const intent=makeIntent(quote,versions,parsed.data.account,parsed.data.nonce);
      const binding=quoteBindings.get(quote.quoteId);
      if(binding&&(binding.account!==intent.account||binding.nonce!==parsed.data.nonce))return reply.code(409).send({error:"quote already prepared"});
      quoteBindings.set(quote.quoteId,{account:intent.account,nonce:parsed.data.nonce});
      return {domain:{...domain,chainId:domain.chainId.toString()},types:intentTypes,intent:intentToWire(intent),intentHash:hashIntent(domain,intent)};
    } catch{return reply.code(400).send({error:"invalid account or nonce"});}
  });
  app.post("/v1/approve",async(request,reply)=>{
    const parsed=approvalRequestSchema.safeParse(request.body);
    if(!parsed.success)return reply.code(400).send({error:"invalid signed intent"});
    const quote=quotes.get(parsed.data.quoteId);
    const versions=quoteVersions.get(parsed.data.quoteId);
    if(!quote||!versions||quote.expiresAtMs<=Date.now())return reply.code(409).send({error:"quote expired"});
    const binding=quoteBindings.get(quote.quoteId);
    let requestedAccount:string;try{requestedAccount=getAddress(parsed.data.account);}catch{return reply.code(400).send({error:"invalid account"});}
    if(!binding||binding.account!==requestedAccount||binding.nonce!==parsed.data.nonce)return reply.code(409).send({error:"quote preparation mismatch"});
    let intent:TradeIntent;
    try { intent=makeIntent(quote,versions,parsed.data.account,parsed.data.nonce);const signer=recoverIntentSigner(domain,intent,parsed.data.userSignature);if(signer!==intent.account){if(!clearing)throw new Error();const session=await clearing.sessions(signer);if(getAddress(session.account)!==intent.account||BigInt(session.validUntil)<intent.deadline||(Number(session.marketMask)&(1<<intent.market))===0||BigInt(session.maxFee)<intent.maxFee)throw new Error();} }
    catch{return reply.code(401).send({error:"invalid user signature"});}
    prune();
    if(!pending.some(item=>item.quoteId===quote.quoteId))pending.push({quoteId:quote.quoteId,market:quote.market,delta:quote.delta,expiresAtMs:Number(intent.deadline)*1_000});
    const intentHash=hashIntent(domain,intent);
    let report="0x";
    if(provider){
      const timestamp=options.chain?.devFund?await advanceLocalChainTime():Number(BigInt((await provider.send("eth_getBlockByNumber",["latest",false]) as {timestamp:string}).timestamp));
      report=AbiCoder.defaultAbiCoder().encode(["tuple(uint8 market,uint256 bid,uint256 ask,uint64 observedAt,uint64 validUntil)"],[[intent.market,quote.snapshot.bid,quote.snapshot.ask,BigInt(timestamp),BigInt(timestamp+60)]]);
    }
    const oracleReportHash=report==="0x"?keccak256(toUtf8Bytes(JSON.stringify({market:quote.market,bid:quote.snapshot.bid.toString(),ask:quote.snapshot.ask.toString(),observedAtMs:quote.snapshot.observedAtMs}))):keccak256(report);
    const approval:MakerApproval={intentHash,executionPrice:quote.expectedPrice,impactCharge:quote.impactCharge,fee:quote.fee,oracleReportHash,deadline:intent.deadline,leaderEpoch:versions.leaderEpoch,signerSetVersion:versions.signerSetVersion,policyVersion:versions.policyVersion};
    const digest=hashApproval(domain,approval);
    journal?.prepare("INSERT INTO commitments VALUES (?, ?, ?, ?, 'reserved', ?, ?, ?, NULL, ?) ON CONFLICT(quote_id) DO UPDATE SET status='reserved', intent_json=excluded.intent_json, user_signature=excluded.user_signature, approval_json=excluded.approval_json, updated_ms=excluded.updated_ms").run(quote.quoteId,quote.market,quote.delta.toString(),Number(intent.deadline)*1_000,JSON.stringify(intentToWire(intent)),parsed.data.userSignature,JSON.stringify(approvalToWire(approval)),Date.now());
    const approverPayload={domain:{...domain,chainId:domain.chainId.toString()},intent:intentToWire(intent),userSignature:parsed.data.userSignature,approval:approvalToWire(approval),quote:quoteToWire(quote),report,oracleAgeMs:Date.now()-quote.snapshot.observedAtMs};
    const responses=await Promise.allSettled((options.approvers??[]).map(async approver=>{
      const response=await fetchImpl(`${approver.url}/approve`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${approver.token}`},body:JSON.stringify(approverPayload),signal:AbortSignal.timeout(1_000)});
      if(!response.ok)throw new Error(`approver ${response.status}: ${await response.text()}`);
      const result=await response.json() as {digest:string;signer:string;signature:string};
      if(result.digest!==digest||recoverAddress(digest,result.signature).toLowerCase()!==result.signer.toLowerCase())throw new Error("invalid approver response");
      return result;
    }));
    const approvals=responses.filter((item):item is PromiseFulfilledResult<{digest:string;signer:string;signature:string}>=>item.status==="fulfilled").map(item=>item.value);
    const distinct=new Map(approvals.map(item=>[item.signer.toLowerCase(),item]));
    if(distinct.size<2)return reply.code(503).send({error:"approver quorum unavailable",details:options.chain?.devFund?responses.filter(item=>item.status==="rejected").map(item=>String(item.reason)):undefined});
    const selected=[...distinct.values()].slice(0,2);
    journal?.prepare("UPDATE commitments SET status='approved', updated_ms=? WHERE quote_id=?").run(Date.now(),quote.quoteId);
    let transaction:undefined|{hash:string;blockNumber:number;collateral:string;position:{size:string;entryPrice:string;lastFundingIndex:string}};
    if(clearing&&token&&provider&&options.chain&&sender){
      try {
        if(options.chain.devFund&&BigInt(await clearing.collateralOf(intent.account))<2_000n*1_000_000n){
          const amount=10_000n*1_000_000n,depositNonce=keccak256(toUtf8Bytes(`autofund:${quote.quoteId}`)),timestamp=await advanceLocalChainTime();
          await sender.submit(`autofund-mint:${quote.quoteId}`,{to:options.chain.tokenAddress,data:token.interface.encodeFunctionData("mint",[intent.account,amount])});
          await sender.submit(`autofund:${quote.quoteId}`,{to:options.chain.clearingAddress,data:clearing.interface.encodeFunctionData("depositWithAuthorization",[intent.account,amount,timestamp-60,timestamp+600,depositNonce,27,"0x"+"00".repeat(32),"0x"+"00".repeat(32)])});
        }
        const receipt=await sender.submit(`trade:${quote.quoteId}`,{to:options.chain.clearingAddress,data:clearing.interface.encodeFunctionData("executeTrade",[intent,approval,report,parsed.data.userSignature,selected[0].signature,selected[1].signature])});journal?.prepare("UPDATE commitments SET status='submitted', tx_hash=?, updated_ms=? WHERE quote_id=?").run(receipt.hash,Date.now(),quote.quoteId);
        const collateral=await clearing.collateralOf(intent.account); const position=await clearing.positionOf(intent.account,intent.market);
        transaction={hash:receipt.hash,blockNumber:receipt.blockNumber,collateral:collateral.toString(),position:{size:position.size.toString(),entryPrice:position.entryPrice.toString(),lastFundingIndex:position.lastFundingIndex.toString()}};
        journal?.prepare("UPDATE commitments SET status='included', updated_ms=? WHERE quote_id=?").run(Date.now(),quote.quoteId);
        settled[quote.market]+=quote.delta; const index=pending.findIndex(item=>item.quoteId===quote.quoteId); if(index>=0)pending.splice(index,1);
      } catch(error){return reply.code(409).send({error:error instanceof Error?`chain submission failed: ${error.message}`:"chain submission failed"});}
    }
    return {domain:{...domain,chainId:domain.chainId.toString()},intent:intentToWire(intent),userSignature:parsed.data.userSignature,approval:approvalToWire(approval),approvals:selected,quote:quoteToWire(quote),transaction};
  });
  app.addHook("onReady",async()=>{await sender?.reconcile();});
  app.addHook("onClose",async()=>journal?.close());
  return app;
}
