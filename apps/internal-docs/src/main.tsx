import React,{useMemo,useState}from"react";
import{createRoot}from"react-dom/client";
import"@fontsource-variable/ibm-plex-sans/wght.css";
import"@fontsource/ibm-plex-mono/500.css";
import{documents,resolveDocument}from"./documents.js";
import{Markdown}from"./Markdown.js";
import"./styles.css";

const categories=[...new Set(documents.map(document=>document.category))];
function App(){const[selected,setSelected]=useState(documents[0].id),[query,setQuery]=useState("");const normalized=query.trim().toLowerCase();const visible=useMemo(()=>documents.filter(document=>!normalized||`${document.title} ${document.summary} ${document.body}`.toLowerCase().includes(normalized)),[normalized]);const document=documents.find(item=>item.id===selected&&visible.includes(item))??visible[0]??documents[0];
 const navigate=(href:string)=>{const id=resolveDocument(document.id,href);return id?()=>{setQuery("");setSelected(id);window.scrollTo(0,0);}:undefined;};
 return <div className="manual"><aside><div className="brand"><i>R</i><div><b>RFQ Markets</b><span>Internal manual</span></div></div><input aria-label="Search manual" placeholder="Search all documentation" value={query} onChange={event=>setQuery(event.target.value)}/><nav>{categories.map(category=>{const items=visible.filter(item=>item.category===category);return items.length?<section key={category}><h2>{category}</h2>{items.map(item=><button key={item.id} className={item.id===document.id?"active":""} onClick={()=>setSelected(item.id)}><b>{item.title}</b><span>{item.summary}</span></button>)}</section>:null})}</nav><footer>{visible.length} of {documents.length} manuals</footer></aside><main><header><div><span>INTERNAL · RESTRICTED · NO SECRETS</span><b>Base mainnet dev</b></div><p>This bundle contains architecture and operating details. Publish only behind Cloudflare Access.</p></header><article><div className="document-meta"><span>{document.category}</span><span>Source-controlled manual</span></div><Markdown source={document.body} onNavigate={navigate}/></article></main></div>}
createRoot(document.getElementById("root")!).render(<App/>);
