import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Contract, ContractFactory, Interface, JsonRpcProvider, MaxUint256, NonceManager, Wallet, parseEther } from "ethers";
import { deployLinked, launchMarkets } from "./lib/contract-fixture.mjs";

// The local venue runs both markets at 0.25x the base margin tiers: 5% initial / 3% maintenance in
// the first tier, so up to 20x leverage. Live manifests keep their own (LAUNCH_RISK) values.
const LOCAL_MARGIN_SCALE_BPS=2_500;
const rpcUrl=process.env.RFQ_RPC_URL??"http://127.0.0.1:8545";
const provider=new JsonRpcProvider(rpcUrl);const owner=await provider.getSigner(0);const ownerAddress=await owner.getAddress();const emergencyAddress=await provider.getSigner(1).then(signer=>signer.getAddress());const deployer=new NonceManager(owner);
const sponsorWallet=process.env.RFQ_LOCAL_SPONSOR_KEY?new Wallet(process.env.RFQ_LOCAL_SPONSOR_KEY):Wallet.createRandom();
const devWallet=Wallet.createRandom().connect(provider);
const devSigner=new NonceManager(devWallet);
const artifact=(name:string)=>JSON.parse(readFileSync(resolve("artifacts",`${name}.json`),"utf8"));
const libraryAddresses:Record<string,string>={};
const deploy=(name:string,args:unknown[]=[])=>deployLinked(deployer,name,args,libraryAddresses);

const chain=await provider.getNetwork(); if(chain.chainId!==31_337n)throw new Error(`unexpected local chain ${chain.chainId}`);
const approvers=[Wallet.createRandom(),Wallet.createRandom(),Wallet.createRandom()];
const token=await deploy("MockUSDC") as unknown as Contract; const oracle=await deploy("MockPriceOracle"); const riskMath=await deploy("RFQRiskMath");libraryAddresses.RFQRiskMath=await riskMath.getAddress();const signatureVerifier=await deploy("RFQSignatureVerifier");libraryAddresses.RFQSignatureVerifier=await signatureVerifier.getAddress();const implementation=await deploy("RFQClearing");
const clearingInterface=new Interface(artifact("RFQClearing").abi);
const init=clearingInterface.encodeFunctionData("initialize",[await token.getAddress(),await oracle.getAddress(),ownerAddress,emergencyAddress,approvers.map(item=>item.address),1_000_000_000_000n,launchMarkets({marginScaleBps:LOCAL_MARGIN_SCALE_BPS})]);
const proxy=await deploy("TestProxy",[await implementation.getAddress(),ownerAddress,init]); const clearing=new Contract(await proxy.getAddress(),artifact("RFQClearing").abi,deployer); await (await clearing.unpause()).wait();
const adminWord=await provider.getStorage(await proxy.getAddress(),"0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"),proxyAdminAddress=`0x${adminWord.slice(-40)}`;
await (await token.mint(ownerAddress,12_000_000_000_000n)).wait(); await (await token.approve(await clearing.getAddress(),MaxUint256)).wait();
await (await clearing.fundMaker(10_000_000_000_000n)).wait(); await (await clearing.fundInsurance(2_000_000_000_000n)).wait();
await (await deployer.sendTransaction({to:sponsorWallet.address,value:parseEther("5")})).wait();
await (await deployer.sendTransaction({to:devWallet.address,value:parseEther("2")})).wait();
// The local risk operator: lists and tunes markets from the operations console, with no timelock. Its envelope is
// the contract's own limits, so locally it can do anything governance can to a market; live deployments set tighter bounds.
const riskOperator=Wallet.createRandom();
await (await deployer.sendTransaction({to:riskOperator.address,value:parseEther("1")})).wait();
await (await clearing.setRiskOperator(riskOperator.address)).wait();
await (await clearing.setRiskOperatorBounds({maxTradeNotional:1_000_000_000_000n,maxMarketNotional:5_000_000_000_000n,maxGrossLimit:5_000_000_000_000n,minImpactK:1,minShockBps:500,minMarginScaleBps:2_500})).wait();
// The dev wallet keeps 50,000 USDC and no standing allowance, so the app's approve-then-deposit flow runs locally.
await (await token.mint(devWallet.address,5_050_000_000_000n)).wait();
await (await (token.connect(devSigner) as any).approve(await clearing.getAddress(),5_000_000_000_000n)).wait();
await (await (clearing.connect(devSigner) as any).deposit(5_000_000_000_000n)).wait();
const deployment={deploymentId:crypto.randomUUID(),rpcUrl,chainId:chain.chainId.toString(),clearingAddress:await clearing.getAddress(),proxyAdminAddress,tokenAddress:await token.getAddress(),oracleAddress:await oracle.getAddress(),riskMathAddress:await riskMath.getAddress(),signatureVerifierAddress:await signatureVerifier.getAddress(),implementationAddress:await implementation.getAddress(),deploymentBlock:await provider.getBlockNumber(),governanceAddress:ownerAddress,emergencyAddress,approvers:approvers.map(item=>({address:item.address,privateKey:item.privateKey})),sponsorPrivateKey:sponsorWallet.privateKey,devWallet:{account:devWallet.address,privateKey:devWallet.privateKey},riskOperator:{account:riskOperator.address,privateKey:riskOperator.privateKey},deployedAt:new Date().toISOString()};
mkdirSync(resolve(".local-state"),{recursive:true}); const path=resolve(".local-state","deployment.json"); writeFileSync(path,JSON.stringify(deployment,null,2),{mode:0o600}); chmodSync(path,0o600);
console.log(JSON.stringify({chainId:deployment.chainId,clearingAddress:deployment.clearingAddress,proxyAdminAddress:deployment.proxyAdminAddress,tokenAddress:deployment.tokenAddress,oracleAddress:deployment.oracleAddress,devWallet:deployment.devWallet.account,riskOperator:deployment.riskOperator.account,devCollateral:"5000000 USDC",devWalletUsdc:"50000 USDC",makerBacking:"10000000 USDC",insurance:"2000000 USDC",approvers:deployment.approvers.map(item=>item.address)},null,2));
