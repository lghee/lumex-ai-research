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
SUPPORTED = {"BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"}
FRAMES = {5, 15, 60}
USER_AGENT = "LUMEX-AI-Research-Worker/1.0 (read-only; no trading)"

class ResearchError(Exception): pass

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

def load_csv(path: Path, interval: int, require_fresh: bool = True) -> np.ndarray:
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
            if o<=0 or c<=0 or l<=0 or v<0 or h<max(o,c,l) or l>min(o,c):raise ResearchError("invalid_ohlcv")
            prior=ts; rows.append(record)
    if not rows:raise ResearchError("empty_file")
    last=rows[-1][0]
    if last>time.time()*1000:raise ResearchError("future_candle")
    if require_fresh and time.time()*1000-last>max(3*step,3_600_000):raise ResearchError("stale_candles")
    needed=int(90*1440/interval)+250
    if len(rows)<needed:raise ResearchError("less_than_90_days_and_warmup")
    return np.array(rows[-needed:], dtype=np.float64)

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
        "last_candle_unix":int(data[-1,0]/1000),"source":"bybit_linear_ohlcv_csv_90d","research_only":True}

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
            "You are a research hypothesis generator, not a trader. No live orders or financial assurances. "
            "Use only observed fresh supplied indicators, whale/liquidation metadata are coverage-limited. "
            "Propose up to 6 diverse testable hypotheses ONLY as a JSON object with key ideas, each spec has "
            "family: breakout|pullback|mean_revert|momentum; integer lookback 8..80, fast 5..40, slow 25..240 "
            "with slow>fast, rsi 20..80, volume_mult 0.5..3, stop_atr 0.6..4, take_atr 0.7..7, "
            "max_hold 3..48 and boolean trend_filter. Do not output code, raw orders, or commentary. "
            "Avoid fabricated values and do not infer market impact causation from whale transfers."
        )
        data={"model":reservation["model"],"instructions":instructions,"input":json.dumps({"symbol":symbol,"interval_min":interval,"context":ctx},ensure_ascii=False)[:9500],
              "max_output_tokens":reservation["max_output_tokens"],"store":False}
        result=http_json("https://api.openai.com/v1/responses","POST",data,api_key,timeout=40)
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
