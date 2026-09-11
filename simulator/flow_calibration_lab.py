"""Build causal RFQ calibration observations from normalized public trade tape."""
from __future__ import annotations
import argparse,bisect,csv,hashlib,html,json,math,os,random
from collections import defaultdict,deque
from dataclasses import dataclass
from walk_forward_calibration import Observation,calibrate

@dataclass(frozen=True)
class Trade:
    timestamp_ms:int;venue:str;market:str;trade_id:str;price:float;size_base:float;taker_side:str;bid:float|None=None;ask:float|None=None

def load_tape(path:str)->list[Trade]:
    rows=[];seen=set()
    with open(path,newline="") as handle:
        for row in csv.DictReader(handle):
            key=(row.get("venue"),row.get("market"),row.get("trade_id"))
            if key in seen:continue
            seen.add(key)
            try:item=Trade(int(row["timestamp_ms"]),row["venue"],row["market"],row["trade_id"],float(row["price"]),float(row["size_base"]),row["taker_side"],float(row["bid"]) if row.get("bid") else None,float(row["ask"]) if row.get("ask") else None)
            except (KeyError,ValueError):continue
            if item.market in ("BTC","ETH") and item.venue and item.price>0 and item.size_base>0 and item.taker_side in ("buy","sell") and (item.bid is None or item.ask is None or item.bid<=item.ask):rows.append(item)
    rows.sort(key=lambda item:(item.timestamp_ms,item.venue,item.trade_id))
    if len(rows)<50:raise ValueError("flow lab requires at least 50 valid normalized trades")
    return rows

def bucket_tape(rows:list[Trade],bucket_ms=250)->list[Trade]:
    buckets={}
    for row in rows:
        key=(row.timestamp_ms//bucket_ms,row.venue,row.market,row.taker_side);current=buckets.get(key)
        if current:
            size=current.size_base+row.size_base;price=(current.price*current.size_base+row.price*row.size_base)/size
            buckets[key]=Trade(max(current.timestamp_ms,row.timestamp_ms),row.venue,row.market,row.trade_id,price,size,row.taker_side,row.bid or current.bid,row.ask or current.ask)
        else:buckets[key]=row
    return sorted(buckets.values(),key=lambda item:(item.timestamp_ms,item.venue,item.trade_id))

def future_prices(rows:list[Trade]):
    values={};grouped=defaultdict(list)
    for row in rows:grouped[(row.market,row.timestamp_ms//250)].append(row.price)
    for market in ("BTC","ETH"):
        selected=[]
        for (name,bucket),prices in grouped.items():
            if name!=market:continue
            ordered=sorted(prices);middle=len(ordered)//2;median=ordered[middle] if len(ordered)%2 else (ordered[middle-1]+ordered[middle])/2;selected.append((bucket*250,median))
        selected.sort();values[market]=([item[0] for item in selected],[item[1] for item in selected])
    return values

def build_observations(rows:list[Trade],horizons_ms:tuple[int,...],mixtures:tuple[float,...],seed=7):
    rows=bucket_tape(rows);futures=future_prices(rows);latest=defaultdict(dict);recent={market:deque() for market in ("BTC","ETH")};volatility={market:(None,None,0.) for market in ("BTC","ETH")};rng=random.Random(seed);observations=[]
    for row in rows:
        times,prices=futures[row.market];future=[]
        for horizon in horizons_ms:
            index=bisect.bisect_left(times,row.timestamp_ms+horizon)
            if index>=len(times) or times[index]>row.timestamp_ms+horizon+max(1_000,horizon//2):future=[];break
            future.append(prices[index])
        if not future:continue
        latest[row.market][row.venue]=(row.timestamp_ms,row.price);healthy=sorted(price for timestamp,price in latest[row.market].values() if timestamp>=row.timestamp_ms-2_000);middle=len(healthy)//2;reference=healthy[middle] if len(healthy)%2 else (healthy[middle-1]+healthy[middle])/2
        previous,previous_ms,variance=volatility[row.market]
        if previous and previous_ms is not None:
            elapsed=max(.05,min(60.,(row.timestamp_ms-previous_ms)/1_000));move=math.log(reference/previous)*10_000;instant=move*move/elapsed;alpha=1-math.exp(-elapsed/60);variance=variance*(1-alpha)+instant*alpha
        volatility[row.market]=(reference,row.timestamp_ms,variance);sigma=math.sqrt(max(0,variance))
        flow=recent[row.market]
        while flow and flow[0][0]<row.timestamp_ms-30_000:flow.popleft()
        signed=sum(value for _,value in flow);gross=sum(abs(value) for _,value in flow);imbalance=abs(signed)/gross*10_000 if gross else 0
        recent_volume=sum(abs(value) for time,value in flow if time>=row.timestamp_ms-1_000)
        basis=(row.price/reference-1)*10_000 if reference else 0
        half_spread=max(0,(row.ask-row.bid)/((row.ask+row.bid)/2)*5_000) if row.bid and row.ask else 0
        for mixture in mixtures:
            toxic=random.Random(f"{seed}:{row.timestamp_ms}:{row.venue}:{row.trade_id}:{mixture}").random()<mixture;side=row.taker_side if toxic else ("buy" if rng.random()<.5 else "sell");notional=rng.choice((100.,1_000.,10_000.,50_000.,250_000.));direction=1 if side=="buy" else -1
            markouts=[max(0,direction*(price/reference-1)*10_000) for price in future];adverse=max(markouts);pressure=min(20,notional/max(notional,recent_volume)*5);hedge_cost=half_spread+pressure
            observations.append(Observation(row.timestamp_ms,sigma,imbalance,hedge_cost,basis,adverse,row.timestamp_ms+max(horizons_ms),f"toxic-{int(mixture*100):02d}"))
        flow.append((row.timestamp_ms,row.size_base*row.price*(1 if row.taker_side=="buy" else -1)))
    if len(observations)<30:raise ValueError("capture is too short for requested forward markout horizons")
    return observations

def capture_integrity(path:str)->dict:
    summary_path=f"{path}.summary.json"
    if not os.path.exists(summary_path):return {"summaryPresent":False,"noReportedTransportErrors":False,"noReportedSequenceGaps":False}
    try:
        with open(summary_path) as handle:summary=json.load(handle)
        errors=summary.get("errors",[]);gaps=summary.get("sequenceGaps",{})
        return {"summaryPresent":True,"noReportedTransportErrors":isinstance(errors,list) and not errors,"noReportedSequenceGaps":all(int(gaps.get(venue,-1))==0 for venue in ("coinbase","binance"))}
    except (OSError,ValueError,TypeError):return {"summaryPresent":False,"noReportedTransportErrors":False,"noReportedSequenceGaps":False}

def write_report(result:dict,output:str,metadata:dict):
    encoded=json.dumps({"metadata":metadata,"calibration":result},indent=2);os.makedirs(os.path.dirname(output) or ".",exist_ok=True)
    with open(output,"w") as handle:handle.write(encoded+"\n")
    rows="".join(f"<tr><td>{html.escape(name)}</td><td>{value['observations']}</td><td>{value['underquoteRate']:.2%}</td><td>{value['meanSpreadBps']:.2f}</td><td>{value['p99ShortfallBps']:.2f}</td></tr>" for name,value in result["holdoutByRegime"].items())
    weights=" · ".join(f"{name} {value:g}" for name,value in result["weights"].items())
    gates="".join(f"<li class={'pass' if passed else 'fail'}>{'PASS' if passed else 'FAIL'} · {html.escape(name)}</li>" for name,passed in result.get("dataGates",{}).items())
    document=f"""<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><title>RFQ calibration report</title><style>body{{margin:0;background:#05090d;color:#e8f0f5;font:14px system-ui}}main{{max-width:1000px;margin:auto;padding:40px}}h1{{font-size:32px}}.tag,.pass{{color:#00e6cf;text-transform:uppercase;letter-spacing:.12em}}section{{border-top:1px solid #29404c;padding:24px 0}}strong{{font:24px ui-monospace}}table{{width:100%;border-collapse:collapse}}th,td{{padding:12px;text-align:left;border-bottom:1px solid #182832}}th{{color:#8ea3ad}}code,.warn,.fail{{color:#ffca64}}li{{margin:8px 0;font:12px ui-monospace;letter-spacing:.06em}}</style><main><p class=tag>Research only · purged holdout</p><h1>Market-flow calibration</h1><p class=warn>Public exchange flow is a stress input, not a substitute for paid RFQ fills. No parameter is promoted automatically.</p><section><p>Candidate weights</p><strong>{html.escape(weights)}</strong><p>Shadow eligible: <code>{str(result['eligibleForShadow']).lower()}</code> · Purged boundary observations: {result['boundaries']['purged']}</p><ul>{gates}</ul></section><section><h2>Untouched holdout by flow mixture</h2><table><thead><tr><th>Scenario</th><th>Samples</th><th>Underquote</th><th>Mean spread</th><th>P99 shortfall</th></tr></thead><tbody>{rows}</tbody></table></section><section><h2>Provenance</h2><pre>{html.escape(json.dumps(metadata,indent=2))}</pre></section></main>"""
    with open(os.path.splitext(output)[0]+".html","w") as handle:handle.write(document)

def main():
    parser=argparse.ArgumentParser();parser.add_argument("tape");parser.add_argument("--output",default=".local-state/calibration/latest.json");parser.add_argument("--horizons-ms",default="1000,5000,30000,300000");parser.add_argument("--mixtures",default="0.05,0.25,0.50,0.90");parser.add_argument("--seed",type=int,default=7);parser.add_argument("--observations")
    args=parser.parse_args();trades=load_tape(args.tape);horizons=tuple(int(value) for value in args.horizons_ms.split(","));mixtures=tuple(float(value) for value in args.mixtures.split(","));observations=build_observations(trades,horizons,mixtures,args.seed)
    if args.observations:
        os.makedirs(os.path.dirname(args.observations) or ".",exist_ok=True)
        with open(args.observations,"w",newline="") as handle:
            writer=csv.writer(handle);writer.writerow(("timestamp","volatility_bps","toxicity_bps","hedge_cost_bps","basis_bps","adverse_bps","label_end_timestamp","regime"));writer.writerows((row.timestamp,row.volatility_bps,row.toxicity_bps,row.hedge_cost_bps,row.basis_bps,row.adverse_bps,row.label_end_timestamp,row.regime) for row in observations)
    with open(args.tape,"rb") as handle:source_hash=hashlib.sha256(handle.read()).hexdigest()
    venues=sorted(set(row.venue for row in trades));markets=sorted(set(row.market for row in trades));duration=max(row.timestamp_ms for row in trades)-min(row.timestamp_ms for row in trades)
    integrity=capture_integrity(args.tape);metadata={"source":os.path.abspath(args.tape),"sourceSha256":source_hash,"trades":len(trades),"observations":len(observations),"durationMs":duration,"venues":venues,"markets":markets,"horizonsMs":horizons,"toxicMixtures":mixtures,"seed":args.seed,"captureIntegrity":integrity,"method":"250ms normalized trade buckets; causal EWMA volatility and trailing flow imbalance; forward adverse markouts"}
    result=calibrate(observations);data_gates={"durationAtLeast24h":duration>=86_400_000,"includesFiveMinuteMarkout":max(horizons)>=300_000,"atLeastTwoVenues":len(venues)>=2,"bothMarkets":markets==["BTC","ETH"],"atLeastTenThousandTrades":len(trades)>=10_000,"captureSummaryPresent":integrity["summaryPresent"],"noReportedTransportErrors":integrity["noReportedTransportErrors"],"noReportedSequenceGaps":integrity["noReportedSequenceGaps"]};result["statisticalEligibleForShadow"]=result["eligibleForShadow"];result["dataGates"]=data_gates;result["eligibleForShadow"]=result["eligibleForShadow"] and all(data_gates.values())
    write_report(result,args.output,metadata);print(json.dumps({"output":os.path.abspath(args.output),"html":os.path.abspath(os.path.splitext(args.output)[0]+".html"),"observations":len(observations),"eligibleForShadow":result["eligibleForShadow"]},indent=2))

if __name__=="__main__":main()
