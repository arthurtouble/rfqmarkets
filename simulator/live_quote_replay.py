"""Independent integer replay of adaptive-v1 quote inputs, not live qualification."""
import json,sys
from walk_forward_calibration import Observation,spread,CURRENT_WEIGHTS
BASE=10**18
USDC=10**6

def potential(btc,eth):
    return (10000*btc*btc+2*6573*btc*eth+12000*eth*eth)//(2*10**12*USDC)

def replay(item):
    request=item['request'];snapshot=item['snapshot'];market=request['market'];buy=request['side']=='buy'
    bid=int(snapshot['bid']);ask=int(snapshot['ask']);mid=(bid+ask)//2
    whole,*fraction=request['amount'].split('.')
    requested=int(whole)*USDC+int(((fraction[0] if fraction else '')+'000000')[:6])
    base=int(item['exactBaseDelta']) if item.get('exactBaseDelta') is not None else (requested*BASE//mid)*(1 if buy else -1)
    if not base or (base>0)!=buy:raise ValueError('invalid base direction')
    notional=abs(base)*mid//BASE if item.get('exactBaseDelta') is not None else requested
    if notional<=0 or notional>int(item.get('maxNotional',1000000*USDC)):raise ValueError('invalid notional')
    delta=notional*(1 if base>0 else -1)
    low={m:int(item['settled'][m]) for m in ('BTC','ETH')};high=low.copy()
    for pending in item['pending']:
        value=int(pending['delta']);(low if value<0 else high)[pending['market']]+=value
    costs=[]
    for btc in (low['BTC'],high['BTC']):
        for eth in (low['ETH'],high['ETH']):
            costs.append(potential(btc+(delta if market=='BTC' else 0),eth+(delta if market=='ETH' else 0))-potential(btc,eth))
    impact=max(0,max(costs));inputs=item.get('spreadInputs',{})
    spread_bps=spread(Observation(0,inputs.get('volatilityBps',0),inputs.get('toxicityScoreBps',0),inputs.get('hedgeCostBps',0),inputs.get('venueBasisBps',0),0,hedge_latency_ms=inputs.get('hedgeLatencyMs',0),confidence_bps=inputs.get('confidenceBps',0),risk_mode=inputs.get('riskMode','normal')),CURRENT_WEIGHTS)
    ceil=lambda numerator,denominator:(numerator+denominator-1)//denominator
    spread_charge=ceil(notional*spread_bps,10000);fee=ceil(notional*2,10000)
    anchor=ask if buy else bid;premium=ceil(anchor*(spread_charge+impact),notional)
    expected=anchor+premium if buy else anchor-premium
    tolerance=ceil(expected*8,10000);worst=expected+tolerance if buy else expected-tolerance
    return {name:str(value) for name,value in dict(notional=notional,delta=delta,baseDelta=base,expectedPrice=expected,worstPrice=worst,fee=fee,impactCharge=impact).items()}

if __name__=='__main__':
    print(json.dumps([replay(item) for item in json.load(sys.stdin)]))
