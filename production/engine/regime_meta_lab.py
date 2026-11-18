"""LUMEX 4-hour OHLCV meta-label research. Research ONLY, never customer orders."""
from __future__ import annotations
import hashlib, json, math, time, urllib.parse, urllib.request
from datetime import datetime, timezone
import numpy as np

SYMBOLS=("BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT")
SCHEMA="lumex_regime_meta_research_v1"
FRAME=14400
HORIZON=6
FEE_PER_SIDE=.0009
FUNDING_PROXY=.00015

class ResearchFailure(ValueError): pass

def number(x):
    if isinstance(x,bool):return float('nan')
    try:return float(x)
    except (TypeError,ValueError):return float('nan')

def validated_market(rows,now,minimum=2500):
    current=(now//FRAME)*FRAME
    out={}
    for row in rows:
        if not isinstance(row,dict):raise ResearchFailure('invalid_row')
        t=number(row.get('t'))
        o,h,l,c,v=[number(row.get(k)) for k in ('o','h','l','c','v')]
        if not math.isfinite(t) or not t.is_integer() or t<1550000000 or int(t)%FRAME:raise ResearchFailure('timestamp')
        t=int(t)
        if t>=current:continue
        if not all(math.isfinite(x) for x in (o,h,l,c,v)):raise ResearchFailure('nonfinite')
        if v<=0 and o==h==l==c:continue  # Gate pagination zero-volume boundary placeholder.
        if o<=0 or l<=0 or c<=0 or h<max(o,l,c) or l>min(o,c) or v<=0:raise ResearchFailure('invalid_ohlcv')
        value=(t,o,h,l,c,v)
        if t in out and value!=out[t]:raise ResearchFailure('duplicate_conflict')
        out[t]=value
    values=np.asarray([out[k] for k in sorted(out)],dtype=float)
    if values.ndim!=2 or len(values)<minimum:raise ResearchFailure('insufficient_history')
    if not np.all(np.diff(values[:,0])==FRAME):raise ResearchFailure('history_gap')
    if int(values[-1,0])<current-3*FRAME:raise ResearchFailure('history_stale')
    return values

def fetch_gate_4h(symbol,now):
    if symbol not in SYMBOLS:raise ResearchFailure('bad_symbol')
    all_rows=[];cursor=None
    for _ in range(3):
        args={'contract':symbol.replace('USDT','_USDT'),'interval':'4h','limit':'1500'}
        if cursor is not None:args['to']=str(cursor)
        url='https://api.gateio.ws/api/v4/futures/usdt/candlesticks?'+urllib.parse.urlencode(args)
        request=urllib.request.Request(url,headers={'accept':'application/json','user-agent':'LUMEX-ReadOnly-Regime-Research/1.0'})
        try:
            with urllib.request.urlopen(request,timeout=15) as response:raw=response.read(300001)
            if not raw or len(raw)>300000:raise ResearchFailure('provider_payload_size')
            rows=json.loads(raw)
        except (OSError,TimeoutError,ValueError) as exc:raise ResearchFailure('provider_unavailable') from exc
        if not isinstance(rows,list) or not 1200<=len(rows)<=1501:raise ResearchFailure('provider_page_invalid')
        stamps=[int(r['t']) for r in rows if isinstance(r,dict)]
        if not stamps or (cursor is not None and min(stamps)>=cursor):raise ResearchFailure('provider_cursor_invalid')
        cursor=min(stamps)
        all_rows.extend(rows)
    return validated_market(all_rows,now)

def ema(a,period):
    out=np.empty(len(a));out[0]=a[0];alpha=2/(period+1)
    for i in range(1,len(a)):out[i]=alpha*a[i]+(1-alpha)*out[i-1]
    return out

def standardize(train,whole):
    mean=train.mean(axis=0)
    dev=np.where(train.std(axis=0)>1e-9,train.std(axis=0),1)
    return np.clip((whole-mean)/dev,-5,5)

def kmeans(train,whole):
    rng=np.random.default_rng(20261118)
    centers=train[rng.choice(len(train),4,replace=False)].copy()
    for _ in range(35):
        labels=np.argmin(((train[:,None,:]-centers[None,:,:])**2).sum(axis=2),axis=1)
        new=centers.copy()
        for k in range(4):
            if np.any(labels==k):new[k]=train[labels==k].mean(axis=0)
        if np.max(np.abs(new-centers))<1e-7:break
        centers=new
    return np.argmin(((whole[:,None,:]-centers[None,:,:])**2).sum(axis=2),axis=1),centers.round(5).tolist()

def train_logistic(x,y):
    weights=np.zeros(x.shape[1]+1)
    if len(y)<80 or min(np.sum(y),np.sum(1-y))<10:raise ResearchFailure('class_imbalance')
    for j in range(230):
        pred=1/(1+np.exp(-np.clip(weights[0]+x@weights[1:],-22,22)))
        error=pred-y
        rate=.32/math.sqrt(1+j/35)
        weights[0]-=rate*error.mean()
        weights[1:]-=rate*(x.T@error/len(x)+.06*weights[1:])
    return weights

def model_predict(weights,x):
    return 1/(1+np.exp(-np.clip(weights[0]+x@weights[1:],-22,22)))

def summarize(daily):
    eq=peak=10000.;dd=pos=losses=wins=0.;n=0;returns=[]
    for rows in daily:
        gain=sum(rows);returns.append(gain);eq*=max(.001,1+gain)
        peak=max(peak,eq);dd=max(dd,1-eq/peak)
        for ret in rows:
            n+=1
            if ret>0:wins+=1;pos+=ret
            else:losses-=ret
    a=np.asarray(returns)
    std=float(np.std(a))
    return {'return_pct':round((eq/10000-1)*100,3),'max_drawdown_pct':round(dd*100,3),
            'sharpe_annualized':round(float(np.mean(a))/std*math.sqrt(365),3) if std else None,
            'decisions':n,'win_rate_pct':round(100*wins/n,2) if n else None,
            'profit_factor':round(pos/losses,3) if losses else None,'observed_days':len(daily)}

def build_research(markets,now):
    if set(markets)!=set(SYMBOLS):raise ResearchFailure('missing_market')
    first=max(int(markets[s][0,0]) for s in SYMBOLS)
    last=min(int(markets[s][-1,0]) for s in SYMBOLS)
    aligned={s:markets[s][(markets[s][:,0]>=first)&(markets[s][:,0]<=last)] for s in SYMBOLS}
    n=len(aligned['BTCUSDT'])
    if n<2400 or any(len(aligned[s])!=n or not np.array_equal(aligned[s][:,0],aligned['BTCUSDT'][:,0]) for s in SYMBOLS):
        raise ResearchFailure('alignment_error')
    train_end=int(n*.6);val_end=int(n*.8)
    if train_end-390<900 or val_end-train_end<300 or n-val_end<300:raise ResearchFailure('split_short')
    caches={}
    for s in SYMBOLS:
        b=aligned[s];c=b[:,4]
        caches[s]=(c,ema(c,20),ema(c,80),ema(c,200))
    records=[];raw_regime=[]
    for t in range(390,n-9,HORIZON):
        btc14=math.log(caches['BTCUSDT'][0][t]/caches['BTCUSDT'][0][t-84])
        for s in SYMBOLS:
            b=aligned[s];c,e20,e80,e200=caches[s]
            m14=math.log(c[t]/c[t-84]);m60=math.log(c[t]/c[t-360])
            direction=1 if m14>0 and m60>0 else -1 if m14<0 and m60<0 else 0
            vol=float(np.std(np.diff(np.log(c[t-59:t+1]))))*math.sqrt(6)
            vratio=b[t,5]/max(1.,float(b[t-59:t,5].mean()))
            features=[m14,m60,math.log(e20[t]/e80[t]),math.log(c[t]/e200[t]),
                      vol,math.log(max(vratio,1e-6)),(b[t,2]-b[t,3])/c[t],btc14]
            size=min(.25,.25*.025/max(.01,vol))
            net_signal=direction*(b[t+HORIZON+1,1]/b[t+1,1]-1)
            records.append((t,s,direction,size,net_signal,features))
            raw_regime.append((m14,vol,math.log(max(vratio,1e-6)),btc14))
    times=np.array([r[0] for r in records])
    train=(times+HORIZON+2<train_end);val=(times>=train_end)&(times+HORIZON+2<val_end);test=(times>=val_end)
    if sum(train)<1000 or sum(val)<200 or sum(test)<200:raise ResearchFailure('samples_short')
    raw=np.asarray(raw_regime,dtype=float)
    if not np.isfinite(raw).all():raise ResearchFailure('invalid_features')
    normalized=standardize(raw[train],raw)
    groups,centers=kmeans(normalized[train],normalized)
    features=np.hstack((np.asarray([r[5] for r in records]),np.eye(4)[groups]))
    features=standardize(features[train],features)
    sides=np.array([r[2] for r in records])
    labels=np.asarray([int(r[4]>2*FEE_PER_SIDE+FUNDING_PROXY) for r in records])
    eligible=train&(sides!=0)
    model=train_logistic(features[eligible],labels[eligible])
    prob=model_predict(model,features)
    def run(selection,threshold=0.,stress=1,delay=False,filtered=True):
        days={}
        for i,r in enumerate(records):
            if not selection[i]:continue
            t,s,side,size,ret,_=r
            if t not in days:days[t]=[]
            if side==0 or (filtered and prob[i]<threshold):continue
            if delay:
                a=aligned[s];ret=side*(a[t+HORIZON+2,1]/a[t+2,1]-1)
            cost=(2*FEE_PER_SIDE+FUNDING_PROXY)*stress
            days[t].append(size*(ret-cost))
        return summarize([days[t] for t in sorted(days)])
    original_val=run(val,filtered=False)
    base_test=run(test,filtered=False)
    candidates=[]
    for th in (.53,.57,.61,.65):
        m=run(val,th);cost2x=run(val,th,stress=2)
        candidates.append({'threshold':th,'validation':m,'validation_stress':cost2x})
    passed=[z for z in candidates if z['validation']['decisions']>=30 and
            z['validation']['return_pct']>original_val['return_pct'] and
            z['validation_stress']['return_pct']>0 and z['validation']['max_drawdown_pct']<=20]
    selected=max(passed,key=lambda x:x['validation_stress']['return_pct']) if passed else None
    threshold=selected['threshold'] if selected else .61
    holdout=run(test,threshold);holdout_stress=run(test,threshold,stress=2)
    delayed=run(test,threshold,delay=True)
    retrospective_pass=bool(selected and holdout['return_pct']>0 and
                           holdout['return_pct']>base_test['return_pct'] and
                           holdout_stress['return_pct']>0 and delayed['return_pct']>0)
    def describe(mask):
        choices=times[mask]
        return {'start_utc':datetime.fromtimestamp(first+int(choices[0])*FRAME,timezone.utc).strftime('%Y-%m-%d'),
                'end_utc':datetime.fromtimestamp(first+int(choices[-1])*FRAME,timezone.utc).strftime('%Y-%m-%d'),
                'observations':int(sum(mask))}
    digest=hashlib.sha256(b''.join(aligned[s].astype('<f8').tobytes() for s in SYMBOLS)).hexdigest()
    return {'ok':True,'schema':SCHEMA,'generated_utc':datetime.fromtimestamp(now,timezone.utc).isoformat(),
            'source':'gateio_usdt_perpetual_public_4h','data_sha256':digest,
            'data_period_utc':[datetime.fromtimestamp(first,timezone.utc).strftime('%Y-%m-%d'),
                               datetime.fromtimestamp(last,timezone.utc).strftime('%Y-%m-%d')],
            'aligned_bars_per_symbol':n,
            'method':{'baseline':'14_60_day_time_series_momentum',
                      'meta_model':'train_fitted_4_regimes_plus_regularized_logistic',
                      'entry':'next_4h_open','exit':'24h_later_open',
                      'single_source_market_data':True,'no_future_features':True,
                      'purged_horizon_bars':HORIZON+2,'validation_only_threshold':True,
                      'per_side_fee_slippage_fraction':FEE_PER_SIDE,
                      'adverse_funding_proxy_per_day':FUNDING_PROXY,'cost_2x':True,
                      'no_order_execution':True,'no_real_fills':True},
            'splits':{'train':describe(train),'validation':describe(val),'holdout':describe(test)},
            'regimes':{'regime_count':4,'train_fitted_centroids':centers},
            'validation_baseline':original_val,'validation_threshold_trials':candidates,
            'chosen_threshold':threshold,'validation_gate_passed':bool(selected),
            'holdout_baseline':base_test,'holdout_ai_filter':holdout,
            'holdout_cost_2x':holdout_stress,'holdout_one_bar_delay':delayed,
            'retrospective_gate_passed':retrospective_pass,
            'latest_regime_observations':{s:{'cluster':int(groups[max(i for i,r in enumerate(records) if r[1]==s)]),
                                           'research_only':True} for s in SYMBOLS},
            'limitations':['gate_only','futures_ohlcv','fixed_adverse_funding_proxy',
                           'no_orderbook_slippage','not_live_execution_parity','forward_unverified'],
            'live_approved':False,'paper_forward_verified':False,'order_execution':False,
            'promotion':'PROHIBITED_UNTIL_INDEPENDENT_FORWARD_AND_ADMIN_APPROVAL'}

def run_daily(now=None):
    now=int(now or time.time())
    return build_research({s:fetch_gate_4h(s,now) for s in SYMBOLS},now)

if __name__=='__main__':
    print(json.dumps(run_daily(),separators=(',',':')))