#!/usr/bin/env python3
"""LUMEX research-only worker. No exchange credentials and no order endpoints.

Run via cron on an isolated VPS (one invocation does bounded work). Python 3.10+, NumPy.
REST authentication: Authorization Bearer, never query-string secrets.
"""
from __future__ import annotations
import argparse
import csv
import hashlib
import json
import os
import sys
import time
import math
import random
import urllib.request
import urllib.parse
import urllib.error
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np

BASE = "https://api.bybit.com/v5/market/kline"
BINANCE_FUTURES_BASE = "https://fapi.binance.com/fapi/v1/klines"
GATE_FUTURES_BASE = "https://api.gateio.ws/api/v4/futures/usdt/candlesticks"
MARKET_SOURCES = {"bybit_public_linear", "binance_usdm_perpetual", "gateio_usdt_perpetual"}
SUPPORTED = {"BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"}
FRAMES = {5, 15, 60}
USER_AGENT = "LUMEX-AI-Research-Worker/1.0 (read-only; no trading)"

class ResearchError(Exception): pass

# Gate history at page boundaries has produced zero-volume, flat-price
# rows in live BTC data. A time-contiguous CSV is therefore NOT enough.
# These rows are quarantined and independently re-queried, never invented.
def suspect_candle(record) -> bool:
    return (float(record[5]) == 0.0 and
            float(record[1]) == float(record[2]) == float(record[3]) == float(record[4]))


def validate_bar(record, interval: int) -> None:
    step = interval * 60_000
    ts = int(record[0]); o,h,l,c,v = map(float, record[1:6])
    if (not all(math.isfinite(float(x)) for x in record) or
        ts % step or o <= 0 or c <= 0 or l <= 0 or v < 0 or
        h < max(o,c,l) or l > min(o,c)):
        raise ResearchError('invalid_ohlcv')
    if suspect_candle(record):
        raise ResearchError('unverified_zero_flat_candle')

def http_json(url: str, method: str = "GET", data: Any = None, bearer: str = "", timeout: int = 25) -> Any:
    body = json.dumps(data, separators=(",", ":")).encode() if data is not None else None
    headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    if body is not None: headers["Content-Type"] = "application/json"
    if bearer: headers["Authorization"] = "Bearer " + bearer
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read(1_800_001)
        if len(data)>1_800_000: raise ResearchError("response_too_large")
        return json.loads(data)

class Client:
    def __init__(self, host: str, token: str):
        if not host.startswith("https://") or not token or len(token)<48:
            raise ResearchError("https_host_and_worker_secret_required")
        self.base = host.rstrip("/") + "/wp-json/lumex/v1/research-lab/"
        self.token = token
    def get(self, name: str, **query: str):
        suffix = "?" + urllib.parse.urlencode(query) if query else ""
        return http_json(self.base + name + suffix, bearer=self.token)
    def post(self, name: str, body: dict):
        return http_json(self.base + name, "POST", body, self.token)

def load_csv(path: Path, interval: int, require_fresh: bool = True, min_history_days: int = 90, keep_all: bool = False) -> np.ndarray:
    if not path.is_file(): raise ResearchError("file_missing")
    step = interval * 60_000
    expected = ["timestamp", "open", "high", "low", "close", "volume"]
    rows=[];prior=0
    with path.open(newline="", encoding="utf-8-sig") as f:
        reader=csv.reader(f)
        if next(reader, None)!=expected: raise ResearchError("bad_csv_header")
        for row in reader:
            if len(row)!=6:raise ResearchError("invalid_row")
            try:
                record=[float(x) for x in row]
            except ValueError as exc:raise ResearchError("bad_numeric") from exc
            if not all(math.isfinite(x) for x in record):raise ResearchError("nonfinite")
            ts=int(record[0]);o,h,l,c,v=record[1:]
            if ts%step or (prior and ts-prior!=step): raise ResearchError("gap_or_duplicate")
            validate_bar(record, interval)
            prior=ts; rows.append(record)
    if not rows:raise ResearchError("empty_file")
    last=rows[-1][0]
    current_open = (int(time.time()*1000)//step)*step
    if last >= current_open:raise ResearchError("unfinished_candle")
    if require_fresh and time.time()*1000-last>max(3*step,3_600_000):raise ResearchError("stale_candles")
    needed=int(min_history_days*1440/interval)+250
    if len(rows)<needed:raise ResearchError("less_than_required_days_and_warmup")
    return np.array(rows if keep_all else rows[-needed:], dtype=np.float64)

def fetch_bybit_candles(symbol: str, interval: int, out: Path, days: int = 92) -> int:
    if symbol not in SUPPORTED or interval not in FRAMES:raise ResearchError("invalid_selection")
    if days<90 or days>120:raise ResearchError("invalid_days")
    step=interval*60_000
    now=int(time.time()*1000)
    end=(now//step)*step-1  # never request unfinished candle
    start=end-(days*86_400_000)-250*step
    found: dict[int, tuple] = {}
    calls=0
    while end>=start:
        params={"category":"linear","symbol":symbol,"interval":str(interval),"end":str(end),"limit":"1000"}
        url=BASE+"?"+urllib.parse.urlencode(params)
        raw=http_json(url,timeout=20)
        if raw.get("retCode")!=0 or not isinstance(raw.get("result",{}).get("list"),list):raise ResearchError("bybit_unavailable_or_rate_limited")
        block=raw["result"]["list"]
        if not block:break
        earliest=None
        for row in block:
            if len(row)<6:raise ResearchError("bybit_bad_schema")
            record=(int(row[0]),float(row[1]),float(row[2]),float(row[3]),float(row[4]),float(row[5]))
            if earliest is None or record[0]<earliest:earliest=record[0]
            if record[0]<start or record[0]>now-step:continue
            prev=found.get(record[0])
            if prev is not None and prev!=record:raise ResearchError("conflicting_candle")
            found[record[0]]=record
        if earliest is None:break
        next_end=earliest-1
        if next_end>=end:raise ResearchError("pagination_stuck")
        end=next_end;calls+=1
        if calls>180:raise ResearchError("too_many_provider_pages")
        time.sleep(0.08)
    if not found:raise ResearchError("no_market_candles")
    ordered=[found[k] for k in sorted(found)]
    # Validation BEFORE replacing a known-good file, rejecting missing and incomplete data.
    t=[x[0] for x in ordered]
    if any(b-a!=step for a,b in zip(t,t[1:])):raise ResearchError("provider_gaps")
    if len(ordered)<90*1440/interval+250:raise ResearchError("insufficient_provider_history")
    if time.time()*1000-ordered[-1][0]>max(3*step,3_600_000):raise ResearchError("provider_stale")
    out.parent.mkdir(parents=True,exist_ok=True)
    tmp=out.with_suffix(out.suffix+".tmp")
    with tmp.open("w",encoding="utf-8",newline="") as f:
        wr=csv.writer(f);wr.writerow(["timestamp","open","high","low","close","volume"])
        for r in ordered:wr.writerow(r)
    load_csv(tmp,interval,True)
    tmp.replace(out)
    return len(ordered)

def refresh_bybit_candles(symbol: str, interval: int, out: Path, previous: Path | None = None) -> int:
    """Refresh a complete historical cache with only recent *closed* bars when possible.

    The old R2 CSV is never modified. Validation and atomic replacement of the
    local temporary file happen before the response can replace an R2 object.
    A missing, corrupt or very old cache is rebuilt from the full provider API.
    """
    if symbol not in SUPPORTED or interval not in FRAMES:raise ResearchError("invalid_selection")
    if previous is None or not previous.is_file():return fetch_bybit_candles(symbol,interval,out)
    try:
        old=load_csv(previous,interval,require_fresh=False)
    except (ResearchError,ValueError,OSError):
        return fetch_bybit_candles(symbol,interval,out)
    step=interval*60_000
    latest=(int(time.time()*1000)//step-1)*step
    last=int(old[-1,0])
    missing=max(0,(latest-last)//step)
    if missing>900:return fetch_bybit_candles(symbol,interval,out)
    if missing>0:
        params={"category":"linear","symbol":symbol,"interval":str(interval),"end":str(latest+step-1),"limit":str(min(1000,missing+6))}
        raw=http_json(BASE+"?"+urllib.parse.urlencode(params),timeout=25)
        if raw.get("retCode")!=0 or not isinstance(raw.get("result",{}).get("list"),list):
            raise ResearchError("bybit_incremental_unavailable")
        points={}
        for row in raw["result"]["list"]:
            if len(row)<6:raise ResearchError("bybit_bad_schema")
            r=(int(row[0]),float(row[1]),float(row[2]),float(row[3]),float(row[4]),float(row[5]))
            if r[0]>latest or r[0]<last:continue
            if r[0] in points and points[r[0]]!=r:raise ResearchError("conflicting_provider_candle")
            points[r[0]]=r
        if last in points and not np.allclose(old[-1],points[last],rtol=1e-9,atol=1e-8):
            raise ResearchError("provider_revised_closed_candle")
        appended=[points[ts] for ts in sorted(points) if ts>last]
        if not appended or appended[0][0]!=last+step or any(b[0]-a[0]!=step for a,b in zip(appended,appended[1:])):
            raise ResearchError("incremental_provider_gap")
        old=np.concatenate((old,np.asarray(appended,dtype=np.float64)),axis=0)
    needed=int(90*1440/interval)+250
    old=old[-needed:]
    out.parent.mkdir(parents=True,exist_ok=True)
    tmp=out.with_suffix(out.suffix+".tmp")
    with tmp.open("w",encoding="utf-8",newline="") as f:
        writer=csv.writer(f);writer.writerow(["timestamp","open","high","low","close","volume"])
        for row in old:
            writer.writerow([int(row[0]),*row[1:].tolist()])
    load_csv(tmp,interval,require_fresh=True)
    tmp.replace(out)
    return len(old)

def fetch_binance_futures_candles(symbol: str, interval: int, out: Path, days: int = 92) -> int:
    """Backfill authorized public Binance USD-M perpetual trades, not Binance spot.

    This is a **full** coherent history: never concatenate exchange candles.
    The same 90-day + warm-up validation used for Bybit remains mandatory.
    """
    if symbol not in SUPPORTED or interval not in FRAMES: raise ResearchError("invalid_selection")
    if days < 90 or days > 120: raise ResearchError("invalid_days")
    step = interval * 60_000
    latest = (int(time.time()*1000)//step - 1)*step
    cursor = ((latest - days*86_400_000 - 250*step)//step)*step
    found = {}
    calls = 0
    unit = {5:"5m", 15:"15m", 60:"1h"}[interval]
    while cursor <= latest:
        params = {"symbol":symbol,"interval":unit,"startTime":str(cursor),
                  "endTime":str(latest+step-1),"limit":"1500"}
        raw = http_json(BINANCE_FUTURES_BASE+"?"+urllib.parse.urlencode(params),timeout=25)
        if not isinstance(raw,list) or not raw: raise ResearchError("binance_futures_empty_or_invalid")
        last_ts = None
        for row in raw:
            if not isinstance(row,list) or len(row)<6:raise ResearchError("binance_futures_bad_schema")
            record = (int(row[0]),float(row[1]),float(row[2]),float(row[3]),float(row[4]),float(row[5]))
            ts = record[0]
            if last_ts is not None and ts<=last_ts:raise ResearchError("binance_futures_order_invalid")
            last_ts = ts
            if ts<cursor or ts>latest:continue
            if ts in found and found[ts]!=record:raise ResearchError("conflicting_candle")
            found[ts]=record
        if last_ts is None or last_ts<cursor:raise ResearchError("binance_futures_pagination_stuck")
        cursor = last_ts+step
        calls += 1
        if calls>180:raise ResearchError("too_many_provider_pages")
        if cursor<=latest:time.sleep(0.08)
    if not found:raise ResearchError("no_market_candles")
    ordered=[found[k] for k in sorted(found)]
    if any(b[0]-a[0]!=step for a,b in zip(ordered,ordered[1:])):raise ResearchError("provider_gaps")
    if len(ordered)<90*1440/interval+250:raise ResearchError("insufficient_provider_history")
    if time.time()*1000-ordered[-1][0]>max(3*step,3_600_000):raise ResearchError("provider_stale")
    out.parent.mkdir(parents=True,exist_ok=True)
    tmp=out.with_suffix(out.suffix+".tmp")
    with tmp.open("w",newline="",encoding="utf-8") as file:
        writer=csv.writer(file);writer.writerow(["timestamp","open","high","low","close","volume"])
        writer.writerows(ordered)
    load_csv(tmp,interval,True)
    tmp.replace(out)
    return len(ordered)


def refresh_binance_futures_candles(symbol: str, interval: int, out: Path, previous: Path | None = None) -> int:
    """Incrementally update a Binance-only candle history with closed bars."""
    if symbol not in SUPPORTED or interval not in FRAMES:raise ResearchError("invalid_selection")
    if previous is None or not previous.is_file():return fetch_binance_futures_candles(symbol,interval,out)
    try:old=load_csv(previous,interval,require_fresh=False)
    except (ResearchError,ValueError,OSError):return fetch_binance_futures_candles(symbol,interval,out)
    step=interval*60_000
    latest=(int(time.time()*1000)//step-1)*step
    last=int(old[-1,0]); missing=max(0,(latest-last)//step)
    if missing>900:return fetch_binance_futures_candles(symbol,interval,out)
    if missing>0:
        params={"symbol":symbol,"interval":{5:"5m",15:"15m",60:"1h"}[interval],
                "startTime":str(last),"endTime":str(latest+step-1),"limit":str(min(1500,missing+2))}
        raw=http_json(BINANCE_FUTURES_BASE+"?"+urllib.parse.urlencode(params),timeout=25)
        if not isinstance(raw,list):raise ResearchError("binance_incremental_unavailable")
        points={}
        for row in raw:
            if not isinstance(row,list) or len(row)<6:raise ResearchError("binance_futures_bad_schema")
            r=(int(row[0]),float(row[1]),float(row[2]),float(row[3]),float(row[4]),float(row[5]))
            if r[0]>latest or r[0]<last:continue
            if r[0] in points and points[r[0]]!=r:raise ResearchError("conflicting_provider_candle")
            points[r[0]]=r
        # Overlap is optional. If the exchange supplies it, validate it exactly.
        if last in points and not np.allclose(old[-1],points[last],rtol=1e-9,atol=1e-8):
            raise ResearchError("provider_revised_closed_candle")
        appended=[points[t] for t in sorted(points) if t>last]
        if not appended or appended[0][0]!=last+step or any(b[0]-a[0]!=step for a,b in zip(appended,appended[1:])):
            raise ResearchError("incremental_provider_gap")
        old=np.concatenate((old,np.asarray(appended,dtype=np.float64)),axis=0)
    needed=int(90*1440/interval)+250
    old=old[-needed:]
    out.parent.mkdir(parents=True,exist_ok=True)
    tmp=out.with_suffix(out.suffix+".tmp")
    with tmp.open("w",newline="",encoding="utf-8") as file:
        writer=csv.writer(file);writer.writerow(["timestamp","open","high","low","close","volume"])
        for row in old:writer.writerow([int(row[0]),*row[1:].tolist()])
    load_csv(tmp,interval,require_fresh=True)
    tmp.replace(out)
    return len(old)


def gate_window(symbol: str, interval: int, first: int, last: int) -> dict[int, tuple]:
    """Ask Gate for a bounded range, rejecting any malformed OHLCV payload.

    Never use 'limit' with from/to (officially mutually exclusive).
    Overlap/rescue probes use the same public, read-only endpoint.
    """
    step = interval * 60_000
    if last < first or (last-first)//step >= 2000:
        raise ResearchError('gate_invalid_request_window')
    params = {'contract': symbol[:-4]+'_USDT',
              'interval': {5:'5m',15:'15m',60:'1h'}[interval],
              'from': str(first//1000), 'to': str(last//1000)}
    raw = http_json(GATE_FUTURES_BASE+'?'+urllib.parse.urlencode(params), timeout=25)
    if not isinstance(raw, list) or not raw:
        raise ResearchError('gate_futures_empty_or_invalid')
    records = {}
    for item in raw:
        if not isinstance(item,dict) or not all(k in item for k in ('t','o','h','l','c','v')):
            raise ResearchError('gate_futures_bad_schema')
        try:
            record = (int(item['t'])*1000,float(item['o']),float(item['h']),
                      float(item['l']),float(item['c']),float(item['v']))
        except (ValueError, TypeError, OverflowError) as exc:
            raise ResearchError('gate_futures_bad_numeric') from exc
        ts = record[0]
        if ts < first or ts > last:
            continue
        if (not all(math.isfinite(v) for v in record) or ts%step or
            record[1]<=0 or record[4]<=0 or record[3]<=0 or record[5]<0 or
            record[2]<max(record[1],record[3],record[4]) or record[3]>min(record[1],record[4])):
            raise ResearchError('gate_futures_invalid_ohlcv')
        if ts in records and records[ts] != record:
            raise ResearchError('gate_conflicting_provider_candle')
        records[ts] = record
    return records


def merge_gate_record(target: dict[int,tuple], incoming: dict[int,tuple]) -> None:
    """Allow an independently fetched real bar to replace a flat-zero placeholder."""
    for ts, bar in incoming.items():
        old = target.get(ts)
        if old is None or old == bar:
            target[ts] = bar
        elif suspect_candle(old) and not suspect_candle(bar):
            target[ts] = bar
        elif suspect_candle(bar) and not suspect_candle(old):
            pass
        else:
            # A provider must not silently rewrite already closed good bars.
            raise ResearchError('gate_conflicting_provider_candle')


def repair_gate_range(symbol: str, interval: int, records: dict[int,tuple],
                      first: int, latest: int) -> None:
    """Retry suspected placeholders/missing bars with shorter, overlapping windows.

    Do not synthesize prices, use a second exchange, or silently retain gaps.
    Limit probes to protect the provider and bound Container execution.
    """
    step = interval * 60_000
    missing = [ts for ts in range(first, latest+step, step) if ts not in records]
    suspect = [ts for ts,bar in records.items() if first<=ts<=latest and suspect_candle(bar)]
    targets = sorted(set(missing + suspect))
    if len(targets) > 24:
        raise ResearchError('gate_history_too_many_unverified_bars')
    for ts in targets:
        start = max(first, ts-3*step)
        # A right-hand buffer prevents page-end artificial final bars.
        end = min((int(time.time()*1000)//step)*step, ts+3*step)
        if end <= ts:
            end = ts+step
        try:
            fresh = gate_window(symbol,interval,start,end)
        except (ResearchError, urllib.error.URLError, TimeoutError) as exc:
            raise ResearchError('gate_repair_query_failed') from exc
        bar = fresh.get(ts)
        if bar is None or suspect_candle(bar):
            raise ResearchError('gate_unverified_bar_at_'+str(ts))
        merge_gate_record(records, {ts:bar})
    if any(ts not in records or suspect_candle(records[ts])
           for ts in range(first, latest+step, step)):
        raise ResearchError('gate_unresolved_candle_gap')

def fetch_gate_futures_candles(symbol: str, interval: int, out: Path, days: int = 92) -> int:
    """Full, contiguous OHLCV history from Gate USDT perpetual futures.

    Gate responds with UTC **seconds** and volume in contract units; those volumes
    must never be joined with Binance or Bybit base-asset quantities. Page by
    from/to time (not `limit`, which is mutually exclusive per official docs).
    """
    if symbol not in SUPPORTED or interval not in FRAMES:raise ResearchError("invalid_selection")
    # Gate can return only the most recent ~10,000 bars: 5m needs a 30d
    # rolling bootstrap (then gradual accumulation) and is NOT 90d research-ready.
    if interval==5: days=32
    if interval==60: days=180
    if days < 30 or days > 200:raise ResearchError("invalid_days")
    step=interval*60_000
    latest=(int(time.time()*1000)//step-1)*step
    cursor=((latest-days*86_400_000-250*step)//step)*step
    first=cursor
    found={};calls=0
    while cursor<=latest:
        # 1,999 points per page; overlap 3 points to verify artificial
        # page-end candles independently against the next page.
        end=min(latest,cursor+1998*step)
        records=gate_window(symbol,interval,cursor,end)
        merge_gate_record(found,records)
        calls+=1
        if calls>100:raise ResearchError('too_many_provider_pages')
        if end>=latest:break
        cursor=end-2*step
        time.sleep(.08)
    repair_gate_range(symbol,interval,found,first,latest)
    if not found:raise ResearchError('no_market_candles')
    ordered=[found[t] for t in sorted(found)]
    if any(b[0]-a[0]!=step for a,b in zip(ordered,ordered[1:])):
        raise ResearchError('provider_gaps')
    if len(ordered)<(30 if interval==5 else 90)*1440/interval+250:raise ResearchError('insufficient_provider_history')
    if time.time()*1000-ordered[-1][0]>max(3*step,3_600_000):raise ResearchError('provider_stale')
    out.parent.mkdir(parents=True,exist_ok=True)
    tmp=out.with_suffix(out.suffix+'.tmp')
    with tmp.open('w',encoding='utf-8',newline='') as file:
        writer=csv.writer(file);writer.writerow(['timestamp','open','high','low','close','volume'])
        writer.writerows(ordered)
    load_csv(tmp,interval,True,min_history_days=(30 if interval==5 else (180 if interval==60 else 90)))
    tmp.replace(out)
    return len(ordered)


def refresh_gate_futures_candles(symbol: str, interval: int, out: Path, previous: Path | None = None) -> int:
    """Same-source incremental refresh; full re-backfill if cache isn't usable."""
    if symbol not in SUPPORTED or interval not in FRAMES:raise ResearchError('invalid_selection')
    if previous is None or not previous.is_file():return fetch_gate_futures_candles(symbol,interval,out)
    try:old=load_csv(previous,interval,require_fresh=False,min_history_days=(30 if interval==5 else 90),keep_all=True)
    except (ResearchError,ValueError,OSError):return fetch_gate_futures_candles(symbol,interval,out)
    if interval==60 and old.shape[0] < 180*24+250:
        return fetch_gate_futures_candles(symbol,interval,out)
    step=interval*60000
    latest=(int(time.time()*1000)//step-1)*step
    last=int(old[-1,0]); missing=max(0,(latest-last)//step)
    if missing>900:return fetch_gate_futures_candles(symbol,interval,out)
    if missing>0:
        # Overlap 3 previously closed bars. If provider revises an older good
        # candle, fail closed; do not mask with an invented zero-volume row.
        start=max(int(old[0,0]),last-3*step)
        points=gate_window(symbol,interval,start,latest)
        for ts in sorted(points):
            if ts<=last:
                old_row=old[int((ts-int(old[0,0]))//step)]
                if suspect_candle(points[ts]) or not np.allclose(old_row,points[ts],rtol=1e-9,atol=1e-8):
                    raise ResearchError('gate_revised_or_unverified_overlap')
        repair_gate_range(symbol,interval,points,last+step,latest)
        appended=[points[ts] for ts in range(last+step,latest+step,step)]
        if not appended or appended[0][0]!=last+step:
            raise ResearchError('incremental_provider_gap')
        old=np.concatenate((old,np.asarray(appended,dtype=np.float64)),axis=0)
    needed=int((180 if interval==60 else 90)*1440/interval)+250
    old=old[-needed:]
    out.parent.mkdir(parents=True,exist_ok=True)
    tmp=out.with_suffix(out.suffix+'.tmp')
    with tmp.open('w',encoding='utf-8',newline='') as file:
        writer=csv.writer(file);writer.writerow(['timestamp','open','high','low','close','volume'])
        for row in old:writer.writerow([int(row[0]),*row[1:].tolist()])
    load_csv(tmp,interval,True,min_history_days=(30 if interval==5 else 90),keep_all=True)
    tmp.replace(out)
    return len(old)


def gate_error_reason(error: urllib.error.HTTPError, symbol: str, interval: int) -> str:
    """Diagnose Gate 400 without assuming it denotes a geographic restriction.

    Gate reports both request-parameter failures and access controls as HTTP 400
    in some cases. A minimal, unauthenticated 2-bar request helps distinguish a
    historical query failure from an endpoint-wide rejection. Only whitelisted
    error labels/messages (never URLs, headers, secrets) reach the diagnostic.
    """
    def detail(exc: urllib.error.HTTPError) -> str:
        try:
            raw = exc.read(1600).decode('utf-8', 'replace')
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                bits = [str(parsed[k]) for k in ('label', 'code', 'message')
                        if k in parsed and isinstance(parsed[k], (str, int))]
                msg = '_'.join(bits)
            else:
                msg = ''
        except (OSError, ValueError, TypeError):
            msg = ''
        return ''.join(ch if ch.isalnum() or ch in '_-' else '_'
                       for ch in msg)[:38] or 'unexplained'
    first=detail(error)
    if error.code != 400:
        return f'gate_{error.code}_access_restricted' if error.code in (403,451) else f'gate_{error.code}_{first}'
    # Lightweight endpoint probe: if this succeeds, the problem is with the
    # historical range/parameters, not a blanket ban for this endpoint.
    params={'contract':symbol[:-4]+'_USDT',
            'interval':{5:'5m',15:'15m',60:'1h'}[interval], 'limit':'2'}
    url=GATE_FUTURES_BASE+'?'+urllib.parse.urlencode(params)
    try:
        answer=http_json(url,timeout=12)
        if isinstance(answer, list) and answer:
            return 'gate_history_400_probe_ok_'+first
        return 'gate_history_400_probe_invalid_response_'+first
    except urllib.error.HTTPError as probe:
        probe_detail=detail(probe)
        return f'gate_history_400_probe_{probe.code}_{probe_detail}'
    except (urllib.error.URLError, TimeoutError, ResearchError, ValueError) as probe:
        return 'gate_history_400_probe_unavailable_'+type(probe).__name__


def refresh_public_perpetual_candles(symbol: str, interval: int, out: Path,
                                      previous: Path | None = None,
                                      previous_source: str = "") -> tuple[int,str]:
    """Use same-source incremental cache; 403/451 fail over with a FULL fresh history.

    Bybit -> Binance -> Gate. Do not bypass API rate limits. Never cross-join
    exchange OHLCV (volumes are measured in different units).
    """
    if previous_source not in ('', *MARKET_SOURCES):raise ResearchError('unknown_previous_market_source')
    if previous_source=='gateio_usdt_perpetual':
        try:return refresh_gate_futures_candles(symbol,interval,out,previous),'gateio_usdt_perpetual'
        except urllib.error.HTTPError as gate:
            raise ResearchError(gate_error_reason(gate,symbol,interval)) from gate
    if previous_source=='binance_usdm_perpetual':
        try:return refresh_binance_futures_candles(symbol,interval,out,previous),'binance_usdm_perpetual'
        except urllib.error.HTTPError as exc:
            if exc.code not in (403,451):raise
            try:return fetch_gate_futures_candles(symbol,interval,out),'gateio_usdt_perpetual'
            except urllib.error.HTTPError as gate:
                raise ResearchError(f'binance_{exc.code}_{gate_error_reason(gate,symbol,interval)}') from gate
    try:
        return refresh_bybit_candles(symbol,interval,out,previous),'bybit_public_linear'
    except urllib.error.HTTPError as exc:
        if exc.code not in (403,451):raise
        try:
            # A provider switch intentionally DISCARDS old market history.
            return fetch_binance_futures_candles(symbol,interval,out),'binance_usdm_perpetual'
        except urllib.error.HTTPError as secondary:
            if secondary.code not in (403,451):raise ResearchError(f'bybit_{exc.code}_binance_{secondary.code}') from secondary
            try:return fetch_gate_futures_candles(symbol,interval,out),'gateio_usdt_perpetual'
            except urllib.error.HTTPError as gate:
                raise ResearchError(f'bybit_{exc.code}_binance_{secondary.code}_{gate_error_reason(gate,symbol,interval)}') from gate
            except ResearchError as gate:
                raise ResearchError(f'bybit_{exc.code}_binance_{secondary.code}_gate_{str(gate)[:60]}') from gate
        except ResearchError as secondary:
            raise ResearchError(f'bybit_{exc.code}_binance_{str(secondary)[:60]}') from secondary


def ema(v: np.ndarray, n: int) -> np.ndarray:
    a=2.0/(n+1);out=np.empty_like(v);out[0]=v[0]
    for i in range(1,len(v)):out[i]=a*v[i]+(1-a)*out[i-1]
    return out

def indicators(c: np.ndarray) -> dict:
    close=c[:,4];hi=c[:,2];lo=c[:,3];n=len(c)
    atr=np.empty(n);rsi=np.empty(n)
    gain=loss=0.
    for i in range(n):
        prev=close[i-1] if i else close[i]
        tr=max(hi[i]-lo[i],abs(hi[i]-prev),abs(lo[i]-prev))
        atr[i]=tr if i==0 else (atr[i-1]*13+tr)/14
        if i:
            d=close[i]-prev;g=max(0,d);l=max(0,-d)
            if i==1:gain=g;loss=l
            else:gain=(gain*13+g)/14;loss=(loss*13+l)/14
        rsi[i]=100*gain/(gain+loss) if gain+loss else 50
    return {"atr":atr,"rsi":rsi}

def vector_signals(c: np.ndarray, s: dict, common: dict) -> np.ndarray:
    close=c[:,4];volume=c[:,5];N=len(close)
    fast=ema(close,int(s["fast"]));slow=ema(close,int(s["slow"]))
    lookback=int(s["lookback"])
    threshold=float(s["volume_mult"]);rsi=common["rsi"]
    idx=np.arange(N)
    # Previous 20 completed bars only; excludes the current candidate signal bar.
    cumulative=np.r_[0.,np.cumsum(volume)]
    vol_prev=np.full(N,np.nan)
    vol_prev[20:]=(cumulative[20:N]-cumulative[0:N-20])/20.
    vol_ok=volume>=vol_prev*threshold
    longs=np.zeros(N,dtype=bool);shorts=np.zeros(N,dtype=bool)
    if s["family"]=="breakout":
        from numpy.lib.stride_tricks import sliding_window_view
        rolling_high=np.full(N,np.nan);rolling_low=np.full(N,np.nan)
        rolling_high[lookback:]=sliding_window_view(c[:-1,2],lookback).max(axis=1)
        rolling_low[lookback:]=sliding_window_view(c[:-1,3],lookback).min(axis=1)
        longs=(close>rolling_high)&(close>fast)&vol_ok
        shorts=(close<rolling_low)&(close<fast)&vol_ok
    elif s["family"]=="pullback":
        prev_close=np.r_[np.nan,close[:-1]];prev_fast=np.r_[np.nan,fast[:-1]]
        longs=(prev_close<=prev_fast)&(close>fast)&(rsi>s["rsi"])&vol_ok
        shorts=(prev_close>=prev_fast)&(close<fast)&(rsi<100-s["rsi"])&vol_ok
    elif s["family"]=="mean_revert":
        from numpy.lib.stride_tricks import sliding_window_view
        windows=sliding_window_view(close,lookback+1)
        m=windows.mean(axis=1);std=windows.std(axis=1)
        mu=np.full(N,np.nan);sigma=np.full(N,np.nan)
        mu[lookback:]=m;sigma[lookback:]=std
        pm=np.r_[np.nan,mu[:-1]];ps=np.r_[np.nan,sigma[:-1]]
        pc=np.r_[np.nan,close[:-1]]
        longs=(pc<pm-1.8*ps)&(close>mu-1.8*sigma)&(rsi<s["rsi"])
        shorts=(pc>pm+1.8*ps)&(close<mu+1.8*sigma)&(rsi>100-s["rsi"])
    elif s["family"]=="momentum":
        past=np.full(N,np.nan);past[lookback:]=close[:-lookback]
        ret=close/past-1
        longs=(ret>.007)&(close>fast)&(rsi>s["rsi"])&vol_ok
        shorts=(ret<-.007)&(close<fast)&(rsi<100-s["rsi"])&vol_ok
    else:raise ResearchError("unknown_family")
    if s["trend_filter"]:
        longs &= fast>slow;shorts &= fast<slow
    longs &= idx>=250;shorts &= idx>=250
    out=np.zeros(N,dtype=np.int8)
    out[longs&~shorts]=1;out[shorts&~longs]=-1
    return out

def run_sim(c: np.ndarray, s: dict, common: dict, signals: np.ndarray, start: int, end: int, cost: int = 1, delay: int = 0) -> dict:
    atr=common["atr"];eq=1.;peak=1.;dd=0.;profits=[];i=start+1
    while i<end-1:
        idx=i-1-delay;direction=int(signals[idx]) if idx>=250 else 0
        if not direction:i+=1;continue
        entry=float(c[i,1]);distance=max(float(atr[idx])*s["stop_atr"],entry*.0002)
        take_distance=distance*s["take_atr"]/s["stop_atr"]
        stop=entry-direction*distance;take=entry+direction*take_distance
        exposure=min(.30,.005*entry/distance)
        close_index=min(end-1,i+int(s["max_hold"])-1);exit_price=float(c[close_index,4]);j=close_index
        for k in range(i,close_index+1):
            o=float(c[k,1]);h=float(c[k,2]);l=float(c[k,3]);
            is_stop=l<=stop if direction==1 else h>=stop
            is_take=h>=take if direction==1 else l<=take
            if is_stop:
                exit_price=min(stop,o) if direction==1 else max(stop,o);j=k;break
            if is_take:
                exit_price=take;j=k;break
        entry_eff=entry*(1+direction*.0003*cost)
        exit_eff=exit_price*(1-direction*.0003*cost)
        ret=exposure*(direction*(exit_eff-entry_eff)/entry_eff-2*.0006*cost)
        eq=max(0.000001,eq*(1+ret));peak=max(peak,eq)
        dd=max(dd,(peak-eq)/peak);profits.append(ret)
        i=j+2  # one-bar cooldown; fixed conservative simulation assumption
    wins=sum(1 for p in profits if p>0);losses=sum(1 for p in profits if p<=0)
    gw=sum(p for p in profits if p>0);gl=-sum(p for p in profits if p<=0)
    return {"trades":len(profits),"net_return_pct":round((eq-1)*100,4),
            "mdd_pct":round(dd*100,4),"profit_factor":round(gw/gl,4) if gl else 0.,
            "win_rate_pct":round(wins/len(profits)*100,3) if profits else 0.}

def evaluate(job: dict, data: np.ndarray, common: dict) -> dict:
    s=job["spec"];interval=job["interval_min"]
    if len(data)<int(90*1440/interval)+250:raise ResearchError("insufficient_history")
    split=len(data)-int(30*1440/interval)
    signals=vector_signals(data,s,common)
    train=run_sim(data,s,common,signals,250,split)
    oos=run_sim(data,s,common,signals,split,len(data))
    twice=run_sim(data,s,common,signals,split,len(data),2)
    delayed=run_sim(data,s,common,signals,split,len(data),1,1)
    return {"id":job["id"],"job_hash":job["job_hash"],"claim_token":job["claim_token"],"train":train,"oos":oos,"double_cost":twice,
        "one_bar_delay":delayed,"oos_days":30,"data_sha256":hashlib.sha256(data.tobytes()).hexdigest(),
        "last_candle_unix":int(data[-1,0]/1000),"source":"verified_perpetual_ohlcv_csv_90d","research_only":True}

def ai_ideas(client: Client, api_key: str, symbol: str, interval: int) -> dict:
    ctx=client.get("context",symbol=symbol)
    market=ctx.get("market",{});tech=ctx.get("technical",{})
    if not market.get("fresh") or tech.get("data_quality") not in ("scored","partial"):
        return {"ok":False,"error":"stale_market_context"}
    reservation=client.post("reserve",{})
    if not reservation.get("ok"):return {"ok":False,"error":"reserve_denied"}
    rid=reservation["reservation_id"];input_tokens=output_tokens=0;confirmed=False
    try:
        instructions=(
            "You are an evidence-limited, research-only hypothesis generator. Never place orders, claim real-market "
            "profitability, or extrapolate observed public whale/liquidation data into confirmed causality. "
            "Use research_history to examine previously failed or sensitive OOS tests, cost-doubling and "
            "one-bar delay; avoid exact duplicate parameter sets. Propose up to 6 DIFFERENT testable "
            "hypotheses for validation, rather than treating a prior backtest as successful trading. "
            "family: breakout|pullback|mean_revert|momentum; lookback 8..80, fast 5..40, slow 25..240 "
            "(slow>fast), rsi 20..80, volume_mult 0.5..3, stop_atr 0.6..4, take_atr 0.7..7, "
            "max_hold 3..48, boolean trend_filter. Respond with schema only."
        )
        fields={"family":{"type":"string","enum":["breakout","pullback","mean_revert","momentum"]},
                **{name:{"type":"integer"} for name in ("lookback","fast","slow","rsi","max_hold")},
                **{name:{"type":"number"} for name in ("volume_mult","stop_atr","take_atr")},
                "trend_filter":{"type":"boolean"}}
        # History is placed BEFORE potentially verbose technical context so it never falls
        # outside the bounded prompt after truncation.
        evidence={"symbol":symbol,"interval_min":interval,"research_history":ctx.get("research_history",[])[:6],
                  "market":ctx.get("market",{}),"technical":tech,
                  "chart_timeframes":ctx.get("chart_timeframes",{}),
                  "signals":ctx.get("signal_observations",{}),
                  "indicator_observations":ctx.get("indicator_observations",{}),
                  "whales":ctx.get("whales",{}),"liquidations":ctx.get("liquidations",{})}
        data={"model":reservation["model"],"instructions":instructions,
              "input":json.dumps(evidence,ensure_ascii=False,separators=(',',':'))[:9500],
              "reasoning":{"effort":"none"},"max_output_tokens":reservation["max_output_tokens"],
              "text":{"format":{"type":"json_schema","name":"lumex_research_ideas","strict":True,
                       "schema":{"type":"object","properties":{"ideas":{"type":"array","items":{
                           "type":"object","properties":fields,"required":list(fields),"additionalProperties":False}}},
                           "required":["ideas"],"additionalProperties":False}}},"store":False}
        result=http_json("https://api.openai.com/v1/responses","POST",data,api_key,timeout=40)
        if result.get("status")!="completed":raise ResearchError("ai_response_not_completed")
        usage=result.get("usage",{})
        input_tokens=int(usage.get("input_tokens",0));output_tokens=int(usage.get("output_tokens",0));confirmed=bool(usage)
        output="".join(chunk.get("text","") for item in result.get("output",[]) if item.get("type")=="message"
                       for chunk in item.get("content",[]) if chunk.get("type")=="output_text")
        if not output:raise ResearchError("empty_ai_output")
        ideas=json.loads(output).get("ideas",[])
        if not isinstance(ideas,list):raise ResearchError("ai_non_array")
        return client.post("suggestions",{"symbol":symbol,"interval_min":interval,"ideas":ideas[:6]})
    except (ValueError,KeyError,ResearchError,urllib.error.URLError) as exc:
        return {"ok":False,"error":type(exc).__name__}
    finally:
        # Committing unknown usage charges the conservative pre-reserved amount.
        try:client.post("commit",{"reservation_id":rid,"input_tokens":input_tokens,"output_tokens":output_tokens,"usage_confirmed":confirmed})
        except Exception:pass

def main(argv: list[str] | None = None) -> int:
    p=argparse.ArgumentParser(description="LUMEX research-only, no orders, bounded batch")
    p.add_argument("--host",default=os.getenv("LUMEX_SITE_URL",""))
    p.add_argument("--data-dir",default=os.getenv("LUMEX_LAB_DATA_DIR","./research-data"))
    p.add_argument("--max-jobs",type=int,default=20)
    p.add_argument("--fetch",action="store_true",help="Update Bybit 90d public OHLCV cache")
    p.add_argument("--ai-calls",type=int,default=0)
    p.add_argument("--tick",action="store_true",help="Generate up to 100 queued DSL specs")
    a=p.parse_args(argv)
    token=os.getenv("LUMEX_AI_LAB_WORKER_TOKEN","")
    client=Client(a.host,token)
    if a.tick:
        print(json.dumps({"tick":client.post("tick",{})},ensure_ascii=False))
    if a.fetch:
        for sym in SUPPORTED:
            for interval in sorted(FRAMES):
                try:
                    n=fetch_bybit_candles(sym,interval,Path(a.data_dir)/f"{sym}_{interval}.csv")
                    print(json.dumps({"fetched":sym,"interval":interval,"rows":n}))
                except (ResearchError,urllib.error.URLError,TimeoutError,ValueError) as exc:
                    print(json.dumps({"failed":sym,"interval":interval,"error":str(exc)}),file=sys.stderr)
    jobs=client.get("jobs",limit=min(40,max(1,a.max_jobs))).get("jobs",[])
    cache:dict[tuple,np.ndarray]={};ind:dict[tuple,dict]={}
    for job in jobs:
        try:
            key=(job["symbol"],int(job["interval_min"]))
            if key not in cache:
                cache[key]=load_csv(Path(a.data_dir)/f"{key[0]}_{key[1]}.csv",key[1],True)
                ind[key]=indicators(cache[key])
            report=evaluate(job,cache[key],ind[key])
        except (ResearchError,KeyError,ValueError,TypeError) as exc:
            error=str(exc)[:75].lower().replace(" ","_")
            report={"id":job["id"],"job_hash":job["job_hash"],"claim_token":job["claim_token"],"error":True,"error_code":error,"source":"public_data_validation"}
        try:
            response=client.post("results",report)
            print(json.dumps({"job_id":job["id"],"state":response.get("state"),"gate":response.get("gate")},ensure_ascii=False))
        except Exception as exc:
            print(json.dumps({"job_id":job["id"],"error":"result_submit_failed","type":type(exc).__name__}),file=sys.stderr)
    if a.ai_calls and os.getenv("OPENAI_API_KEY"):
        symbols=sorted(SUPPORTED)
        rotation_file=Path(a.data_dir)/"ai_rotation.json"
        rotation_file.parent.mkdir(parents=True,exist_ok=True)
        try:cursor=int(json.loads(rotation_file.read_text()).get("cursor",0)) if rotation_file.exists() else 0
        except (ValueError,TypeError,KeyError):cursor=0
        for idx in range(max(0,min(a.ai_calls,5))):
            symbol=symbols[(cursor+idx)%len(symbols)]
            try:
                r=ai_ideas(client,os.environ["OPENAI_API_KEY"],symbol,15)
                print(json.dumps({"symbol":symbol,"ai_result":r},ensure_ascii=False))
            except Exception as e:
                print(json.dumps({"symbol":symbol,"ai_error_type":type(e).__name__}),file=sys.stderr)
        tmp=rotation_file.with_suffix(".tmp")
        tmp.write_text(json.dumps({"cursor":cursor+max(0,min(a.ai_calls,5))}))
        tmp.replace(rotation_file)
    return 0

if __name__=="__main__":raise SystemExit(main())
