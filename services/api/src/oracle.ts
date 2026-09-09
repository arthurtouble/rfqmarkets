import { createClient, type DataStreamsClient, type Report } from "@chainlink/data-streams-sdk";
import { decodeStreamsV3Envelope } from "../../../packages/shared/src/streams.js";
import type { PriceSnapshot } from "../../../packages/shared/src/policy.js";

export type OracleMarket="BTC"|"ETH";
export interface OracleQuote {snapshot:PriceSnapshot;report:string;validUntil:number}
export interface OracleSource {latest(market:OracleMarket):Promise<OracleQuote>}
interface LatestReportClient {getLatestReport(feedId:string):Promise<Report>}
export interface ChainlinkSourceOptions {apiKey:string;userSecret:string;endpoint:string;wsEndpoint:string;feedIds:Record<OracleMarket,string>;feedDecimals:Record<OracleMarket,number>;timeoutMs?:number;client?:LatestReportClient}

export class ChainlinkDataStreamsSource implements OracleSource{
  private client:LatestReportClient;
  constructor(private options:ChainlinkSourceOptions){
    if(!options.endpoint.startsWith("https://")||!options.wsEndpoint.startsWith("wss://"))throw new Error("Data Streams endpoints must use TLS");
    if(!options.apiKey||!options.userSecret)throw new Error("Data Streams credentials are required");
    this.client=options.client??createClient({apiKey:options.apiKey,userSecret:options.userSecret,endpoint:options.endpoint,wsEndpoint:options.wsEndpoint,timeout:options.timeoutMs??2_000,retryAttempts:1}) as DataStreamsClient;
  }
  async latest(market:OracleMarket){
    const feedId=this.options.feedIds[market],report=await this.client.getLatestReport(feedId),decoded=decodeStreamsV3Envelope(report.fullReport,feedId,this.options.feedDecimals[market]);
    if(report.feedID.toLowerCase()!==feedId.toLowerCase()||report.observationsTimestamp!==decoded.observedAt)throw new Error("Data Streams metadata mismatch");
    return {snapshot:{market,bid:decoded.bid,ask:decoded.ask,observedAtMs:decoded.observedAt*1_000},report:report.fullReport,validUntil:decoded.validUntil};
  }
}
