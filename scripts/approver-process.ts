import { buildApprover } from "../services/approver/src/server.js";

const required=(name:string)=>{const value=process.env[name];if(!value)throw new Error(`missing ${name}`);return value;};
const rpcUrl=required("RFQ_RPC_URL");
const streams=process.env.RFQ_BTC_FEED_ID&&process.env.RFQ_ETH_FEED_ID?{feedIds:[process.env.RFQ_BTC_FEED_ID,process.env.RFQ_ETH_FEED_ID] as [string,string],feedDecimals:[Number(process.env.RFQ_BTC_FEED_DECIMALS??8),Number(process.env.RFQ_ETH_FEED_DECIMALS??8)] as [number,number]}:undefined;
const app=buildApprover({privateKey:required("RFQ_APPROVER_KEY"),transportToken:required("RFQ_APPROVER_TOKEN"),databasePath:required("RFQ_APPROVER_DB"),expectedChainId:BigInt(required("RFQ_CHAIN_ID")),expectedVerifyingContract:required("RFQ_CLEARING_ADDRESS"),rpcUrl,secondaryRpcUrl:process.env.RFQ_SECONDARY_RPC_URL??rpcUrl,maxFutureSeconds:Number(process.env.RFQ_MAX_FUTURE_SECONDS??5),dataStreams:streams});
const port=Number(required("RFQ_APPROVER_PORT"));await app.listen({host:"127.0.0.1",port});
const shutdown=async()=>{await app.close();process.exit(0);};process.on("SIGINT",shutdown);process.on("SIGTERM",shutdown);
