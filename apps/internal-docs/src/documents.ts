// Every Markdown file under docs/ becomes a manual page; the folder is its category.
const sources=import.meta.glob<string>("../../../docs/**/*.md",{query:"?raw",import:"default",eager:true});

export type ManualDocument={id:string;title:string;category:string;summary:string;body:string};

const categoryOrder=["Start here","Architecture","Product","Operations","Release","Takeover","History"];
const categoryOf=(id:string)=>{const folder=id.includes("/")?id.split("/")[0]:"";return folder?folder[0].toUpperCase()+folder.slice(1):"Start here";};
const titleOf=(id:string,body:string)=>{const title=body.match(/^#\s+(.+)$/m)?.[1].replace(/^RFQ Markets\s+—\s+/,"").trim()??id;return title[0].toUpperCase()+title.slice(1);};
// First sentence of the first prose paragraph, skipping date and status stamps.
const stamp=/^(?:[\w ]*(?:date|status|revision)[\w ]*:\s*)?[\w ,]*\d{4}-\d{2}-\d{2}\.?$/i;
const summaryOf=(body:string)=>{const paragraph=body.split(/\n\s*\n/).map(block=>block.trim()).find(block=>block&&!/^[#|`>-]|^\d+\./.test(block))??"";const sentences=paragraph.replace(/\[([^\]]+)\]\([^)]*\)/g,"$1").replace(/[*_`]/g,"").split(/(?<=\.)\s+/);const sentence=sentences.find(item=>!stamp.test(item.trim()))??"";return sentence.length>140?`${sentence.slice(0,137)}…`:sentence;};
const rank=(document:ManualDocument)=>{const index=categoryOrder.indexOf(document.category);return index<0?categoryOrder.length:index;};

export const documents:ManualDocument[]=Object.entries(sources).map(([path,body])=>{const id=path.replace("../../../docs/","").replace(/\.md$/,"");const category=categoryOf(id);return{id,title:titleOf(id,body),category,summary:summaryOf(body),body};}).sort((a,b)=>rank(a)-rank(b)||(a.category==="History"?a.id.localeCompare(b.id):a.title.localeCompare(b.title)));

// Resolves a relative Markdown link from one manual page to another page id.
export function resolveDocument(fromId:string,href:string){const target=href.split("#")[0];if(!target.endsWith(".md"))return undefined;const parts=fromId.split("/").slice(0,-1);for(const part of target.split("/")){if(part==="..")parts.pop();else if(part&&part!==".")parts.push(part);}const id=parts.join("/").replace(/\.md$/,"");return documents.find(document=>document.id===id)?.id;}
