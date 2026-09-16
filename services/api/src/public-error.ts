/** Never expose provider URLs, transport credentials or signed request bodies. */
export function publicError(error:unknown,fallback:string):string{
 const safeMessages=new Set(['market is paused','exposure migration required','firm quote capacity reached','order capacity reached','oracle report lacks inclusion time','hedging unavailable: only exposure-reducing trades are allowed','minimum deposit is 10 USDC']);
 if(error instanceof Error&&safeMessages.has(error.message))return error.message;
 const names:Record<string,string>={Margin:'Insufficient margin',Stale:'Oracle or authorization expired',Replay:'Nonce already used',InvalidTrade:'Trade violates settlement policy',InvalidSignature:'Invalid signature',Unauthorized:'Unauthorized action',Insolvent:'Settlement requires resolution',OracleInvalid:'Oracle proof rejected'};
 const value=error as {revert?:{name?:string};data?:unknown}|null;
 if(value?.revert?.name&&Object.hasOwn(names,value.revert.name))return names[value.revert.name];
 const selectors:Record<string,string>={'0x50cb02e4':'Margin','0xd7815800':'Stale','0xb5a78004':'Replay','0xd69b5379':'InvalidTrade','0x8baa579f':'InvalidSignature','0x82b42900':'Unauthorized'};
 if(typeof value?.data==='string'){const name=selectors[value.data.slice(0,10).toLowerCase()];if(name)return names[name];}
 return fallback;
}
