import { Wallet } from "ethers";

// Hot keys for the dev runtime (emergency council, three approvers, gas sponsor). They are generated
// inside the Durable Object on first start, kept only in its storage, and never leave Cloudflare; only
// the public addresses are published (KV `identities.json`) for the contracts workflow to deploy with.
const make=()=>{const wallet=Wallet.createRandom();return {address:wallet.address,privateKey:wallet.privateKey};};

export async function ensureIdentities(storage){
  let identities=await storage.get("identities");
  if(!identities){identities={emergency:make(),approvers:[make(),make(),make()],sponsor:make(),createdAt:new Date().toISOString()};await storage.put("identities",identities);}
  return identities;
}

export const publicIdentities=identities=>({emergency:identities.emergency.address,approvers:identities.approvers.map(item=>item.address),sponsor:identities.sponsor.address});

/** The runtime only signs for a deployment whose approver set is exactly its own keys. */
export function matchesDeployment(identities,deployment){
  const ours=identities.approvers.map(item=>item.address.toLowerCase()).sort(),theirs=(deployment.approvers??[]).map(item=>item.toLowerCase()).sort();
  return ours.length===theirs.length&&ours.every((address,index)=>address===theirs[index]);
}
