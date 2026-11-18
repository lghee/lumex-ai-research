#!/usr/bin/env python3
"""Independent LUMEX research experiment. NEVER sends orders or reads customer data.
Real Gate public perpetual 4H bars, purged chronological train/validation/holdout.
Not part of LUMEX admin, core, production scheduler, or live strategy registry.
"""
from __future__ import annotations
import concurrent.futures, datetime as dt, hashlib, json, math, os, time
import urllib.parse, urllib.request
from pathlib import Path
import numpy as np
from sklearn.preprocessing import StandardScaler
from sklearn.cluster import KMeans
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.ensemble import RandomForestClassifier

ASSETS=("BTC","ETH","SOL","XRP")
FRAME=14400
STEP=6            # one 24-hour independent entry per asset
HORIZON=6         # next 4H open -> exit at next-day 4H open
FEE=.0009         # adverse taker fee + slippage PER side
FUNDING=.00015    # adverse 24h funding proxy
SCHEMA="lumex_independent_ai_research_v1"
NOW=int(time.time())
CACHE_DIR=Path(os.environ.get("LUMEX_INDEPENDENT_RESEARCH_DIR","/tmp/lumex-independent"))

def load_asset(asset:str):
    assert asset in ASSETS
    rows=[]
    before=None
    for page in range(3):
        q={"contract":asset+"_USDT","interval":"4h","limit":1500}
        if before is not None:q["to"]=before
        url="https://api.gateio.ws/api/v4/futures/usdt/candlesticks?"+urllib.parse.urlencode(q)
        req=urllib.request.Request(url,headers={
            "Accept":"application/json","User-Agent":"LUMEX-Independent-OHLCV-Research/1.0"})
        try:
            with urllib.request.urlopen(req,timeout=30) as res:payload=res.read(350001)
            if len(payload)>350000:raise ValueError("oversized_response")
            page_rows=json.loads(payload)
        except (OSError,ValueError) as e:raise RuntimeError("gate_public_data_unavailable") from e
        if not isinstance(page_rows,list) or len(page_rows)<1300:raise RuntimeError("short_page")
        before=min(int(z["t"]) for z in page_rows)
        rows.extend(page_rows)
    d={}
    for x in rows:
        try:
            t=int(x["t"]);o,h,l,c,v=(float(x[k]) for k in ("o","h","l","c","v"))
        except (KeyError,TypeError,ValueError) as e:raise RuntimeError("invalid_gate_row") from e
        if t*1000+FRAME*1000>NOW*1000:continue       # reject unfinished candle
        if t%FRAME!=0 or not all(map(math.isfinite,(o,h,l,c,v))):raise RuntimeError("invalid_time_or_number")
        if v==0 and o==h==l==c:continue              # known pagination sentinel
        if o<=0 or l<=0 or c<=0 or v<0 or h<max(o,c,l) or l>min(o,c):raise RuntimeError("invalid_ohlcv")
        row=(t,o,h,l,c,v)
        if t in d and d[t]!=row:raise RuntimeError("conflicting_duplicate")
        d[t]=row
    arr=np.asarray([d[t] for t in sorted(d)],dtype=float)
    if len(arr)<4000 or np.any(np.diff(arr[:,0])!=FRAME):raise RuntimeError("gapped_history")
    return arr

def ema(values,period):
    out=np.empty_like(values)
    out[0]=values[0]; a=2/(period+1)
    for i in range(1,len(out)):out[i]=a*values[i]+(1-a)*out[i-1]
    return out

def prepare(markets):
    first=max(int(v[0,0]) for v in markets.values())
    last=min(int(v[-1,0]) for v in markets.values())
    bars={a:mat[(mat[:,0]>=first)&(mat[:,0]<=last)] for a,mat in markets.items()}
    n=len(bars[ASSETS[0]])
    if n<4000 or not all(len(bars[a])==n and np.array_equal(bars[a][:,0],bars[ASSETS[0]][:,0]) for a in ASSETS):
        raise RuntimeError("unverified_time_alignment")
    caches={}
    for a in ASSETS:
        b=bars[a];p=b[:,4];logs=np.log(p)
        vol=np.zeros(n)
        for t in range(60,n):
            vol[t]=max(.007,float(np.std(np.diff(logs[t-59:t+1]))*math.sqrt(6)))
        caches[a]={"b":b,"c":p,"ma20":ema(p,20),"ma80":ema(p,80),"ma200":ema(p,200),"vol":vol}
    train_end=int(n*.60);val_end=int(n*.80)
    timestamps=np.arange(395,n-HORIZON-3,STEP)
    # One input row per symbol per UTC day, all features from candles <= decision index.
    X=[];Z=[];ret=[];delayed=[];side=[];sizing=[];day=[];asset_ids=[]
    for t in timestamps:
        btc=caches["BTC"];btc14=np.log(btc["c"][t]/btc["c"][t-84]);btc200=np.log(btc["c"][t]/btc["ma200"][t])
        rr=[np.log(caches[a]["c"][t]/caches[a]["c"][t-84]) for a in ASSETS]
        disp=float(np.std(rr))
        for i,a in enumerate(ASSETS):
            c=caches[a];b=c["b"];p=c["c"];rv=c["vol"][t]
            r14=np.log(p[t]/p[t-84]);r60=np.log(p[t]/p[t-360])
            sg=1 if r14>0 and r60>0 else -1 if r14<0 and r60<0 else 0
            vr=b[t,5]/max(1.,float(np.mean(b[t-30:t,5])))
            # 18 features; future prices never appear here.
            f=[
                np.log(p[t]/p[t-1]),np.log(p[t]/p[t-3]),np.log(p[t]/p[t-6]),
                np.log(p[t]/p[t-18]),np.log(p[t]/p[t-42]),
                r14,r60,np.log(c["ma20"][t]/c["ma80"][t]),
                np.log(p[t]/c["ma200"][t]),rv,
                (p[t]-b[t,1])/b[t,1],(b[t,2]-b[t,3])/b[t,1],
                np.log(max(vr,.00001)),btc14,btc200,disp,
                (p[t]-b[t,3])/max(1.e-9,b[t,2]-b[t,3]),
                r14-btc14,
                sg,
                *[1. if i==j else 0. for j in range(len(ASSETS))]
            ]
            regime_features=[r14,r60,rv,np.log(max(vr,.00001)),btc14,disp]
            X.append(f);Z.append(regime_features)
            ret.append(float(b[t+HORIZON+1,1]/b[t+1,1]-1))
            delayed.append(float(b[t+HORIZON+2,1]/b[t+2,1]-1))
            side.append(sg);sizing.append(min(.25,.25*.025/max(.01,rv)))
            day.append(int(t));asset_ids.append(i)
    X=np.asarray(X);Z=np.asarray(Z);ret=np.asarray(ret);delayed=np.asarray(delayed)
    side=np.asarray(side,dtype=int);size=np.asarray(sizing);day=np.asarray(day);asset_ids=np.asarray(asset_ids)
    if not np.isfinite(X).all():raise RuntimeError("nonfinite_features")
    train=(day+HORIZON+2<train_end)
    val=(day>=train_end)&(day+HORIZON+2<val_end)
    test=(day>=val_end)
    if min(train.sum(),val.sum(),test.sum())<300:raise RuntimeError("insufficient_splits")
    research_label=(side*ret>(2*FEE+FUNDING)).astype(int)
    # Baseline-only meta labels. Include regime fitted only on TRAIN observations.
    standard=StandardScaler().fit(Z[train])
    kmeans=KMeans(n_clusters=4,random_state=20261118,n_init=12).fit(standard.transform(Z[train]))
    clusters=kmeans.predict(standard.transform(Z))
    X=np.column_stack((X,np.eye(4)[clusters]))
    fitted=StandardScaler().fit(X[train & (side!=0)])
    features=np.clip(fitted.transform(X),-6,6)
    return dict(n=n,first=first,last=last,bars=bars,day=day,asset_ids=asset_ids,
        train=train,val=val,test=test,side=side,features=features,clusters=clusters,
        labels=research_label,returns=ret,delayed=delayed,size=size,
        train_end=train_end,val_end=val_end)

def scores(c,mask,keep=None,stress=1.,delay=False):
    times=np.unique(c["day"][mask])
    if len(times)<40:raise RuntimeError("short_backtest")
    daily=[];ledger=[];peak=10000.;eq=10000.;mdd=0.
    for t in times:
        ix=np.where(mask&(c["day"]==t))[0]
        direction=c["side"][ix].copy()
        if keep is not None:direction[~keep[ix]]=0
        weights=direction*c["size"][ix]
        gross=np.abs(weights).sum()
        if gross>1:weights/=gross
        r=c["delayed"][ix] if delay else c["returns"][ix]
        fee=(2*FEE+FUNDING)*stress
        net=weights*r-np.abs(weights)*fee
        daily.append(float(net.sum()))
        for j,position in enumerate(weights):
            if position!=0:ledger.append(float(net[j]))
        eq*=max(.00001,1+daily[-1]);peak=max(eq,peak)
        mdd=max(mdd,1-eq/peak)
    arr=np.asarray(daily);trades=len(ledger);profits=[x for x in ledger if x>0];losses=[x for x in ledger if x<=0]
    st=float(arr.std())
    return dict(return_pct=round((eq/10000-1)*100,3),mdd_pct=round(mdd*100,3),
                sharpe=round(float(arr.mean()/st*math.sqrt(365)),3) if st else None,
                trades=trades,win_pct=round(100*len(profits)/trades,2) if trades else None,
                pf=round(sum(profits)/(-sum(losses)),3) if losses and sum(losses)<0 else None,
                equity_usdt=round(eq,2),days=len(times),
                # cash is not a profitable position; no trades cannot pass.
                no_trade=(trades==0))

def time_range(c,mask):
    t=c["day"][mask]
    first=int(c["first"]+t.min()*FRAME)
    last=int(c["first"]+t.max()*FRAME)
    return [dt.datetime.fromtimestamp(first,dt.timezone.utc).strftime("%Y-%m-%d"),
            dt.datetime.fromtimestamp(last,dt.timezone.utc).strftime("%Y-%m-%d")]

def run(markets):
    c=prepare(markets)
    tr=c["train"]&(c["side"]!=0)
    val=c["val"];test=c["test"]
    x=c["features"];y=c["labels"]
    learners={
        "regularized_logistic":LogisticRegression(C=.2,max_iter=1200,solver="lbfgs",random_state=20261118),
        "random_forest":RandomForestClassifier(n_estimators=180,max_depth=5,
              min_samples_leaf=45,max_features=".sqrt".replace(".",""),random_state=20261118,n_jobs=2),
    }
    # Prevent accidental API/version drift in sklearn max_features.
    learners["random_forest"].set_params(max_features="sqrt")
    predictions={}
    for name,model in learners.items():
        model.fit(x[tr],y[tr])
        predictions[name]=model.predict_proba(x)[:,1]
    reg=Ridge(alpha=120.)
    reg.fit(x[tr],c["side"][tr]*c["returns"][tr]-(2*FEE+FUNDING))
    predictions["net_return_ridge"]=reg.predict(x)
    base_val=scores(c,val);base_test=scores(c,test)
    records={};thrs=[.50,.53,.56,.59,.62]
    for name,preds in predictions.items():
        candidates=[]
        for th in (thrs if name!="net_return_ridge" else [0,.001,.002,.004]):
            eligible=(c["side"]!=0)&(preds>=th)
            v=scores(c,val,eligible)
            stressed=scores(c,val,eligible,stress=2.)
            acceptable=(v["trades"]>=25 and stressed["trades"]>=25
                        and v["return_pct"]>base_val["return_pct"]
                        and stressed["return_pct"]>0
                        and v["mdd_pct"]<=max(20,base_val["mdd_pct"]))
            candidates.append(dict(threshold=th,validation=v,validation_2x=stressed,pass_gate=acceptable))
        winners=[a for a in candidates if a["pass_gate"]]
        selected=max(winners,key=lambda z:z["validation_2x"]["return_pct"]) if winners else None
        # Even unselected candidates get frozen diagnostic OOS at default threshold.
        chosen=selected["threshold"] if selected else (.56 if name!="net_return_ridge" else .002)
        eligible=(c["side"]!=0)&(preds>=chosen)
        records[name]=dict(selected_only_from_validation=bool(selected),
            selected_threshold=chosen,selection_did_not_use_holdout=True,
            validation=next(a["validation"] for a in candidates if a["threshold"]==chosen),
            validation_2x=next(a["validation_2x"] for a in candidates if a["threshold"]==chosen),
            validation_trials=candidates,
            holdout=scores(c,test,eligible),
            holdout_cost2x=scores(c,test,eligible,stress=2.),
            holdout_delay=scores(c,test,eligible,delay=True),
            validated_for_paper=bool(selected and scores(c,test,eligible)["return_pct"]>0
                                     and scores(c,test,eligible,stress=2.)["return_pct"]>0
                                     and scores(c,test,eligible,delay=True)["return_pct"]>0))
    # Distinct experiment: market regime only, no supervised classifier.
    regimes={}
    for k in range(4):
        filt=(c["clusters"]==k)&(c["side"]!=0)
        regimes[str(k)]=dict(validation=scores(c,val,filt),validation2x=scores(c,val,filt,stress=2.))
    enabled=[int(k) for k,z in regimes.items() if z["validation"]["trades"]>=30
             and z["validation"]["return_pct"]>0 and z["validation2x"]["return_pct"]>0]
    keep=np.isin(c["clusters"],enabled)&(c["side"]!=0)
    regime=dict(selected_validation_clusters=enabled,
                validation=scores(c,val,keep),holdout=scores(c,test,keep),
                holdout_cost2x=scores(c,test,keep,stress=2.))
    checksum=hashlib.sha256(b"".join(markets[a].astype("<f8").tobytes() for a in ASSETS)).hexdigest()
    return dict(schema=SCHEMA,generated_utc=dt.datetime.fromtimestamp(NOW,dt.timezone.utc).isoformat(),
        source="official Gate public USDT perpetual 4h OHLCV; 3 paginated pages per symbol",
        data_sha256=checksum,from_date=dt.datetime.fromtimestamp(c["first"],dt.timezone.utc).strftime("%Y-%m-%d"),
        to_date=dt.datetime.fromtimestamp(c["last"],dt.timezone.utc).strftime("%Y-%m-%d"),
        four_hour_bars_each=c["n"],symbol_count=len(ASSETS),
        split={"train":time_range(c,c["train"]),"validation":time_range(c,val),"locked_holdout":time_range(c,test)},
        method={"entry":"4h closed candle then next 4h open","exit":"24 hours later next open",
                "signal":"14/60-day time-series momentum as candidates",
                "features":"24 lagged price, market volatility, volume and regime features",
                "ml":"regularized Logistic, depth-limited Random Forest, Ridge profit regression, train-fitted K-means",
                "threshold_selection":"validation only","purge_bars":8,
                "fee_plus_slippage_each_side":FEE,"adverse_funding_proxy_24h":FUNDING,
                "daily_roundtrip_independent":True,"max_portfolio_gross":1.,
                "no_orders":True,"no_future_features":True},
        baseline={"validation":base_val,"holdout":base_test,
                 "holdout_cost2x":scores(c,test,stress=2.),
                 "holdout_delay":scores(c,test,delay=True)},
        ai=records,regime_only=regime,all_models_ready_for_live=False,
        warning="Historical research only; market orders, funding, liquidation and real fill parity not established.")

def main():
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
        fut={a:ex.submit(load_asset,a) for a in ASSETS}
        markets={a:fut[a].result() for a in ASSETS}
    result=run(markets)
    CACHE_DIR.mkdir(parents=True,exist_ok=True)
    path=CACHE_DIR/"independent_ai_report.json"
    path.write_text(json.dumps(result,indent=2,ensure_ascii=False),encoding="utf-8")
    compact={name:{"selection_passed":item["selected_only_from_validation"],
                    "threshold":item["selected_threshold"],
                    "validation":item["validation"],
                    "holdout":item["holdout"],
                    "cost2x":item["holdout_cost2x"],
                    "delay":item["holdout_delay"]}
             for name,item in result["ai"].items()}
    print("LUMEX_INDEPENDENT_AI_RESULT "+json.dumps({
        "source":result["source"],"sha256":result["data_sha256"],
        "start":result["from_date"],"end":result["to_date"],"bars":result["four_hour_bars_each"],
        "split":result["split"],"baseline":result["baseline"],
        "ai":compact,"regime_only":result["regime_only"],
        "live_enabled":result["all_models_ready_for_live"]},separators=(",",":")))
    print("LUMEX_INDEPENDENT_REPORT "+str(path))

if __name__=="__main__":main()
