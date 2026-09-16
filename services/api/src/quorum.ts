/** Collect the first distinct quorum; all started promises retain rejection handlers. */
export function firstQuorum<T>(jobs:Promise<T>[],identity:(value:T)=>string,required=2):Promise<PromiseSettledResult<T>[]>{
 return new Promise(resolve=>{
  const results:PromiseSettledResult<T>[]=[],identities=new Set<string>();let remaining=jobs.length,finished=false;
  const complete=()=>{if(!finished&&(identities.size>=required||remaining===0)){finished=true;resolve([...results]);}};
  if(!jobs.length){resolve([]);return;}
  jobs.forEach(job=>job.then(value=>{results.push({status:'fulfilled',value});identities.add(identity(value));},reason=>{results.push({status:'rejected',reason});}).then(()=>{remaining--;complete();}));
 });
}
