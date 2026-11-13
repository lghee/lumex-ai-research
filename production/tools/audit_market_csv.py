#!/usr/bin/env python3
"""Offline CSV diagnostics. Read-only; NEVER fabricate or write candle prices.

Example:
  python tools/audit_market_csv.py --input BTCUSDT:15=BTCUSDT_15.csv --input BTCUSDT:60=BTCUSDT_60.csv --output report.json
"""
from __future__ import annotations
import argparse,csv,json,math,sys
from datetime import datetime,timezone
from collections import defaultdict
from pathlib import Path

def iso(ms):
    return datetime.fromtimestamp(ms/1000,tz=timezone.utc).isoformat()

def audit(path,interval):
    with Path(path).open(newline='',encoding='utf-8-sig') as f:
        reader=csv.DictReader(f)
        if reader.fieldnames!=['timestamp','open','high','low','close','volume']:
            raise ValueError('bad_csv_header')
        rows=[];malformed=[];flat=[];gaps=[];unfinished=[];step=interval*60000
        prev=None
        clock_open=int(datetime.now(timezone.utc).timestamp()*1000)//step*step
        for line,r in enumerate(reader,start=2):
            try:
                ts=int(r['timestamp']);o,h,l,c,v=[float(r[k]) for k in ('open','high','low','close','volume')]
                if not all(math.isfinite(x) for x in (ts,o,h,l,c,v)) or ts%step or o<=0 or l<=0 or c<=0 or v<0 or h<max(o,l,c) or l>min(o,c):
                    malformed.append({'line':line,'timestamp':r['timestamp'],'reason':'invalid_ohlcv'});continue
                if prev is not None and ts-prev!=step:
                    gaps.append({'from':iso(prev),'to':iso(ts),'missing':max(0,(ts-prev)//step-1)})
                if ts>=clock_open:unfinished.append(iso(ts))
                if v==0 and o==h==l==c:
                    flat.append({'line':line,'time_utc':iso(ts),'timestamp':ts})
                rows.append((ts,o,h,l,c,v));prev=ts
            except (ValueError,TypeError,KeyError,OverflowError) as e:
                malformed.append({'line':line,'reason':type(e).__name__})
    needed=90*1440//interval+250
    return {'file':str(path),'interval_min':interval,'rows':len(rows),'minimum_rows':needed,
            'first_utc':iso(rows[0][0]) if rows else None,'last_utc':iso(rows[-1][0]) if rows else None,
            'zero_flat':flat,'gaps':gaps,'malformed':malformed,'unfinished':unfinished,
            'status':'PASS' if len(rows)>=needed and not (flat or gaps or malformed or unfinished) else 'REJECT',
            '_rows':rows}

def cross(a,b):
    groups=defaultdict(list)
    for r in a['15']['_rows']:groups[r[0]//3600000*3600000].append(r)
    failures=[];matched=0
    for t,o,h,l,c,v in b['60']['_rows']:
        items=groups.get(t,[])
        if len(items)!=4 or items[0][0]!=t or items[3][0]!=t+2700000:continue
        matched+=1
        expected=[o,h,l,c,v]
        actual=[items[0][1],max(x[2] for x in items),min(x[3] for x in items),items[-1][4],sum(x[5] for x in items)]
        if any(abs(x-y)>(max(1,y*.03) if i==4 else max(.5,y*.0005)) for i,(x,y) in enumerate(zip(actual,expected))):
            failures.append({'time_utc':iso(t),'hourly':expected,'from_15m':actual})
    return {'hours_compared':matched,'mismatch_count':len(failures),'mismatches':failures,
            'status':'PASS' if matched>=168 and not failures else 'REJECT'}

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--input',action='append',required=True,help='SYMBOL:INTERVAL=FILE.csv');ap.add_argument('--output')
    args=ap.parse_args();allm={}
    for spec in args.input:
        name,path=spec.split('=',1);symbol,interval=name.split(':');interval=int(interval)
        if interval not in (5,15,60):ap.error('unsupported interval')
        allm.setdefault(symbol,{})[str(interval)]=audit(path,interval)
    comparisons={}
    for symbol,m in allm.items():
        if '15' in m and '60' in m:comparisons[symbol]=cross(m,m)
    report={'markets':{symbol:{k:{kk:vv for kk,vv in d.items() if kk!='_rows'} for k,d in markets.items()}
                       for symbol,markets in allm.items()},'cross_frame':comparisons}
    body=json.dumps(report,ensure_ascii=False,indent=2)
    if args.output:Path(args.output).write_text(body+'\n',encoding='utf-8')
    print(body)
    return 1 if any(d['status']=='REJECT' for m in report['markets'].values() for d in m.values()) or any(c['status']=='REJECT' for c in comparisons.values()) else 0

if __name__=='__main__':sys.exit(main())
