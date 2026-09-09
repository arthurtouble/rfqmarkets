import assert from "node:assert/strict";
import { Contract, JsonRpcProvider } from "ethers";

const RPC=process.env.RFQ_BASE_SEPOLIA_RPC_URL??"https://sepolia.base.org";
const PRECONF_RPC=process.env.RFQ_BASE_SEPOLIA_PRECONF_RPC_URL??"https://sepolia-preconf.base.org";
const USDC="0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PYTH="0x5f52e4DBEA21f5b23523B6e20d50c29ae0a4EB83";

const provider=new JsonRpcProvider(RPC),preconf=new JsonRpcProvider(PRECONF_RPC);
const [network,preconfNetwork,usdcCode,pythCode,latest,pending]=await Promise.all([
  provider.getNetwork(),preconf.getNetwork(),provider.getCode(USDC),provider.getCode(PYTH),
  provider.getBlock("latest"),preconf.getBlock("pending"),
]);
assert.equal(network.chainId,84_532n,"standard RPC is not Base Sepolia");
assert.equal(preconfNetwork.chainId,84_532n,"preconfirmation RPC is not Base Sepolia");
assert.notEqual(usdcCode,"0x","official Base Sepolia USDC is missing");
assert.notEqual(pythCode,"0x","Pyth Core is missing");
const token=new Contract(USDC,["function decimals() view returns(uint8)","function name() view returns(string)"],provider);
const [decimals,name]=await Promise.all([token.decimals(),token.name()]);
assert.equal(decimals,6n,"USDC must have six decimals");
assert(latest&&pending,"latest and pending blocks must be available");
console.log(JSON.stringify({ready:true,chainId:network.chainId.toString(),rpc:RPC,preconfirmationRpc:PRECONF_RPC,latestBlock:latest.number,pendingBlock:pending.number,contracts:{usdc:{address:USDC,name,decimals:Number(decimals)},pythCore:PYTH}},null,2));
