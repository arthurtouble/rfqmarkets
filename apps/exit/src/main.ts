import {BrowserProvider,Contract,getAddress,parseUnits} from 'ethers';
import {flipTheme,initializeTheme} from '../../../packages/design-system/theme.js';
const env=import.meta.env,chainId=BigInt(env.VITE_EXIT_CHAIN_ID??0),address=env.VITE_EXIT_CLEARING_ADDRESS;
const node=(id:string)=>document.getElementById(id)!,value=(id:string)=>(node(id) as HTMLInputElement).value;
const status=(text:string)=>{node('status').textContent=text;};
const abi=['function usdc() view returns(address)','function oracle() view returns(address)','function collateralOf(address) view returns(int256)','function positionOf(address,uint8) view returns(int256 size,uint256 entryPrice,int256 lastFundingIndex)','function paused() view returns(bool)','function resolutionRequired() view returns(bool)','function resolutionFinalized() view returns(bool)','function resolutionClaim(address) view returns(uint256)','function withdraw(uint256)','function cancelNonce(uint256)','function revokeSession(address)','function closePosition(uint8,bytes) payable','function claimResolution()'];
let contract:Contract|undefined,provider:BrowserProvider|undefined,account:string|undefined;
let theme=initializeTheme();
const themeControl=document.createElement('button');themeControl.className='theme-toggle';themeControl.setAttribute('aria-label',`Use ${theme==='dark'?'light':'dark'} theme`);themeControl.textContent=theme==='dark'?'☀':'☾';document.querySelector('main')!.prepend(themeControl);themeControl.addEventListener('click',()=>{theme=flipTheme(theme);themeControl.textContent=theme==='dark'?'☀':'☾';themeControl.setAttribute('aria-label',`Use ${theme==='dark'?'light':'dark'} theme`);});
async function connect(){
 if(!address||chainId<=0n)throw new Error('This build has no reviewed settlement configuration');
 const ethereum=(window as unknown as {ethereum?:ConstructorParameters<typeof BrowserProvider>[0]}).ethereum;if(!ethereum)throw new Error('Browser wallet unavailable');
 provider=new BrowserProvider(ethereum);await provider.send('eth_requestAccounts',[]);if((await provider.getNetwork()).chainId!==chainId)throw new Error(`Select chain ${chainId} in your wallet`);
 if(await provider.getCode(getAddress(address))==='0x')throw new Error('Settlement address has no contract');
 const signer=await provider.getSigner();account=await signer.getAddress();contract=new Contract(getAddress(address),abi,signer);await read();
}
async function read(){const [collateral,btc,eth,paused,resolution,finalized,claim,token]=await Promise.all([contract!.collateralOf(account),contract!.positionOf(account,0),contract!.positionOf(account,1),contract!.paused(),contract!.resolutionRequired(),contract!.resolutionFinalized(),contract!.resolutionClaim(account),contract!.usdc()]);node('state').textContent=JSON.stringify({account,token,collateral,btc:[...btc],eth:[...eth],paused,resolution,finalized,claim},(_,v)=>typeof v==='bigint'?v.toString():v,2);}
async function act(action:()=>Promise<{wait:()=>Promise<{status:number;blockNumber:number}|null>}>){await connect();status('Confirm transaction in your wallet');const tx=await action(),receipt=await tx.wait();if(receipt?.status!==1)throw new Error('Transaction not confirmed');status(await contract!.resolutionRequired()?`Resolution active. Transaction confirmed in block ${receipt.blockNumber}; inspect account and claim state.`:`Confirmed in block ${receipt.blockNumber}`);await read();}
const bind=(id:string,fn:()=>Promise<unknown>)=>node(id).addEventListener('click',()=>void fn().catch(error=>status(error.message)));
node('deployment').textContent=address?`Chain ${chainId} · settlement ${address}`:'Deployment configuration missing. Actions disabled.';
bind('connect',connect);
bind('withdraw',()=>act(()=>contract!.withdraw(parseUnits(value('amount'),6))));
bind('cancel',()=>act(()=>contract!.cancelNonce(BigInt(value('nonce')))));
bind('revoke',()=>act(()=>contract!.revokeSession(getAddress(value('session')))));
bind('claim',()=>act(()=>contract!.claimResolution()));
bind('close',()=>act(async()=>{const proof=value('proof').trim();if(!/^0x(?:[0-9a-fA-F]{2})+$/.test(proof))throw new Error('A fresh hex oracle proof is required');const oracle=new Contract(await contract!.oracle(),['function updateFee(bytes) view returns(uint256)'],provider);const fee=BigInt(await oracle.updateFee(proof));return contract!.closePosition(Number(value('market')),proof,{value:fee});}));
