#!/usr/bin/env python3
"""Check frozen exploratory candidates on NEW, previously unexamined 2022-24
Gate USDT perpetual historical bars. No optimization on this older window.
This is cross-regime retrospective evidence, not future out-of-sample.
"""
from __future__ import annotations
import concurrent.futures,datetime as dt,hashlib,json,os,urllib.request,urllib.parse
from pathlib import Path
import numpy as np
from independent_ai_research_20261118 import ASSETS,FRAME,NOW
from independent_holding_cost_study_20261118 import ROOT,prepare,experiment

HISTORY_END=1730188800 # 2024-10-29 UTC open, exclusive
CANDIDATES=(
 ("MOM14_60",3),
 ("BREAKOUT55_EXIT20",3),
 ("EMA20_80_200",3),
 ("MOM14_60",7),
 ("BREAKOUT120_EXIT40",1),
 ("BTC_HOLD_PERPETUAL",1)
)

def fetch_old(symbol):
    before=HISTORY_END
    d={}
    for page in range(3):
        q={'contract':symbol+'_USDT','interval':'4h','limit':1500,'to':str(before)}
        url='https://api.gateio.ws/api/v4/futures/usdt/candlesticks?'+urllib.parse.urlencode(q)
        req=urllib.request.Request(url,headers={'accept':'application/json',
            'user-agent':'LUMEX-Isolated-Robustness-Study/1.0'})
        with urllib.request.urlopen(req,timeout=30) as res:raw=res.read(350001)
        if len(raw)>350000:raise RuntimeError('historical_payload_too_large')
        values=json.loads(raw)
        if not isinstance(values,list) or len(values)<1300:raise RuntimeError('short_historical_response')
        before=min(int(z['t']) for z in values)
        for x in values:
            t=int(x['t'])
            if t>=HISTORY_END:continue
            o,h,l,c,v=(float(x[k]) for k in ('o','h','l','c','v'))
            if not np.isfinite([o,h,l,c,v]).all():raise RuntimeError('nonfinite')
            if o==h==l==c and v==0:continue
            if t%FRAME or o<=0 or l<=0 or v<=0 or h<max(o,c,l) or l>min(o,c):raise RuntimeError('bad_ohlcv')
            item=(t,o,h,l,c,v)
            if t in d and d[t]!=item:raise RuntimeError('duplicate_conflict')
            d[t]=item
    arr=np.asarray([d[t] for t in sorted(d)],dtype=float)
    if len(arr)<4000 or np.any(np.diff(arr[:,0])!=FRAME):raise RuntimeError('incomplete_historical_source')
    return arr

def run():
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
        tasks={a:ex.submit(fetch_old,a) for a in ASSETS}
        source={a:tasks[a].result() for a in ASSETS}
    first=max(int(a[0,0]) for a in source.values())
    last=min(int(a[-1,0]) for a in source.values())
    market={a:v[(v[:,0]>=first)&(v[:,0]<=last)] for a,v in source.items()}
    n=len(market['BTC'])
    if n<3900 or any(len(v)!=n or not np.array_equal(v[:,0],market['BTC'][:,0]) for v in market.values()):
        raise RuntimeError('old_data_alignment_failed')
    d=prepare(market)
    # All model parameters remain frozen from the later-period study.
    # Only previously unseen older periods are tested; no selection.
    segments=[(700,1550),(1550,2450),(2450,3350),(3350,n)]
    results={}
    for family,gap in CANDIDATES:
        name=f'{family}_{gap}d'
        per=[]
        for begin,end in segments:
            a=experiment(d,family,begin,end,gap)
            stress=experiment(d,family,begin,end,gap,cost_mult=2.)
            delay=experiment(d,family,begin,end,gap,delay=True)
            per.append({'from':dt.datetime.fromtimestamp(first+begin*FRAME,dt.timezone.utc).strftime('%Y-%m-%d'),
                        'to':dt.datetime.fromtimestamp(first+(min(n-1,end-1))*FRAME,dt.timezone.utc).strftime('%Y-%m-%d'),
                        'base':a,'double_cost':stress,'entry_delay':delay})
        results[name]={'segments':per,
                       'positive_segments':sum(x['base']['return_pct']>0 for x in per),
                       'stress_positive_segments':sum(x['double_cost']['return_pct']>0 for x in per)}
    checksum=hashlib.sha256(b''.join(market[a].astype('<f8').tobytes() for a in ASSETS)).hexdigest()
    report={'schema':'lumex_independent_older_regime_robustness_v1','source':'Gate official USDT perpetual 4h',
        'older_source_sha256':checksum,
        'purpose':'Unseen earlier historical years for fixed recently discovered candidates, never treated as future forward data',
        'data_start':dt.datetime.fromtimestamp(first,dt.timezone.utc).strftime('%Y-%m-%d'),
        'data_end':dt.datetime.fromtimestamp(last,dt.timezone.utc).strftime('%Y-%m-%d'),
        'bars_per_coin':n,'symbol_count':len(ASSETS),
        'fixed_exploratory_models':results,
        'live_approved':False,'admin_modified':False,'no_model_tuning_on_older_data':True}
    ROOT.mkdir(parents=True,exist_ok=True)
    (ROOT/'older_regime_robustness.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print('LUMEX_OLDER_REGIME_ROBUSTNESS '+json.dumps({
        'first':report['data_start'],'last':report['data_end'],
        'bars':n,'source_hash':checksum,
        'results':{k:{'returns':[p['base']['return_pct'] for p in v['segments']],
                      'cost2_returns':[p['double_cost']['return_pct'] for p in v['segments']],
                      'delay_returns':[p['entry_delay']['return_pct'] for p in v['segments']],
                      'positive_segments':v['positive_segments'],
                      'stress_positive_segments':v['stress_positive_segments']} for k,v in results.items()}
    },separators=(',',':')))

if __name__=='__main__':run()
