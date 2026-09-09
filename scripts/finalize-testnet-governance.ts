import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ProtocolKit from "@safe-global/protocol-kit";
import { Contract, Interface, JsonRpcProvider, Wallet, ZeroHash, parseEther } from "ethers";

type Identity={address:string;privateKey:string};
type Bundle={deployer:Identity;governanceOwners:[Identity,Identity,Identity]};
type Governance={governanceSafe:string;timelock:string};

const identities=JSON.parse(readFileSync(resolve(".local-state/testnet-identities.json"),"utf8")) as Bundle;
const governance=JSON.parse(readFileSync(resolve(".local-state/base-sepolia-governance.json"),"utf8")) as Governance;
const rpcUrl=process.env.RFQ_BASE_SEPOLIA_RPC_URL??"https://sepolia.base.org";
const provider=new JsonRpcProvider(rpcUrl);
const timelock=new Contract(governance.timelock,["function hasRole(bytes32,address) view returns(bool)"],provider);

if(!await timelock.hasRole(ZeroHash,governance.governanceSafe)){
  console.log(JSON.stringify({finalized:true,alreadyFinalized:true,timelock:governance.timelock},null,2));
  process.exit(0);
}

const executor=identities.governanceOwners[0].address;
const gasTarget=parseEther("0.0002");
const gasBalance=await provider.getBalance(executor);
if(gasBalance<gasTarget){
  const deployer=new Wallet(identities.deployer.privateKey,provider);
  await (await deployer.sendTransaction({to:executor,value:gasTarget-gasBalance})).wait();
  for(let attempt=0;attempt<20;attempt++){
    if(await new JsonRpcProvider(rpcUrl).getBalance(executor)>=gasTarget)break;
    await new Promise(resolve=>setTimeout(resolve,1_000));
  }
}
if(await new JsonRpcProvider(rpcUrl).getBalance(executor)===0n)throw new Error("governance Safe executor has no gas");

const Safe=ProtocolKit.default as unknown as {init(config:Record<string,unknown>):Promise<any>};
const first=await Safe.init({provider:rpcUrl,signer:identities.governanceOwners[0].privateKey,safeAddress:governance.governanceSafe});
const second=await Safe.init({provider:rpcUrl,signer:identities.governanceOwners[1].privateKey,safeAddress:governance.governanceSafe});
const data=new Interface(["function renounceRole(bytes32 role,address account)"]).encodeFunctionData("renounceRole",[ZeroHash,governance.governanceSafe]);
const transaction=await first.createTransaction({transactions:[{to:governance.timelock,value:"0",data}]});
const hash=await first.getTransactionHash(transaction);
transaction.addSignature(await first.signHash(hash));
transaction.addSignature(await second.signHash(hash));
const execution=await first.executeTransaction(transaction);
await execution.transactionResponse?.wait();

for(let attempt=0;attempt<20;attempt++){
  const fresh=new Contract(governance.timelock,["function hasRole(bytes32,address) view returns(bool)"],new JsonRpcProvider(rpcUrl));
  if(!await fresh.hasRole(ZeroHash,governance.governanceSafe)){
    console.log(JSON.stringify({finalized:true,alreadyFinalized:false,timelock:governance.timelock,transactionHash:execution.hash},null,2));
    process.exit(0);
  }
  await new Promise(resolve=>setTimeout(resolve,1_000));
}
throw new Error("governance Safe retained timelock admin after finalization transaction");
