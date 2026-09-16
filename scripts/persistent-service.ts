import {readFileSync,statSync,realpathSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {Contract,JsonRpcProvider,Wallet} from 'ethers';
import {z} from 'zod';
import {buildApi} from '../services/api/src/server.js';
import {buildApprover} from '../services/approver/src/server.js';
import {buildIndexer} from '../services/indexer/src/server.js';
import {buildGateway} from '../services/gateway/src/server.js';
import {buildHedger} from '../services/hedger/src/server.js';
import {HyperliquidVenue} from '../services/hedger/src/hyperliquid.js';
import {PythHermesSource} from '../services/api/src/oracle.js';
import {HttpHedgeRiskSource} from '../services/api/src/hedge-risk.js';
import {buildKeeper} from '../services/keeper/src/server.js';
import {validateRuntimeIdentity} from './runtime-identity.js';
const role=z.enum(['api','approver','indexer','gateway','hedger','keeper']).parse(process.argv[2]);
const config=z.object({chainId:z.literal('84532'),runtimeIdentity:z.object({oracleAddress:z.string(),oracleSource:z.string(),governance:z.string(),emergencyCouncil:z.string(),implementationAddress:z.string(),riskMathAddress:z.string(),signatureVerifierAddress:z.string(),approvers:z.tuple([z.string(),z.string(),z.string()]),code:z.array(z.object({address:z.string(),hash:z.string().regex(/^0x[0-9a-fA-F]{64}$/)}).strict()).min(7)}).strict(),rpcUrl:z.string().url(),secondaryRpcUrl:z.string().url(),clearingAddress:z.string(),tokenAddress:z.string(),stateDirectory:z.string(),sponsorAddress:z.string().optional(),port:z.number().int().min(1024).max(65535),startBlock:z.number().int().nonnegative(),publicRpcUrl:z.string().url(),corsOrigin:z.string().url(),hedgeRiskUrl:z.string().url(),indexerUrl:z.string().url(),apiUrl:z.string().url(),feedIds:z.tuple([z.string(),z.string()]),approvers:z.array(z.object({url:z.string().url(),token:z.string()})).length(3).optional(),hedgeBandUsdc:z.string(),hedgeMaxOrderUsdc:z.string(),hedgeMinOrderUsdc:z.string()}).strict().parse(JSON.parse(readFileSync(process.argv[3],'utf8')));
// Separate secret files and host users are required for every signing role.
if(statSync(process.argv[3]).mode&0o077)throw new Error("Role configuration must be private (0600)");
const secretPath=process.argv[4];if(secretPath&&(statSync(secretPath).mode&0o077))throw new Error('Role secret file must have mode 0600 or stricter');
const secretSchemas={api:z.object({sponsorKey:z.string(),oracleKey:z.string(),operationsToken:z.string(),dailyBudgetWei:z.string(),maxFeePerGas:z.string(),maxOracleValueWei:z.string()}).strict(),keeper:z.object({sponsorKey:z.string(),oracleKey:z.string(),operationsToken:z.string(),dailyBudgetWei:z.string(),maxFeePerGas:z.string(),maxOracleValueWei:z.string()}).strict(),approver:z.object({privateKey:z.string(),transportToken:z.string(),hedgeToken:z.string()}).strict(),hedger:z.object({agentKey:z.string(),accountAddress:z.string(),agentName:z.string(),operationsToken:z.string()}).strict(),indexer:z.object({}).strict(),gateway:z.object({}).strict()};
const secrets=secretSchemas[role].parse(secretPath?JSON.parse(readFileSync(secretPath,'utf8')):{}) as Record<string,string>;
if(!isAbsolute(config.stateDirectory)||!realpathSync(config.stateDirectory).startsWith('/var/lib/rfq/'))throw new Error('State must reside on the provisioned /var/lib/rfq persistent volume');
const provider=new JsonRpcProvider(config.rpcUrl,undefined,{batchMaxCount:1});if((await provider.getNetwork()).chainId!==BigInt(config.chainId))throw new Error('RPC chain does not match manifest');
const secondary=new JsonRpcProvider(config.secondaryRpcUrl,undefined,{batchMaxCount:1});try{await validateRuntimeIdentity(provider,secondary,{...config.runtimeIdentity,chainId:BigInt(config.chainId),clearingAddress:config.clearingAddress,tokenAddress:config.tokenAddress,feedIds:config.feedIds});}finally{secondary.destroy();}
if(await provider.getCode(config.clearingAddress)==='0x')throw new Error('Clearing proxy missing');
const clearing=new Contract(config.clearingAddress,['function usdc() view returns(address)','function isApprover(address) view returns(bool)','function exposureState(uint8) view returns(uint256 longBase,uint256 shortBase,uint256 limits,uint256 cursor,bool ready)'],provider);if(String(await clearing.usdc()).toLowerCase()!==config.tokenAddress.toLowerCase())throw new Error('Settlement token mismatch');
if(role==='api'||role==='approver'){for(let market=0;market<2;market++)if(!(await clearing.exposureState(market)).ready)throw new Error('Exposure migration must finish before starting financial admission services');}
if(role==='api'||role==='keeper'){const sponsor=new Wallet(secrets.sponsorKey).address;if(!config.sponsorAddress||sponsor.toLowerCase()!==config.sponsorAddress.toLowerCase()||[config.runtimeIdentity.governance,config.runtimeIdentity.emergencyCouncil,...config.runtimeIdentity.approvers].some(address=>address.toLowerCase()===sponsor.toLowerCase()))throw new Error('Sponsor must match its reviewed independent role identity');}
const databasePath=join(config.stateDirectory,`${role}.sqlite`),chainId=BigInt(config.chainId);
let app;
switch(role){
 case 'keeper':app=buildKeeper({rpcUrl:config.rpcUrl,chainId,clearingAddress:config.clearingAddress,tokenAddress:config.tokenAddress,sponsorKey:secrets.sponsorKey,databasePath,indexerUrl:config.indexerUrl,operationsToken:secrets.operationsToken,budget:{maxGasLimit:2_000_000n,maxFeePerGas:BigInt(secrets.maxFeePerGas),maxValue:BigInt(secrets.maxOracleValueWei),dailyBudgetWei:BigInt(secrets.dailyBudgetWei)},oracleSource:new PythHermesSource({apiKey:secrets.oracleKey,feedIds:{BTC:config.feedIds[0],ETH:config.feedIds[1]}})});break;
 case 'indexer':app=buildIndexer({rpcUrl:config.rpcUrl,clearingAddress:config.clearingAddress,databasePath,startBlock:config.startBlock,confirmations:12,corsOrigin:config.corsOrigin});break;
 case 'gateway':app=buildGateway({upstreamUrl:config.apiUrl,corsOrigin:config.corsOrigin});break;
 case 'approver':if(!await clearing.isApprover(new Wallet(secrets.privateKey).address))throw new Error('Key is not a current approver');app=buildApprover({privateKey:secrets.privateKey,transportToken:secrets.transportToken,databasePath,expectedChainId:chainId,expectedVerifyingContract:config.clearingAddress,rpcUrl:config.rpcUrl,secondaryRpcUrl:config.secondaryRpcUrl,oracleMode:'pyth',hedgeRisk:{url:config.hedgeRiskUrl,token:secrets.hedgeToken,maxAgeMs:3000}});break;
 case 'api':if(!config.approvers)throw new Error('Missing independently provisioned approvers');app=buildApi({approvers:config.approvers,chainId,verifyingContract:config.clearingAddress,journalPath:databasePath,senderBudget:{maxGasLimit:2_000_000n,maxFeePerGas:BigInt(secrets.maxFeePerGas),maxValue:BigInt(secrets.maxOracleValueWei),dailyBudgetWei:BigInt(secrets.dailyBudgetWei)},oracleSource:new PythHermesSource({apiKey:secrets.oracleKey,feedIds:{BTC:config.feedIds[0],ETH:config.feedIds[1]}}),hedgeRiskSource:new HttpHedgeRiskSource(config.hedgeRiskUrl,secrets.operationsToken),operationsToken:secrets.operationsToken,publicRpcUrl:config.publicRpcUrl,chain:{rpcUrl:config.rpcUrl,sponsorPrivateKey:secrets.sponsorKey,clearingAddress:config.clearingAddress,tokenAddress:config.tokenAddress}});break;
 case 'hedger':{const venue=new HyperliquidVenue({agentPrivateKey:secrets.agentKey,accountAddress:secrets.accountAddress,agentName:secrets.agentName,apiUrl:'https://api.hyperliquid-testnet.xyz',pythonPath:'/opt/hyperliquid/bin/python',minimumPerpUsdc:config.hedgeMinOrderUsdc});await venue.verify();app=buildHedger({indexerUrl:config.indexerUrl,databasePath,venue,healthToken:secrets.operationsToken,bandUsdc:BigInt(config.hedgeBandUsdc),maxOrderUsdc:BigInt(config.hedgeMaxOrderUsdc),minOrderUsdc:BigInt(config.hedgeMinOrderUsdc)});break;}
}
provider.destroy();
await app.listen({host:'127.0.0.1',port:config.port});
let stopping=false;for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{if(stopping)return;stopping=true;void app.close().then(()=>process.exit(0),()=>process.exit(1));});
