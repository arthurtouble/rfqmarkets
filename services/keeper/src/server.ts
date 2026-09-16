import Fastify from 'fastify';
import {DatabaseSync} from 'node:sqlite';
import {Contract,JsonRpcProvider,Wallet,getAddress,type TransactionRequest} from 'ethers';
import {clearingStateAbi} from '../../../packages/shared/src/abi.js';
import {bindGrossContext,initializeGrossJournal} from '../../../packages/shared/src/gross-reservation-journal.js';
import {DurableSender,type SenderOptions} from '../../api/src/sender.js';
import type {OracleSource} from '../../api/src/oracle.js';
import {KeeperEngine,type KeeperAction,type KeeperDependencies} from './engine.js';

const keeperAbi=[...clearingStateAbi,'function usdc() view returns(address)','function liquidate(address,uint8,bytes) payable','function submitResolutionObservation(bytes) payable','function processResolution(uint256)','function resolutionPricesReady() view returns(bool)','function resolutionFinalized() view returns(bool)','function resolutionCursor() view returns(uint256)','function resolutionSampleCount(uint256) view returns(uint8)'];
export interface KeeperOptions {rpcUrl:string;chainId:bigint;clearingAddress:string;tokenAddress:string;sponsorKey:string;databasePath:string;oracleSource:OracleSource;indexerUrl:string;operationsToken:string;budget:SenderOptions;pollMs?:number;provider?:JsonRpcProvider;fetchImpl?:typeof fetch;dependencies?:KeeperDependencies}
export function buildKeeper(options:KeeperOptions){
 if(!options.operationsToken||!options.budget.dailyBudgetWei||!options.budget.maxGasLimit||!options.budget.maxFeePerGas||options.budget.maxValue===undefined)throw new Error('keeper requires explicit sponsor budgets and private operations token');
 const app=Fastify({logger:false}),provider=options.provider??new JsonRpcProvider(options.rpcUrl,undefined,{batchMaxCount:1}),wallet=new Wallet(options.sponsorKey,provider),clearing=new Contract(options.clearingAddress,keeperAbi,provider),db=new DatabaseSync(options.databasePath);
 db.exec('PRAGMA journal_mode=WAL');initializeGrossJournal(db);bindGrossContext(db,'keeper',`${options.chainId}:${getAddress(options.clearingAddress)}:${wallet.address}`);
 const sender=new DurableSender(provider,wallet,db,{...options.budget,chainId:options.chainId}),fetcher=options.fetchImpl??fetch;
 const validateChain=async()=>{if((await provider.getNetwork()).chainId!==options.chainId||getAddress(await clearing.usdc())!==getAddress(options.tokenAddress))throw new Error('keeper chain/token mismatch');};
 const engine=new KeeperEngine(options.dependencies??{
  reconcile:async()=>{await validateChain();await sender.reconcile();return !sender.status().some(row=>['signed','submitted','ambiguous','reorged'].includes(String(row.status)));},
  state:async()=>{const blockNumber=Number(BigInt(await provider.send('eth_blockNumber',[]))),block=await provider.getBlock(blockNumber);if(!block)throw new Error('missing keeper block');const tag={blockTag:blockNumber};const [required,ready,finalized,cursor,btcCount,ethCount,btc,eth]=await Promise.all([clearing.resolutionRequired(tag),clearing.resolutionPricesReady(tag),clearing.resolutionFinalized(tag),clearing.resolutionCursor(tag),clearing.resolutionSampleCount(0,tag),clearing.resolutionSampleCount(1,tag),clearing.markets(0,tag),clearing.markets(1,tag)]);return {resolutionRequired:required,resolutionPricesReady:ready,resolutionFinalized:finalized,resolutionCursor:BigInt(cursor),sampleCounts:[Number(btcCount),Number(ethCount)],priceTimes:[Number(btc.lastPriceTime),Number(eth.lastPriceTime)],timestamp:block.timestamp};},
  proof:async market=>{const source=options.oracleSource,quote=await (source.settlement?.(market===0?'BTC':'ETH')??source.latest(market===0?'BTC':'ETH'));return {report:quote.report,observedAt:Math.floor(quote.snapshot.observedAtMs/1000),validUntil:quote.validUntil};},
  accounts:async(cursor,limit)=>{const health=await fetcher(`${options.indexerUrl}/health`,{signal:AbortSignal.timeout(3000)});if(!health.ok)throw new Error('keeper indexer unavailable');const status=await health.json() as {ok:boolean;lag:number};if(!status.ok||!Number.isInteger(status.lag)||status.lag<0||status.lag>12)throw new Error('keeper indexer unhealthy');const url=new URL('/v1/positions',options.indexerUrl);url.searchParams.set('finalized','false');url.searchParams.set('limit',String(limit));if(cursor)url.searchParams.set('cursor',cursor);const response=await fetcher(url,{signal:AbortSignal.timeout(3000)});if(!response.ok)throw new Error('keeper indexer page unavailable');return response.json();},
  execute:async(id,action:KeeperAction)=>{
   let data:string,value=0n;
   if(action.kind==='process')data=clearing.interface.encodeFunctionData('processResolution',[action.maxAccounts]);
   else if(action.kind==='incident')data=clearing.interface.encodeFunctionData('declareResolution');
   else {const adapter=new Contract(await clearing.oracle(),['function updateFee(bytes) view returns(uint256)'],provider);value=BigInt(await adapter.updateFee(action.proof.report));data=action.kind==='liquidate'?clearing.interface.encodeFunctionData('liquidate',[action.account,action.market,action.proof.report]):clearing.interface.encodeFunctionData(action.kind==='sample'?'submitResolutionObservation':'refreshOracle',[action.proof.report]);}
   const request:TransactionRequest={from:wallet.address,to:options.clearingAddress,data,value};
   let gas:bigint;try{await provider.call(request);gas=await provider.estimateGas(request);}catch(error){if((error as {code?:string}).code==='CALL_EXCEPTION'||action.kind==='incident'&&String(error).includes('0xfc220038'))return false;throw error;}
   const gasLimit=gas+gas/5n+10_000n;if(gasLimit>options.budget.maxGasLimit!||value>options.budget.maxValue!)throw new Error('keeper action exceeds configured budget');
   await sender.submit(id,{...request,gasLimit});return true;
  },
 });
 let timer:ReturnType<typeof setInterval>|undefined;
 app.get('/health',async()=>engine.status());
 app.get('/internal/metrics',async(request,reply)=>{if(request.headers.authorization!==`Bearer ${options.operationsToken}`)return reply.code(401).send({error:'unauthorized'});return {...engine.status(),sender:sender.status()};});
 app.addHook('onReady',async()=>{if(!options.dependencies)await validateChain();await engine.cycle();timer=setInterval(()=>void engine.cycle(),options.pollMs??2000);timer.unref();});
 app.addHook('onClose',async()=>{if(timer)clearInterval(timer);await engine.close();await options.oracleSource.close?.();db.close();if(!options.provider)provider.destroy();});
 return app;
}
