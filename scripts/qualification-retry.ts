export class QualificationResponseError extends Error {
  constructor(readonly path:string,readonly status:number,readonly body:{error?:string}) {
    super(`${path}: ${JSON.stringify(body)}`);
  }
}

// These approval rejections occur before admission or chain submission. Never
// retry an ambiguous submission, timeout, or generic policy rejection here.
export function btcRetryDelay(error:unknown):number|null {
  if(!(error instanceof QualificationResponseError)||error.path!=="/v1/approve")return null;
  if(error.status===409&&error.body.error==="price moved beyond signed protection")return 250;
  if(error.status===503&&error.body.error==="fresh settlement price unavailable")return 5_000;
  return null;
}

export function transientReadError(error:unknown):boolean {
  if(!error||typeof error!=="object")return false;
  const value=error as {code?:string;cause?:unknown;error?:unknown};
  return ["ENOTFOUND","EAI_AGAIN","ECONNRESET","ETIMEDOUT","TIMEOUT","NETWORK_ERROR"].includes(value.code??"")||transientReadError(value.cause)||transientReadError(value.error);
}

export async function retryQualification<T>(run:()=>Promise<T>,delay:(error:unknown)=>number|null,options:{attempts?:number;sleep?:(ms:number)=>Promise<void>}={}):Promise<T> {
  const attempts=options.attempts??12,sleep=options.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  for(let attempt=1;;attempt++)try{return await run();}catch(error){
    const ms=delay(error);if(ms===null||attempt>=attempts)throw error;
    await sleep(ms);
  }
}
