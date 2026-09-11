"""Purged chronological calibration for bounded RFQ spread components.

Input columns: timestamp, volatility_bps, toxicity_bps, hedge_cost_bps,
basis_bps, adverse_bps. Optional label_end_timestamp prevents forward-markout
labels from leaking across split boundaries; optional regime enables worst-regime
validation. The untouched holdout is reported once and never selects weights.
"""
from __future__ import annotations
import argparse, csv, itertools, json, math
from dataclasses import dataclass

@dataclass(frozen=True)
class Observation:
    timestamp: int
    volatility_bps: float
    toxicity_bps: float
    hedge_cost_bps: float
    basis_bps: float
    adverse_bps: float
    label_end_timestamp: int = 0
    regime: str = "observed"

CURRENT_WEIGHTS=(.2,.0035,1.,1.)
GRID=tuple(itertools.product((.1,.2,.3,.4),(.00175,.0035,.00525),(.75,1.,1.25),(.5,1.,1.5)))

def load(path: str) -> list[Observation]:
    with open(path, newline="") as handle:
        rows=[]
        for row in csv.DictReader(handle):
            timestamp=int(row["timestamp"])
            rows.append(Observation(timestamp,*[float(row[name]) for name in ("volatility_bps","toxicity_bps","hedge_cost_bps","basis_bps","adverse_bps")],int(row.get("label_end_timestamp") or timestamp),row.get("regime") or "observed"))
    rows.sort(key=lambda row: row.timestamp)
    if len(rows)<30: raise ValueError("calibration requires at least 30 chronological observations")
    return rows

def spread(row: Observation, weights: tuple[float,float,float,float]) -> float:
    return min(100.0,2.0+row.volatility_bps*weights[0]+row.toxicity_bps*weights[1]+row.hedge_cost_bps*weights[2]+abs(row.basis_bps)*weights[3])

def loss(rows: list[Observation], weights: tuple[float,float,float,float]) -> float:
    errors=[spread(row,weights)-row.adverse_bps for row in rows]
    return sum(error*.25 if error>=0 else -6*error for error in errors)/len(errors)

def percentile(values:list[float],quantile:float)->float:
    ordered=sorted(values);return ordered[min(len(ordered)-1,max(0,math.ceil(len(ordered)*quantile)-1))]

def partition(rows:list[Observation]):
    timestamps=sorted(set(row.timestamp for row in rows))
    if len(timestamps)<5: raise ValueError("calibration requires distinct chronological timestamps")
    train_boundary=timestamps[max(1,int(len(timestamps)*.6))]
    validation_boundary=timestamps[max(2,int(len(timestamps)*.8))]
    train=[row for row in rows if row.timestamp<train_boundary and (row.label_end_timestamp or row.timestamp)<train_boundary]
    validation=[row for row in rows if train_boundary<=row.timestamp<validation_boundary and (row.label_end_timestamp or row.timestamp)<validation_boundary]
    holdout=[row for row in rows if row.timestamp>=validation_boundary]
    if min(map(len,(train,validation,holdout)))<5: raise ValueError("purged chronological partitions require at least five observations each")
    return train,validation,holdout,{"trainBoundary":train_boundary,"validationBoundary":validation_boundary,"purged":len(rows)-len(train)-len(validation)-len(holdout)}

def metrics(rows:list[Observation],weights:tuple[float,float,float,float]):
    quoted=[spread(row,weights) for row in rows];shortfalls=[max(0,row.adverse_bps-value) for value,row in zip(quoted,rows)]
    return{"observations":len(rows),"objective":round(loss(rows,weights),6),"underquoteRate":round(sum(value>0 for value in shortfalls)/len(rows),6),"meanSpreadBps":round(sum(quoted)/len(quoted),6),"p95SpreadBps":round(percentile(quoted,.95),6),"p99ShortfallBps":round(percentile(shortfalls,.99),6)}

def worst_regime_loss(rows:list[Observation],weights:tuple[float,float,float,float]):
    return max(loss([row for row in rows if row.regime==regime],weights) for regime in set(row.regime for row in rows))

def calibrate(rows: list[Observation]):
    train,validation,holdout,boundaries=partition(rows)
    finalists=sorted(GRID,key=lambda weights:(loss(train,weights),weights))[:24]
    weights=min(finalists,key=lambda value:(worst_regime_loss(validation,value),loss(validation,value),value))
    result={"status":"research-only","weights":{"volatility":weights[0],"toxicity":weights[1],"hedgeCost":weights[2],"basis":weights[3]},"boundaries":boundaries,"train":metrics(train,weights),"validation":metrics(validation,weights),"holdout":metrics(holdout,weights),"currentHoldout":metrics(holdout,CURRENT_WEIGHTS)}
    result["holdoutByRegime"]={regime:metrics([row for row in holdout if row.regime==regime],weights) for regime in sorted(set(row.regime for row in holdout))}
    result["eligibleForShadow"]=result["holdout"]["underquoteRate"]<=.05 and result["holdout"]["objective"]<=result["currentHoldout"]["objective"]
    return result

if __name__=="__main__":
    parser=argparse.ArgumentParser();parser.add_argument("csv");parser.add_argument("--output")
    args=parser.parse_args();result=calibrate(load(args.csv));encoded=json.dumps(result,indent=2)
    if args.output:
        with open(args.output,"w") as handle: handle.write(encoded+"\n")
    print(encoded)
