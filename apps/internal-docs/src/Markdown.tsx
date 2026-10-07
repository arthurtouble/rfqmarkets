import React from"react";

// Returns a click handler when the link points at another manual page.
export type Navigator=(href:string)=>(()=>void)|undefined;

const inline=(text:string,onNavigate?:Navigator)=>text.split(/(`[^`]+`|\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*)/g).filter(Boolean).map((part,index)=>{
  if(part.startsWith("`"))return <code key={index}>{part.slice(1,-1)}</code>;
  if(part.startsWith("**"))return <strong key={index}>{part.slice(2,-2)}</strong>;
  const link=part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);if(!link)return part;const go=onNavigate?.(link[2]);return go?<button className="doc-link" key={index} onClick={go}>{link[1]}</button>:<a key={index} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;
});

export function Markdown({source,onNavigate}:{source:string;onNavigate?:Navigator}){const lines=source.split("\n"),blocks:React.ReactNode[]=[];let index=0;
  while(index<lines.length){const line=lines[index];if(!line.trim()){index++;continue;}
    if(line.startsWith("```")){const language=line.slice(3),body=[];index++;while(index<lines.length&&!lines[index].startsWith("```"))body.push(lines[index++]);index++;blocks.push(<pre key={blocks.length} data-language={language}><code>{body.join("\n")}</code></pre>);continue;}
    const heading=line.match(/^(#{1,4})\s+(.+)$/);if(heading){const level=heading[1].length,title=heading[2],id=title.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/(^-|-$)/g,"");blocks.push(React.createElement(`h${level}`,{key:blocks.length,id},inline(title,onNavigate)));index++;continue;}
    if(/^[-*] /.test(line)){const items=[];while(index<lines.length&&/^[-*] /.test(lines[index]))items.push(<li key={index}>{inline(lines[index++].slice(2),onNavigate)}</li>);blocks.push(<ul key={blocks.length}>{items}</ul>);continue;}
    if(/^\d+\. /.test(line)){const items=[];while(index<lines.length&&/^\d+\. /.test(lines[index]))items.push(<li key={index}>{inline(lines[index++].replace(/^\d+\. /,""),onNavigate)}</li>);blocks.push(<ol key={blocks.length}>{items}</ol>);continue;}
    if(line.startsWith("|")){const rows=[];while(index<lines.length&&lines[index].startsWith("|"))rows.push(lines[index++]);const cells=rows.filter(row=>!/^\|?[\s|:-]+\|?$/.test(row)).map(row=>row.split("|").slice(1,-1).map(cell=>cell.trim()));if(cells.length)blocks.push(<div className="table-scroll" key={blocks.length}><table><tbody>{cells.map((row,rowIndex)=><tr key={rowIndex}>{row.map((cell,cellIndex)=>React.createElement(rowIndex===0?"th":"td",{key:cellIndex},inline(cell,onNavigate)))}</tr>)}</tbody></table></div>);continue;}
    if(line.startsWith("> ")){blocks.push(<blockquote key={blocks.length}>{inline(line.slice(2),onNavigate)}</blockquote>);index++;continue;}
    if(/^---+$/.test(line)){blocks.push(<hr key={blocks.length}/>);index++;continue;}
    const paragraph=[line];index++;while(index<lines.length&&lines[index].trim()&&!/^(#{1,4})\s|^```|^[-*] |^\d+\. |^\||^> |^---+$/.test(lines[index]))paragraph.push(lines[index++]);blocks.push(<p key={blocks.length}>{inline(paragraph.join(" "),onNavigate)}</p>);
  }return <>{blocks}</>;
}
