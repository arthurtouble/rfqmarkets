"""Chronological quote-model calibration with an untouched holdout window.

Input CSV columns: timestamp, volatility_bps, toxicity_bps, hedge_cost_bps,
basis_bps, adverse_bps.  The objective penalizes underquoting four times more
than excess spread and never shuffles future observations into the past.
"""
from __future__ import annotations
import argparse, csv, itertools, json
from dataclasses import dataclass

@dataclass(frozen=True)
class Observation:
    timestamp: int
    volatility_bps: float
    toxicity_bps: float
    hedge_cost_bps: float
    basis_bps: float
    adverse_bps: float

def load(path: str) -> list[Observation]:
    with open(path, newline="") as handle:
        rows=[Observation(int(row["timestamp"]),*[float(row[name]) for name in ("volatility_bps","toxicity_bps","hedge_cost_bps","basis_bps","adverse_bps")]) for row in csv.DictReader(handle)]
    rows.sort(key=lambda row: row.timestamp)
    if len(rows)<30: raise ValueError("calibration requires at least 30 chronological observations")
    return rows

def spread(row: Observation, weights: tuple[float,float,float,float]) -> float:
    return min(100.0,2.0+row.volatility_bps*weights[0]+row.toxicity_bps*weights[1]+row.hedge_cost_bps*weights[2]+abs(row.basis_bps)*weights[3])

def loss(rows: list[Observation], weights: tuple[float,float,float,float]) -> float:
    errors=[spread(row,weights)-row.adverse_bps for row in rows]
    return sum(error if error>=0 else -4*error for error in errors)/len(errors)

def calibrate(rows: list[Observation]):
    train_end=max(1,int(len(rows)*.6));validation_end=max(train_end+1,int(len(rows)*.8))
    train,validation,test=rows[:train_end],rows[train_end:validation_end],rows[validation_end:]
    grid=itertools.product((.1,.2,.3,.4),(.1,.25,.5,.75),(0.5,1.,1.5),(0.25,.5,1.))
    finalists=sorted(((loss(train,w),w) for w in grid),key=lambda item:item[0])[:12]
    _,weights=min(((loss(validation,w),w) for _,w in finalists),key=lambda item:item[0])
    def metrics(part):
        quoted=[spread(row,weights) for row in part]
        misses=sum(value<row.adverse_bps for value,row in zip(quoted,part))
        return {"observations":len(part),"objective":round(loss(part,weights),6),"underquoteRate":round(misses/len(part),6),"meanSpreadBps":round(sum(quoted)/len(quoted),6)}
    return {"weights":{"volatility":weights[0],"toxicity":weights[1],"hedgeCost":weights[2],"basis":weights[3]},"train":metrics(train),"validation":metrics(validation),"holdout":metrics(test)}

if __name__=="__main__":
    parser=argparse.ArgumentParser();parser.add_argument("csv");parser.add_argument("--output")
    args=parser.parse_args();result=calibrate(load(args.csv));encoded=json.dumps(result,indent=2)
    if args.output:
        with open(args.output,"w") as handle: handle.write(encoded+"\n")
    print(encoded)
