#!/usr/bin/env python3
"""Read-only official Binance archive fetch; writes audit-verified local R2 import files.
NO orders, private keys, data interpolation, geoblocking bypass or synthetic candles.
Run with --out <dir>. Upload only if exit 0 and log says all 8 markets verified.
"""
import argparse, csv, datetime as dt, hashlib, io, json, pathlib, time, urllib.request, zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed

UTC=dt.timezone.utc
SYMBOLS=('BTC','ETH','SOL','XRP')
MARKETS={'spot':'spot','um-futures':'futures/um'}
HOUR=3600_000
ROOT='https://data.binance.vision/data/'
MAX_ZIP=14*1024*1024
NOW=dt.datetime.now(UTC)
def ts_ms(raw):
    x=int(str(raw).strip())
    return x//1000 if x>=100_000_000_000_000 else x
def month_range(start,end):
    x=dt.date(start.year,start.month,1)
    while x<=end:
        yield x
        x=dt.date(x.year+1,1,1) if x.month==12 else dt.date(x.year,x.month+1,1)
def specs(symbol,market,first,last_day):
    prefix=MARKETS[market];base=symbol+'USDT'
    months=list(month_range(first,last_day))
    for m in months:
        if m.year==last_day.year and m.month==last_day.month:
            d=max(first,m)
            while d<=last_day:
                suffix=d.strftime('%Y-%m-%d')
                uri=f'{ROOT}{prefix}/daily/klines/{base}/1h/{base}-1h-{suffix}.zip'
                yield uri
                d+=dt.timedelta(days=1)
        else:
            suffix=m.strftime('%Y-%m')
            yield f'{ROOT}{prefix}/monthly/klines/{base}/1h/{base}-1h-{suffix}.zip'
def download(url):
    # No user-supplied URL; pinned HTTPS public archive hostname.
    if not url.startswith(ROOT):raise ValueError('unapproved archive url')
    for attempt in range(3):
        try:
            req=urllib.request.Request(url,headers={'User-Agent':'LUMEX-archive-verify/1.0','Accept':'application/zip'})
            with urllib.request.urlopen(req,timeout=15) as r:
                length=int(r.headers.get('Content-Length') or 0)
                if length>MAX_ZIP:raise ValueError('archive oversized')
                payload=r.read(MAX_ZIP+1)
                if len(payload)>MAX_ZIP:raise ValueError('archive oversized')
                if len(payload)<100:raise ValueError('archive too short')
                return payload
        except Exception:
            if attempt==2:raise
            time.sleep(1+attempt)
def read_archive(data,url,first_ms,end_ms):
    buf=io.BytesIO(data)
    if not zipfile.is_zipfile(buf):raise ValueError('zip not valid '+url)
    records={}
    with zipfile.ZipFile(buf) as z:
        members=[x for x in z.infolist() if x.filename.endswith('.csv') and not x.is_dir()]
        if len(members)!=1:raise ValueError('unexpected zip member count '+url)
        info=members[0]
        if info.file_size>4*1024*1024:raise ValueError('uncompressed CSV oversized '+url)
        content=z.read(info)
        if len(content)>4*1024*1024:raise ValueError('CSV oversized '+url)
        for row in csv.reader(io.StringIO(content.decode('utf-8-sig'))):
            if not row or row[0].strip().lower() in ('open time','open_time'):continue
            if len(row)<11:raise ValueError('too few kline columns '+url)
            t=ts_ms(row[0])
            if t<first_ms or t>end_ms:continue
            if t%HOUR:raise ValueError('off-hour candle in '+url)
            from decimal import Decimal
            p=float(Decimal(row[4]))
            quote=float(Decimal(row[7]))
            trades=int(row[8])
            buy=float(Decimal(row[10]))
            if not (0<p<1e12 and quote>=0 and trades>=0 and 0<=buy<=quote+max(1e-7,quote*1e-8)):
                raise ValueError('invalid trade values in '+url)
            if (trades==0 and (quote!=0 or buy!=0)) or (trades>0 and quote<=0):
                raise ValueError('trade count mismatch in '+url)
            record=[t,p,quote,trades,buy]
            if t in records and records[t]!=record:raise ValueError('duplicate conflicting bar '+url)
            records[t]=record
    return records
def build(symbol,market,first,last_day,now,out):
    urls=list(specs(symbol,market,first,last_day))
    first_ms=int(dt.datetime.combine(first,dt.time.min,tzinfo=UTC).timestamp()*1000)
    last_ms=int(dt.datetime.combine(last_day,dt.time.max,tzinfo=UTC).timestamp()*1000)
    rows={}
    origins=[]
    for url in urls:
        data=download(url)
        collected=read_archive(data,url,first_ms,last_ms)
        for t,row in collected.items():
            if t in rows and rows[t]!=row:raise ValueError('conflicting archives '+url)
            rows[t]=row
        origins.append({'file':url.rsplit('/',1)[-1],'sha256_zip':hashlib.sha256(data).hexdigest()})
    ordered=[rows[t] for t in sorted(rows)]
    if len(ordered)<2160:raise ValueError(f'insufficient 90day rows {symbol} {market}: {len(ordered)}')
    # No filling absent hours: exact continuous coverage required for every source.
    for i in range(1,len(ordered)):
        if ordered[i][0]-ordered[i-1][0]!=HOUR:
            raise ValueError(f'gap at {ordered[i][0]} for {symbol} {market}')
    latest=ordered[-1][0]
    if int(now.timestamp()*1000)-latest>48*HOUR:
        raise ValueError(f'archive too stale {symbol} {market}')
    serial=json.dumps(ordered,separators=(',',':'),ensure_ascii=False).encode()
    doc={'schema':'lumex_flow_hourly_v1','symbol':symbol+'USDT','market':market,
      'origin':'official_binance_public_1h_klines','unit':'USDT_quote','bar_ms':HOUR,
      'filled_missing_hours':False,'synthetic_values':False,'count':len(ordered),
      'start_ms':ordered[0][0],'end_ms':latest,'created_at_ms':int(now.timestamp()*1000),
      'sha256_csv':hashlib.sha256(serial).hexdigest(),'sources':origins,'rows':ordered}
    file=out/(symbol+'-'+market+'.json')
    file.write_text(json.dumps(doc,separators=(',',':'),ensure_ascii=False))
    return {'symbol':symbol,'market':market,'hours':len(ordered),'latest_ms':latest,
      'file':str(file),'bytes':file.stat().st_size,'source_archives':len(origins)}
def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--out',required=True)
    args=ap.parse_args()
    now=dt.datetime.now(UTC)
    out=pathlib.Path(args.out);out.mkdir(parents=True,exist_ok=True)
    last_day=now.date()-dt.timedelta(days=1)
    first=now.date()-dt.timedelta(days=93)
    completed=[];errors=[]
    with ThreadPoolExecutor(max_workers=4) as pool:
        jobs={pool.submit(build,s,m,first,last_day,now,out):(s,m) for s in SYMBOLS for m in MARKETS}
        for task in as_completed(jobs):
            s,m=jobs[task]
            try:
                result=task.result()
                if result['bytes']>520000:raise ValueError('archive exceeds Worker size limit')
                completed.append(result);print('VERIFIED',s,m,result['hours'],flush=True)
            except Exception as e:
                errors.append({'symbol':s,'market':m,'error':type(e).__name__+': '+str(e)[:130]})
                print('FAILED',s,m,type(e).__name__,flush=True)
    manifest={'schema':'lumex_flow_archive_import_manifest_v1','ok':not errors and len(completed)==8,
     'generated_at':now.isoformat(),'validated_sources':completed,'errors':errors}
    (out/'manifest.json').write_text(json.dumps(manifest,indent=2,ensure_ascii=False))
    if not manifest['ok']:
        # No accidental partial upload when any one of 8 markets failed.
        for f in out.glob('*.json'):
            if f.name!='manifest.json':f.unlink()
        raise SystemExit('ARCHIVE IMPORT DENIED: 8/8 markets with 90d continuity required')
    print('PASS_ALL_EIGHT_SOURCE_MARKETS',flush=True)
if __name__=='__main__':main()
