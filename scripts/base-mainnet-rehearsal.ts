// Full Base mainnet deployment rehearsal on a local OP chain that reports chain ID 8453.
// Production: preflight -> deploy (with an interrupted run and resume) -> verify paused with caps ->
// timelocked go-live. Dev: owner deploy -> unpause -> deposit -> upgrade -> handover to a Safe-run
// timelock without redeploying. Prints measured gas.
import assert from "node:assert/strict";
import "@nomicfoundation/hardhat-ethers";
import { network } from "hardhat";
import { Contract, ContractFactory, Wallet, formatEther, getAddress, parseUnits, type Signer } from "ethers";
import { devPreflight, generateDevIdentities, handoverDev, unpauseDev, upgradeDev, verifyDev } from "./base-mainnet-dev.js";
import { PROXY_ADMIN_ABI, PROXY_GAS_UPPER_BOUND, artifact, basescanSubmissions, deployCore, launchBatches, libraryOrder, preflight, renounceTimelockAdminBatch, verifyDeployment } from "./base-mainnet.js";
import { identifyCandidate } from "./candidate-identity.js";
import { validateDevManifest, validateMainnetManifest } from "./mainnet-manifest.js";

const BASE_USDC="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",DELAY=259200;
const {ethers,provider:rpc}=await network.create({network:"hardhatBaseRehearsal",chainType:"op"});
const signers=await ethers.getSigners(),[deployer,ceremony,g1,g2,g3,e1,e2,e3,a1,a2,a3]=signers;
const provider=ethers.provider;
assert.equal((await provider.getNetwork()).chainId,8453n);

const deploy=async(name:string,args:unknown[],from:Signer=ceremony)=>{const item=artifact(name);const contract=await new ContractFactory(item.abi,item.bytecode,from).deploy(...args);await contract.waitForDeployment();return new Contract(await contract.getAddress(),item.abi,from);};
const advance=async()=>{await rpc.request({method:"evm_increaseTime",params:[DELAY+1]});await rpc.request({method:"evm_mine",params:[]});};
// Stand-ins for contracts that already exist on Base mainnet.
await rpc.request({method:"hardhat_setCode",params:[BASE_USDC,artifact("MockUSDC").deployedBytecode]});
const pyth=await deploy("MockPythCore",[]);
const governanceSafe=await deploy("MockSafe",[[g1.address,g2.address,g3.address],2]),emergencySafe=await deploy("MockSafe",[[e1.address,e2.address,e3.address],2]);
const timelock=await deploy("RFQTimelock",[DELAY,await governanceSafe.getAddress()]);
const runBatch=async(safe:Contract,batch:{transactions:{to:string;data:string}[]})=>{for(const tx of batch.transactions)await (await safe.exec(tx.to,tx.data)).wait();};

const market={enabled:true,maxTradeUsdc:"10000000000",grossUsdc:"100000000000",sideUsdc:"75000000000",netUsdc:"75000000000",hedgeBandUsdc:"5000000000"};
const manifest=validateMainnetManifest({version:1,mode:"capped-canary",chainId:"8453",candidateHash:identifyCandidate().candidateHash,usdc:BASE_USDC,oracleSource:await pyth.getAddress(),
  feedIds:["0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43","0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace"],
  governance:await timelock.getAddress(),governanceSafe:await governanceSafe.getAddress(),emergencyCouncil:await emergencySafe.getAddress(),approvers:[a1.address,a2.address,a3.address],
  policy:{makerCapitalUsdc:"1000000000000",insuranceCapitalUsdc:"250000000000",dailyLossLimitUsdc:"25000000000",timelockSeconds:DELAY,markets:{BTC:market,ETH:market}}});

await assert.rejects(preflight(provider,manifest,deployer.address),/timelock admin/,"preflight must refuse while the governance Safe still administers the timelock");
await runBatch(governanceSafe,renounceTimelockAdminBatch("8453",manifest.governance,manifest.governanceSafe));
await assert.rejects(preflight(provider,manifest,g1.address),/protocol role|own the governance Safe/,"a Safe owner cannot be the deployer");
const report=await preflight(provider,manifest,deployer.address);

// Interrupt after two libraries, then resume from the partial record.
const [firstLibrary,secondLibrary]=libraryOrder();
let partial:Record<string,string>={};
await assert.rejects(deployCore(deployer,manifest,{candidateHash:manifest.candidateHash,launchProfile:"dormant",confirmations:1,onStep:(step,_address,current)=>{partial=current;if(step===secondLibrary)throw new Error("simulated interruption");}}),/simulated interruption/);
assert.deepEqual(Object.keys(partial),[firstLibrary,secondLibrary]);
const record=await deployCore(deployer,manifest,{candidateHash:manifest.candidateHash,launchProfile:"dormant",confirmations:1,resume:partial});
assert.equal(record.contracts.libraries[firstLibrary],partial[firstLibrary],"resume reuses deployed libraries");
assert.equal(Object.keys(record.contracts.libraries).length,5);assert.equal(record.deploymentBlock,(await provider.getTransactionReceipt(record.transactions.clearingProxy))!.blockNumber,"record carries the proxy deployment block for the indexer");
assert.equal(getAddress(record.contracts.clearingProxy),getAddress(report.predicted.clearingProxy!),"proxy lands at the preflight-predicted address");

const initial=await verifyDeployment(provider,record,manifest);
assert.equal(initial.state.paused,true,"v1 initializes paused");
assert.ok(initial.state.markets.every(item=>item.enabled&&item.maxTradeNotional===market.maxTradeUsdc&&item.grossLimit===market.grossUsdc&&item.sideLimit===market.sideUsdc),"initialize applies the manifest caps");

const clearing=new Contract(record.contracts.clearingProxy,artifact("RFQClearing").abi,provider);
await assert.rejects(clearing.connect(deployer).getFunction("unpause")(),"deployer has no authority over the clearing proxy");
const batches=launchBatches(record,manifest);
await runBatch(governanceSafe,batches.governanceSchedule);
await assert.rejects(runBatch(governanceSafe,batches.governanceGoLive),"go-live cannot run before the timelock delay");
await advance();
await runBatch(governanceSafe,batches.governanceGoLive);
const live=await verifyDeployment(provider,record,manifest);assert.equal(live.state.paused,false);

// Custody smoke on the launched proxy.
const usdc=new Contract(BASE_USDC,artifact("MockUSDC").abi,ceremony),amount=parseUnits("100",6);
await (await usdc.mint(ceremony.address,amount)).wait();await (await usdc.approve(record.contracts.clearingProxy,amount)).wait();
await (await clearing.connect(ceremony).getFunction("deposit")(amount)).wait();assert.equal(await usdc.balanceOf(record.contracts.clearingProxy),amount);

const submissions=basescanSubmissions(record,manifest);
assert.equal(submissions.length,8);assert.ok(submissions.every(item=>item.compilerVersion.startsWith("v0.8.34+commit.")));
assert.ok((submissions.find(item=>item.step==="clearingProxy")!.constructorArguments).length>0);

// Development profile: owner EOA governs directly, upgrades need no delay, and it hands over in place.
const dev=generateDevIdentities(await pyth.getAddress()),devManifest=validateDevManifest(dev.manifest);
const devOwner=new Wallet(dev.identities.owner.privateKey,provider);await (await ceremony.sendTransaction({to:devOwner.address,value:parseUnits("1","ether")})).wait();
assert.throws(()=>validateDevManifest({...dev.manifest,policy:{...dev.manifest.policy,markets:{...dev.manifest.policy.markets,ETH:{...dev.manifest.policy.markets.ETH,grossUsdc:"20000000000"}}}}),/dev ceiling/);
await assert.rejects(devPreflight(provider,devManifest,deployer.address),/owner key/);
const devReport=await devPreflight(provider,devManifest,devOwner.address);
let devRecord=await deployCore(devOwner,devManifest,{candidateHash:manifest.candidateHash,launchProfile:"dev",confirmations:1});
assert.equal((await verifyDev(provider,devRecord,devManifest)).state.paused,true);
await unpauseDev(devOwner,devRecord,1);
const devLive=await verifyDev(provider,devRecord,devManifest);assert.equal(devLive.state.paused,false);assert.ok(devLive.state.markets.every(item=>item.enabled&&item.grossLimit==="200000000"));
await (await usdc.mint(ceremony.address,amount)).wait();await (await usdc.approve(devRecord.contracts.clearingProxy,amount)).wait();
const devClearing=new Contract(devRecord.contracts.clearingProxy,artifact("RFQClearing").abi,ceremony);await (await devClearing.getFunction("deposit")(amount)).wait();
const collateralBefore=await devClearing.collateralOf(ceremony.address);
const previousImplementation=devRecord.contracts.clearingImplementation;
const upgradeStart=await provider.getBlockNumber();
devRecord=await upgradeDev(devOwner,devRecord,{candidateHash:manifest.candidateHash,confirmations:1});
let upgradeGas=0n;for(let block=upgradeStart+1;block<=await provider.getBlockNumber();block++){const item=await provider.getBlock(block,true);for(const hash of item!.transactions)upgradeGas+=(await provider.getTransactionReceipt(hash))!.gasUsed;}
assert.notEqual(devRecord.contracts.clearingImplementation,previousImplementation);assert.equal(devRecord.upgrades!.length,1);
await verifyDev(provider,devRecord,devManifest);
assert.equal(await usdc.balanceOf(devRecord.contracts.clearingProxy),amount,"custody survives the dev upgrade");
assert.equal(await devClearing.collateralOf(ceremony.address),collateralBefore,"account collateral survives the dev upgrade");

// Handover: a new Safe-run timelock takes governance and the ProxyAdmin of the same dev proxy.
const handoverSafe=await deploy("MockSafe",[[g1.address,g2.address,g3.address],2]),handoverTimelock=await deploy("RFQTimelock",[DELAY,await handoverSafe.getAddress()]);
const handoverTarget={timelock:await handoverTimelock.getAddress(),governanceSafe:await handoverSafe.getAddress(),emergencySafe:await emergencySafe.getAddress(),minimumDelaySeconds:DELAY,confirmations:1};
await assert.rejects(handoverDev(devOwner,devRecord,handoverTarget),/timelock admin/,"handover refuses a timelock its Safe still administers");
await runBatch(handoverSafe,renounceTimelockAdminBatch("8453",handoverTarget.timelock,handoverTarget.governanceSafe));
const handover=await handoverDev(devOwner,devRecord,handoverTarget);
assert.equal(await devClearing.governance(),devOwner.address,"owner stays governance until the timelock accepts");
assert.equal(getAddress(await devClearing.pendingGovernance()),getAddress(handoverTarget.timelock));
await runBatch(handoverSafe,handover.acceptSchedule);
await assert.rejects(runBatch(handoverSafe,handover.acceptExecute),"accept cannot run before the timelock delay");
await advance();
await runBatch(handoverSafe,handover.acceptExecute);
assert.equal(getAddress(await devClearing.governance()),getAddress(handoverTarget.timelock));
assert.equal(getAddress(await new Contract(devRecord.contracts.proxyAdmin,PROXY_ADMIN_ABI,provider).owner()),getAddress(handoverTarget.timelock));
assert.equal(getAddress(await devClearing.emergencyCouncil()),getAddress(handoverTarget.emergencySafe));
await assert.rejects(devClearing.connect(devOwner).getFunction("pause")(),"the old owner loses control after handover");
await assert.rejects(new Contract(devRecord.contracts.proxyAdmin,PROXY_ADMIN_ABI,devOwner).upgradeAndCall(devRecord.contracts.clearingProxy,previousImplementation,"0x"),"the old owner cannot upgrade after handover");
assert.equal(await devClearing.collateralOf(ceremony.address),collateralBefore,"collateral survives the handover");

// Cost summary: resumed libraries come from the preflight estimate because the resumed run did not redeploy them.
const timelockReceipt=await (await ceremony.sendTransaction(await new ContractFactory(artifact("RFQTimelock").abi,artifact("RFQTimelock").bytecode).getDeployTransaction(DELAY,manifest.governanceSafe))).wait();
const gasUsed={...Object.fromEntries(Object.keys(partial).map(step=>[step,report.gas[step]])),...record.gasUsed,timelock:timelockReceipt!.gasUsed.toString()};
const totalGas=Object.values(gasUsed).reduce((sum,value)=>sum+BigInt(value!),0n),cost=(gas:bigint,gwei:string)=>formatEther(gas*parseUnits(gwei,"gwei"));
assert.ok(BigInt(record.gasUsed.clearingProxy)<=PROXY_GAS_UPPER_BOUND,"proxy gas stays within the preflight bound");
const at=(gas:bigint)=>({"0.01 gwei":cost(gas,"0.01"),"0.05 gwei":cost(gas,"0.05"),"0.5 gwei":cost(gas,"0.5")});
console.log(JSON.stringify({rehearsal:"passed",checks:live.checks.length,devChecks:devLive.checks.length,gasUsed,totalGas:totalGas.toString(),devDeployGas:devReport.totalGas,devUpgradeGas:upgradeGas.toString(),l1FeeUpperBoundWei:report.l1FeeUpperBoundWei,
  l2ExecutionCostEthAt:at(totalGas),devUpgradeCostEthAt:at(upgradeGas)},null,2));
