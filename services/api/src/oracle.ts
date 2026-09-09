import { createClient, type DataStreamsClient, type Report } from "@chainlink/data-streams-sdk";
import { decodeStreamsV3Envelope } from "../../../packages/shared/src/streams.js";
import type { PriceSnapshot } from "../../../packages/shared/src/policy.js";

export type OracleMarket="BTC"|"ETH";
export interface OracleQuote {snapshot:PriceSnapshot;report:string;validUntil:number}
export interface OracleSource {latest(market:OracleMarket):Promise<OracleQuote>;start?():Promise<void>;close?():Promise<void>}
interface ReportStream {on(event:"report",listener:(report:Report)=>void):this;connect():Promise<void>;close():Promise<void>}
interface LatestReportClient {getLatestReport(feedId:string):Promise<Report>;createStream?(feedIds:string[]):ReportStream}
export interface ChainlinkSourceOptions {apiKey:string;userSecret:string;endpoint:string;wsEndpoint:string;feedIds:Record<OracleMarket,string>;feedDecimals:Record<OracleMarket,number>;timeoutMs?:number;client?:LatestReportClient}

export class ChainlinkDataStreamsSource implements OracleSource{
  private client:LatestReportClient;
  private inFlight:Partial<Record<OracleMarket,Promise<OracleQuote>>>={};
  private cached:Partial<Record<OracleMarket,OracleQuote>>={};
  private stream?:ReportStream;
  constructor(private options:ChainlinkSourceOptions){
    if(!options.endpoint.startsWith("https://")||!options.wsEndpoint.startsWith("wss://"))throw new Error("Data Streams endpoints must use TLS");
    if(!options.apiKey||!options.userSecret)throw new Error("Data Streams credentials are required");
    this.client=options.client??createClient({apiKey:options.apiKey,userSecret:options.userSecret,endpoint:options.endpoint,wsEndpoint:options.wsEndpoint,timeout:options.timeoutMs??2_000,retryAttempts:1}) as DataStreamsClient;
  }
  private normalize(market:OracleMarket,report:Report){const feedId=this.options.feedIds[market],decoded=decodeStreamsV3Envelope(report.fullReport,feedId,this.options.feedDecimals[market]);if(report.feedID.toLowerCase()!==feedId.toLowerCase()||report.observationsTimestamp!==decoded.observedAt)throw new Error("Data Streams metadata mismatch");return {snapshot:{market,bid:decoded.bid,ask:decoded.ask,observedAtMs:decoded.observedAt*1_000},report:report.fullReport,validUntil:decoded.validUntil};}
  async start(){if(this.stream||!this.client.createStream)return;this.stream=this.client.createStream(Object.values(this.options.feedIds));const byFeed=new Map(Object.entries(this.options.feedIds).map(([market,feed])=>[feed.toLowerCase(),market as OracleMarket]));this.stream.on("report",report=>{const market=byFeed.get(report.feedID.toLowerCase());if(!market)return;try{this.cached[market]=this.normalize(market,report);}catch{}});await this.stream.connect();}
  async close(){const stream=this.stream;this.stream=undefined;if(stream)await stream.close();}
  async latest(market:OracleMarket){
    const cached=this.cached[market];if(cached&&Date.now()-cached.snapshot.observedAtMs<=1_500&&cached.validUntil*1_000>Date.now())return cached;
    const active=this.inFlight[market];if(active)return active;
    const request=(async()=>{const quote=this.normalize(market,await this.client.getLatestReport(this.options.feedIds[market]));this.cached[market]=quote;return quote;})().finally(()=>{delete this.inFlight[market]});
    this.inFlight[market]=request;return request;
  }
}
