// Full Base mainnet deployment rehearsal on a local OP chain that reports chain ID 8453.
// Exercises the exact preflight -> deploy (with an interrupted run and resume) -> verify ->
// Safe launch batches -> timelock delay -> go-live path, and prints measured gas.
import assert from "node:assert/strict";
import "@nomicfoundation/hardhat-ethers";
import { network } from "hardhat";
import { Contract, ContractFactory, formatEther, getAddress, parseUnits, type Signer } from "ethers";
import { artifact, basescanSubmissions, deployCore, launchBatches, preflight, renounceTimelockAdminBatch, verifyDeployment } from "./base-mainnet.js";
import { identifyCandidate } from "./candidate-identity.js";
import { validateMainnetManifest } from "./mainnet-manifest.js";

const BASE_USDC="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const {ethers,provider:rpc}=await network.create({network:"hardhatBaseRehearsal",chainType:"op"});
const signers=await ethers.getSigners(),[deployer,ceremony,g1,g2,g3,e1,e2,e3,a1,a2,a3]=signers;
const provider=ethers.provider;
assert.equal((await provider.getNetwork()).chainId,8453n);

const deploy=async(name:string,args:unknown[],from:Signer=ceremony)=>{const item=artifact(name);const contract=await new ContractFactory(item.abi,item.bytecode,from).deploy(...args);await contract.waitForDeployment();return new Contract(await contract.getAddress(),item.abi,from);};
// Stand-ins for contracts that already exist on Base mainnet.
await rpc.request({method:"hardhat_setCode",params:[BASE_USDC,artifact("MockUSDC").deployedBytecode]});
const pyth=await deploy("MockPythCore",[]);
const governanceSafe=await deploy("MockSafe",[[g1.address,g2.address,g3.address],2]),emergencySafe=await deploy("MockSafe",[[e1.address,e2.address,e3.address],2]);
const timelock=await deploy("RFQTimelock",[await governanceSafe.getAddress()]);
const runBatch=async(safe:Contract,batch:{transactions:{to:string;data:string}[]})=>{for(const tx of batch.transactions)await (await safe.exec(tx.to,tx.data)).wait();};

const market={enabled:true,maxTradeUsdc:"10000000000",grossUsdc:"100000000000",sideUsdc:"75000000000",netUsdc:"75000000000",hedgeBandUsdc:"5000000000"};
const manifest=validateMainnetManifest({version:1,mode:"capped-canary",chainId:"8453",candidateHash:identifyCandidate().candidateHash,usdc:BASE_USDC,oracleSource:await pyth.getAddress(),
  feedIds:["0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43","0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace"],
  governance:await timelock.getAddress(),governanceSafe:await governanceSafe.getAddress(),emergencyCouncil:await emergencySafe.getAddress(),approvers:[a1.address,a2.address,a3.address],
  policy:{makerCapitalUsdc:"1000000000000",insuranceCapitalUsdc:"250000000000",dailyLossLimitUsdc:"25000000000",timelockSeconds:259200,markets:{BTC:market,ETH:market}}});

await assert.rejects(preflight(provider,manifest,deployer.address),/timelock admin/,"preflight must refuse while the governance Safe still administers the timelock");
await runBatch(governanceSafe,renounceTimelockAdminBatch("8453",manifest.governance,manifest.governanceSafe));
await assert.rejects(preflight(provider,manifest,g1.address),/protocol role|own the governance Safe/,"a Safe owner cannot be the deployer");
const report=await preflight(provider,manifest,deployer.address);

// Interrupt after two steps, then resume from the partial record.
let partial:Record<string,string>={};
await assert.rejects(deployCore(deployer,manifest,{candidateHash:manifest.candidateHash,launchProfile:"dormant",confirmations:1,onStep:(step,_address,current)=>{partial=current as Record<string,string>;if(step==="signatureVerifier")throw new Error("simulated interruption");}}),/simulated interruption/);
assert.deepEqual(Object.keys(partial),["riskMath","signatureVerifier"]);
const record=await deployCore(deployer,manifest,{candidateHash:manifest.candidateHash,launchProfile:"dormant",confirmations:1,resume:partial});
assert.equal(record.contracts.riskMath,partial.riskMath,"resume reuses deployed libraries");
assert.equal(getAddress(record.contracts.clearingProxy),getAddress(report.predicted.clearingProxy!),"proxy lands at the preflight-predicted address");

const initial=await verifyDeployment(provider,record,manifest);
assert.equal(initial.state.paused,false);assert.ok(initial.state.markets.every(item=>item.enabled),"initialize enables both markets at contract maxima");

const clearing=new Contract(record.contracts.clearingProxy,artifact("RFQClearing").abi,provider);
await assert.rejects(clearing.connect(deployer).getFunction("pause")(),"deployer has no authority over the clearing proxy");
const batches=launchBatches(record,manifest);
await runBatch(emergencySafe,batches.emergencyPause);
const dormant=await verifyDeployment(provider,record,manifest);
assert.equal(dormant.state.paused,true);assert.ok(dormant.state.markets.every(item=>!item.enabled&&item.maxTradeNotional===market.maxTradeUsdc&&item.maxMarketNotional===market.netUsdc));

await runBatch(governanceSafe,batches.governanceSchedule);
await assert.rejects(runBatch(governanceSafe,batches.governanceConfigure),"configure cannot run before the timelock delay");
await rpc.request({method:"evm_increaseTime",params:[manifest.policy.timelockSeconds+1]});await rpc.request({method:"evm_mine",params:[]});
await assert.rejects(runBatch(governanceSafe,batches.governanceGoLive),"go-live cannot run before configure");
await runBatch(governanceSafe,batches.governanceConfigure);
const configured=await verifyDeployment(provider,record,manifest);
assert.equal(configured.state.paused,true);assert.ok(configured.state.markets.every(item=>item.enabled&&item.grossLimit===market.grossUsdc&&item.sideLimit===market.sideUsdc));
await runBatch(governanceSafe,batches.governanceGoLive);
const live=await verifyDeployment(provider,record,manifest);assert.equal(live.state.paused,false);

// Custody smoke on the launched proxy.
const usdc=new Contract(BASE_USDC,artifact("MockUSDC").abi,ceremony),amount=parseUnits("100",6);
await (await usdc.mint(ceremony.address,amount)).wait();await (await usdc.approve(record.contracts.clearingProxy,amount)).wait();
await (await clearing.connect(ceremony).getFunction("deposit")(amount)).wait();assert.equal(await usdc.balanceOf(record.contracts.clearingProxy),amount);

const submissions=basescanSubmissions(record,manifest);
assert.equal(submissions.length,5);assert.ok(submissions.every(item=>item.compilerVersion.startsWith("v0.8.34+commit.")));
assert.ok((submissions.find(item=>item.step==="clearingProxy")!.constructorArguments).length>0);
assert.deepEqual(Object.keys((submissions.find(item=>item.step==="clearingImplementation")!.input.settings as {libraries:object}).libraries),["contracts/libraries/RFQRiskMath.sol","contracts/libraries/RFQSignatureVerifier.sol"]);
// Cost summary: libraries come from the preflight estimate because the resumed run did not redeploy them.
const timelockReceipt=await (await ceremony.sendTransaction(await new ContractFactory(artifact("RFQTimelock").abi,artifact("RFQTimelock").bytecode).getDeployTransaction(manifest.governanceSafe))).wait();
const gasUsed={riskMath:report.gas.riskMath,signatureVerifier:report.gas.signatureVerifier,...record.gasUsed,timelock:timelockReceipt!.gasUsed.toString()};
const totalGas=Object.values(gasUsed).reduce((sum,value)=>sum+BigInt(value!),0n),cost=(gwei:string)=>formatEther(totalGas*parseUnits(gwei,"gwei"));
assert.ok(BigInt(record.gasUsed.clearingProxy)<=1_200_000n,"proxy gas stays within the preflight bound");
console.log(JSON.stringify({rehearsal:"passed",checks:live.checks.length,gasUsed,totalGas:totalGas.toString(),l1FeeUpperBoundWei:report.l1FeeUpperBoundWei,
  l2ExecutionCostEthAt:{"0.01 gwei":cost("0.01"),"0.05 gwei":cost("0.05"),"0.5 gwei":cost("0.5")}},null,2));
