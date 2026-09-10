export interface FanoutClient {
  write(chunk:string):boolean;
  bufferedBytes():number;
  close():void;
}

export class MarketFanout {
  private clients=new Set<FanoutClient>();private latest?:string;private sequence=0;private sent=0;private dropped=0;
  constructor(private maxBufferedBytes=256*1024){}
  private write(client:FanoutClient,frame:string){if(client.bufferedBytes()>this.maxBufferedBytes){this.clients.delete(client);this.dropped++;client.close();return false;}client.write(frame);return true;}
  add(client:FanoutClient){this.clients.add(client);if(this.latest)this.write(client,this.latest);return()=>this.clients.delete(client);}
  publish(data:string){const frame=`id: ${++this.sequence}\nevent: markets\ndata: ${data}\n\n`;this.latest=frame;for(const client of this.clients)if(this.write(client,frame))this.sent++;}
  heartbeat(){for(const client of this.clients)this.write(client,": heartbeat\n\n");}
  close(){for(const client of this.clients)client.close();this.clients.clear();}
  status(){return {connections:this.clients.size,sequence:this.sequence,eventsSent:this.sent,droppedSlowClients:this.dropped,hasSnapshot:Boolean(this.latest)};}
}

export async function consumeMarketEvents(response:Response,onData:(data:string)=>void){
  if(!response.ok||!response.body)throw new Error(`upstream market stream returned ${response.status}`);
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer="";
  while(true){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true}).replaceAll("\r\n","\n");let boundary;
    while((boundary=buffer.indexOf("\n\n"))>=0){const block=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);let event="message";const data:string[]=[];for(const line of block.split("\n")){if(line.startsWith("event:"))event=line.slice(6).trim();else if(line.startsWith("data:"))data.push(line.slice(5).trimStart());}if(event==="markets"&&data.length)onData(data.join("\n"));}
  }
}
