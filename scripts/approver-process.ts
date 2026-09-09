import { buildApprover } from "../services/approver/src/server.js";

const required=(name:string)=>{const value=process.env[name];if(!value)throw new Error(`missing ${name}`);return value;};
const rpcUrl=required("RFQ_RPC_URL");
const app=buildApprover({privateKey:required("RFQ_APPROVER_KEY"),transportToken:required("RFQ_APPROVER_TOKEN"),databasePath:required("RFQ_APPROVER_DB"),expectedChainId:BigInt(required("RFQ_CHAIN_ID")),expectedVerifyingContract:required("RFQ_CLEARING_ADDRESS"),rpcUrl,secondaryRpcUrl:process.env.RFQ_SECONDARY_RPC_URL??rpcUrl,maxFutureSeconds:Number(process.env.RFQ_MAX_FUTURE_SECONDS??5)});
const port=Number(required("RFQ_APPROVER_PORT"));await app.listen({host:"127.0.0.1",port});
const shutdown=async()=>{await app.close();process.exit(0);};process.on("SIGINT",shutdown);process.on("SIGTERM",shutdown);
