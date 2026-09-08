export interface LinkableArtifact { bytecode:string; linkReferences?:Record<string,Record<string,Array<{start:number;length:number}>>>; [key:string]:unknown }
export function linkArtifact<T extends LinkableArtifact>(artifact:T,addresses:Record<string,string>):T;
