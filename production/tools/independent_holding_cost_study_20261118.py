#!/usr/bin/env python3
"""Independent add-on: persistence/carry/cost sensitive futures strategy study.
Loads exactly the same verified public Gate 4H candles as AI experiment.
One research portfolio per model. No orders, no production writes.
"""
import json,math,os,datetime as dt
from pathlib import Path
import numpy as np
from independent_ai_research_20261118 import ASSETS,FRAME,STEP,FEE,FUNDING,NOW,load_asset,ema

ROOT=Path(os.environ.get("LUMEX_INDEPENDENT_RESEARCH_DIR","/tmp/lumex-independent"))
FAMILIES=[
 "MOM14_60","MOM28_90","MOM14_60_LONG_ONLY",
 "EMA20_80_200","EMA20_80_200_LONG_ONLY",
 "BREAKOUT55_EXIT20","BREAKOUT120_EXIT40",
 "BTC_MACRO_VOL_FILTER","RELATIVE_STRENGTH28",
 "BTC_HOLD_PERPETUAL"
]

def fetch_or_cache():
    path=ROOT/"observed_bars.npz"
    if path.exists():
        d=np.load(path,allow_pickle=False)
        markets={a:d[a] for a in ASSETS}
    else:
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
            fut={a:ex.submit(load_asset,a) for a in ASSETS}
            markets={a:fut[a].result() for a in ASSETS}
    first=max(int(v[0,0]) for v in markets.values())
    last=min(int(v[-1,0]) for v in markets.values())
    aligned={a:v[(v[:,0]>=first)&(v[:,0]<=last)] for a,v in markets.items()}
    n=len(aligned["BTC"])
    if n<4000 or any(len(v)!=n or not np.array_equal(v[:,0],aligned["BTC"][:,0]) for v in aligned.values()):
        raise RuntimeError("unsafe_alignment")
    return aligned

def prepare(markets):
    n=len(markets["BTC"]); d={}
    for asset in ASSETS:
        b=markets[asset];c=b[:,4]
        rolling=np.zeros(n)
        for t in range(60,n):
            rolling[t]=max(.006,float(np.std(np.diff(np.log(c[t-59:t+1]))))*math.sqrt(6))
        d[asset]={"b":b,"c":c,"e20":ema(c,20),"e80":ema(c,80),"e200":ema(c,200),
                  "vol":rolling}
    # Gate bars are 4h open timestamps, each decision is made at the end of bar t
    return d

def signal(family,asset,t,d,state,low_vol):
    x=d[asset];c=x["c"];p=c[t]
    btc=d["BTC"]
    r14=p/c[t-84]-1;r60=p/c[t-360]-1
    if family.startswith("MOM14_60") or family=="BTC_MACRO_VOL_FILTER":
        side=1 if r14>0 and r60>0 else -1 if r14<0 and r60<0 else 0
        if family=="MOM14_60_LONG_ONLY":side=max(0,side)
        if family=="BTC_MACRO_VOL_FILTER":
            if btc["vol"][t]>low_vol:side=0
            elif side==1 and btc["c"][t]<btc["e200"][t]:side=0
            elif side==-1 and btc["c"][t]>btc["e200"][t]:side=0
        return side
    if family=="MOM28_90":
        a=p/c[t-168]-1;b=p/c[t-540]-1
        return 1 if a>0 and b>0 else -1 if a<0 and b<0 else 0
    if family.startswith("EMA20_80_200"):
        side=1 if x["e20"][t]>x["e80"][t] and p>x["e200"][t] else -1 if x["e20"][t]<x["e80"][t] and p<x["e200"][t] else 0
        if family.endswith("_LONG_ONLY"):side=max(side,0)
        return side
    if family.startswith("BREAKOUT"):
        if family=="BREAKOUT55_EXIT20":entry,leave=55,20
        else:entry,leave=120,40
        prior=state.get(asset,0)
        hi=float(x["b"][t-entry:t,2].max())
        lo=float(x["b"][t-entry:t,3].min())
        lo_exit=float(x["b"][t-leave:t,3].min())
        hi_exit=float(x["b"][t-leave:t,2].max())
        if prior==1 and p<lo_exit:prior=0
        if prior==-1 and p>hi_exit:prior=0
        if prior==0:
            if p>hi and p>x["e200"][t]:prior=1
            elif p<lo and p<x["e200"][t]:prior=-1
        state[asset]=prior
        return prior
    if family=="RELATIVE_STRENGTH28":
        ranks=sorted(ASSETS,key=lambda s:d[s]["c"][t]/d[s]["c"][t-168])
        gap=d[ranks[-1]]["c"][t]/d[ranks[-1]]["c"][t-168]-d[ranks[0]]["c"][t]/d[ranks[0]]["c"][t-168]
        if gap<.05:return 0
        return -1 if asset==ranks[0] else (1 if asset==ranks[-1] else 0)
    if family=="BTC_HOLD_PERPETUAL":return 1 if asset=="BTC" else 0
    raise RuntimeError("bad_strategy")

def experiment(d,family,start,end,rebalance=1,cost_mult=1.,delay=False,save_curve=False):
    prev=np.zeros(len(ASSETS));cash=10000.;peak=10000.;mdd=0.;turnover=0.;cost_sum=0.;moves=0;curve=[]
    state={};daily=[]
    # all training-fitted thresholds computed BEFORE validation and holdout
    train_cut=int(len(d["BTC"]["c"])*.6)
    low_vol=float(np.median(d["BTC"]["vol"][360:train_cut]))
    days=list(range(start,end-8,STEP))
    for day_i,t in enumerate(days):
        target=prev.copy()
        if day_i%rebalance==0:
            for i,asset in enumerate(ASSETS):
                side=signal(family,asset,t,d,state,low_vol)
                vol=d[asset]["vol"][t]
                size=(1. if family=="BTC_HOLD_PERPETUAL" else .25*min(1.35,.025/max(.01,vol)))
                desired=float(side*size)
                # No speculative tiny rebalances from changing volatility estimates.
                if np.sign(desired)!=np.sign(prev[i]) or abs(desired-prev[i])>=.04:
                    target[i]=desired
        gross=np.abs(target).sum()
        if gross>1:target=target/gross
        delta=float(np.abs(target-prev).sum())
        turnover+=delta
        if delta>1e-7:moves+=1
        # Enter next open using only the previous bar's closed information.
        first=t+(2 if delay else 1);final=first+STEP
        returns=np.array([d[a]["b"][final,1]/d[a]["b"][first,1]-1 for a in ASSETS])
        carry=float(np.abs(target).sum())*FUNDING*cost_mult
        cost=delta*FEE*cost_mult+carry
        net=float(target@returns)-cost
        daily.append(net);cost_sum+=cost
        cash*=max(.00001,1+net);peak=max(peak,cash);mdd=max(mdd,1-cash/peak)
        if save_curve:curve.append(dict(t=int(d["BTC"]["b"][final,0]),equity=round(cash,4),daily_return=round(net,7),gross=round(float(np.abs(target).sum()),4)))
        prev=target
    # Close ALL open notional on final mark, charge exit commission.
    close_cost=float(np.abs(prev).sum())*FEE*cost_mult
    cash*=max(.00001,1-close_cost);cost_sum+=close_cost;turnover+=float(np.abs(prev).sum())
    peak=max(peak,cash);mdd=max(mdd,1-cash/peak)
    gains=sum(x for x in daily if x>0);losses=-sum(x for x in daily if x<0)
    a=np.asarray(daily,dtype=float);sd=float(a.std())
    def percent(p):return round(float(p),3)
    result={"return_pct":percent((cash/10000-1)*100),"max_drawdown_pct":percent(mdd*100),
            "sharpe":percent(float(a.mean()/sd*math.sqrt(365))) if sd else None,
            "positive_days":int(np.sum(a>0)),"days":len(daily),
            "profit_factor":percent(gains/losses) if losses>0 else None,
            "notional_turnover":percent(turnover),"rebalance_events":moves,
            "cost_paid_as_initial_pct":percent(cost_sum*100),
            "equity_usdt":round(cash,2)}
    if save_curve:result["daily_curve"]=curve
    return result

def main():
    markets=fetch_or_cache();d=prepare(markets);n=len(markets["BTC"])
    train_cut=int(n*.6);val_cut=int(n*.8)
    ranges={"validation":(train_cut,val_cut),"holdout":(val_cut,n)}
    output=[]
    for f in FAMILIES:
        for gap in (1,3,7):
            if f=="BTC_HOLD_PERPETUAL" and gap!=1:continue
            name=f+"_"+str(gap)+"d"
            v=experiment(d,f,*ranges["validation"],gap)
            vs=experiment(d,f,*ranges["validation"],gap,cost_mult=2.)
            t=experiment(d,f,*ranges["holdout"],gap)
            ts=experiment(d,f,*ranges["holdout"],gap,cost_mult=2.)
            lag=experiment(d,f,*ranges["holdout"],gap,delay=True)
            qualified=(v["return_pct"]>0 and vs["return_pct"]>0
                       and v["max_drawdown_pct"]<=25 and v["rebalance_events"]>=7)
            output.append(dict(strategy=name,family=f,rebalance_days=gap,validation=v,validation_cost2x=vs,
                               holdout=t,holdout_cost2x=ts,holdout_delay=lag,validation_gate=qualified))
    qualified=[r for r in output if r["validation_gate"]]
    selected=max(qualified,key=lambda x:x["validation_cost2x"]["return_pct"]) if qualified else None
    checksum=__import__("hashlib").sha256(b"".join(markets[a].astype("<f8").tobytes() for a in ASSETS)).hexdigest()
    summary={
      "schema":"lumex_independent_position_cost_v1",
      "generated_utc":dt.datetime.fromtimestamp(NOW,dt.timezone.utc).isoformat(),
      "data_sha256":checksum,
      "source":"same verified Gate public 4h OHLCV as independent ML research",
      "first_utc":dt.datetime.fromtimestamp(markets["BTC"][0,0],dt.timezone.utc).strftime("%Y-%m-%d"),
      "last_utc":dt.datetime.fromtimestamp(markets["BTC"][-1,0],dt.timezone.utc).strftime("%Y-%m-%d"),
      "model":"position persistence, periodic rebalance and turnover-based costs",
      "assumptions":{"per_side_fee_slippage":FEE,"adverse_funding_per_day":FUNDING,
                     "max_gross_exposure":1.,"valuation":"24h next-open to next-open",
                     "closed_bar_input":True,"no_intrabar_stops_or_liquidation":True},
      "validation_only_selected_strategy":selected["strategy"] if selected else None,
      "selected_result":selected,
      "top_validation":sorted(output,key=lambda r:r["validation_cost2x"]["return_pct"],reverse=True)[:8],
      "top_holdout_EXPLORATORY":sorted(output,key=lambda r:r["holdout_cost2x"]["return_pct"],reverse=True)[:10],
      "all":output,"not_live_approved":True,"does_not_change_admin":True
    }
    ROOT.mkdir(parents=True,exist_ok=True)
    (ROOT/"position_cost_study.json").write_text(json.dumps(summary,indent=2),encoding="utf-8")
    print("LUMEX_POSITION_COST_RESEARCH "+json.dumps({
      "source_hash":summary["data_sha256"],"candidate_count":len(output),
      "validation_selected":summary["validation_only_selected_strategy"],
      "selected_result":summary["selected_result"],
      "top_validation":summary["top_validation"][:5],
      "top_holdout_exploratory":summary["top_holdout_EXPLORATORY"][:5],
      "live_approved":False},separators=(',',':')))

if __name__=="__main__":main()
