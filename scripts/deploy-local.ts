import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Contract, ContractFactory, Interface, JsonRpcProvider, MaxUint256, NonceManager, Wallet, parseEther } from "ethers";

const rpcUrl=process.env.RFQ_RPC_URL??"http://127.0.0.1:8545";
const provider=new JsonRpcProvider(rpcUrl);const owner=await provider.getSigner(0);const ownerAddress=await owner.getAddress();const deployer=new NonceManager(owner);
const sponsorWallet=process.env.RFQ_LOCAL_SPONSOR_KEY?new Wallet(process.env.RFQ_LOCAL_SPONSOR_KEY):Wallet.createRandom();
const artifact=(name:string)=>JSON.parse(readFileSync(resolve("artifacts",`${name}.json`),"utf8"));
const deploy=async(name:string,args:unknown[]=[])=>{const item=artifact(name);const contract=await new ContractFactory(item.abi,item.bytecode,deployer).deploy(...args);await contract.waitForDeployment();return contract;};

const chain=await provider.getNetwork(); if(chain.chainId!==31_337n)throw new Error(`unexpected local chain ${chain.chainId}`);
const approvers=[Wallet.createRandom(),Wallet.createRandom(),Wallet.createRandom()];
const token=await deploy("MockUSDC"); const oracle=await deploy("MockPriceOracle"); const implementation=await deploy("RFQClearing");
const clearingInterface=new Interface(artifact("RFQClearing").abi);
const init=clearingInterface.encodeFunctionData("initialize",[await token.getAddress(),await oracle.getAddress(),ownerAddress,ownerAddress,approvers.map(item=>item.address),600_000_000_000n]);
const proxy=await deploy("TestProxy",[await implementation.getAddress(),init]); const clearing=new Contract(await proxy.getAddress(),artifact("RFQClearing").abi,deployer);
await (await token.mint(ownerAddress,750_000_000_000n)).wait(); await (await token.approve(await clearing.getAddress(),MaxUint256)).wait();
await (await clearing.fundMaker(600_000_000_000n)).wait(); await (await clearing.fundInsurance(150_000_000_000n)).wait();
await (await deployer.sendTransaction({to:sponsorWallet.address,value:parseEther("5")})).wait();
const deployment={rpcUrl,chainId:chain.chainId.toString(),clearingAddress:await clearing.getAddress(),tokenAddress:await token.getAddress(),oracleAddress:await oracle.getAddress(),implementationAddress:await implementation.getAddress(),deploymentBlock:await provider.getBlockNumber(),approvers:approvers.map(item=>({address:item.address,privateKey:item.privateKey})),sponsorPrivateKey:sponsorWallet.privateKey,deployedAt:new Date().toISOString()};
mkdirSync(resolve(".local-state"),{recursive:true}); const path=resolve(".local-state","deployment.json"); writeFileSync(path,JSON.stringify(deployment,null,2),{mode:0o600}); chmodSync(path,0o600);
console.log(JSON.stringify({chainId:deployment.chainId,clearingAddress:deployment.clearingAddress,tokenAddress:deployment.tokenAddress,oracleAddress:deployment.oracleAddress,approvers:deployment.approvers.map(item=>item.address)},null,2));
