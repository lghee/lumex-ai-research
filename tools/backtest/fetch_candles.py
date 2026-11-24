"""v5 (round 2, funding only) — 3-year funding history for the crowding study (no keys, read-only, PR branch only).
Tries, per coin: Gate funding_rate paged by `to` (no limit+from mix), Bitget history-fund-rate pages, then Hyperliquid
fundingHistory (hourly, different venue — recorded as such). Writes <COIN>_funding.csv (+ source) and report.json."""
import json, sys, time, urllib.request, pathlib, csv
OUT = pathlib.Path(sys.argv[1]); OUT.mkdir(parents=True, exist_ok=True)
SYMS = ['BTC','ETH','SOL','XRP','DOGE','BNB','ADA','LINK','AVAX','SUI']
now = int(time.time()); start = now - 1095*86400
def get(url, data=None, tries=4):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None,
                headers={'User-Agent': 'lumex-research/1.0', 'Accept': 'application/json', **({'Content-Type': 'application/json'} if data is not None else {})})
            with urllib.request.urlopen(req, timeout=25) as r: return json.loads(r.read())
        except Exception as e:
            if k == tries-1: raise
            time.sleep(1.5*(k+1))
def gate(s):
    out = {}; to = now
    for _ in range(80):
        L = get(f'https://api.gateio.ws/api/v4/futures/usdt/funding_rate?contract={s}_USDT&to={to}')
        if not L: break
        for r in L: out[int(r['t'])] = float(r['r'])
        oldest = min(int(r['t']) for r in L)
        if oldest <= start or oldest >= to: break
        to = oldest - 1; time.sleep(0.15)
    return out
def bitget(s):
    out = {}
    for page in range(1, 200):
        j = get(f'https://api.bitget.com/api/v2/mix/market/history-fund-rate?symbol={s}USDT&productType=USDT-FUTURES&pageSize=100&pageNo={page}')
        L = j.get('data') or []
        if not L: break
        for r in L: out[int(r['fundingTime'])//1000] = float(r['fundingRate'])
        if min(int(r['fundingTime'])//1000 for r in L) <= start: break
        time.sleep(0.12)
    return out
def hyper(s):
    out = {}; t = start*1000
    for _ in range(400):
        L = get('https://api.hyperliquid.xyz/info', {'type': 'fundingHistory', 'coin': s, 'startTime': t})
        if not L: break
        for r in L: out[int(r['time'])//1000] = float(r['fundingRate'])
        nt = max(int(r['time']) for r in L) + 1
        if nt <= t or nt >= now*1000: break
        t = nt; time.sleep(0.2)
    return out
report = {'generated': now}
for s in SYMS:
    best = {}; src = None; notes = []
    for name, fn in (('gate', gate), ('bitget', bitget), ('hyperliquid', hyper)):
        try:
            d = fn(s); span = (max(d) - min(d)) / 86400 if d else 0
            notes.append(f'{name}: {len(d)} rows, {span:.0f} days')
            if span > ((max(best) - min(best)) / 86400 if best else 0) + 30: best, src = d, name
            if span >= 1000: break
        except Exception as e: notes.append(f'{name} failed: {str(e)[:80]}')
    with open(OUT / f'{s}_funding.csv', 'w', newline='') as f:
        w = csv.writer(f); w.writerow(['t', 'rate']); w.writerows(sorted(best.items()))
    report[f'{s}_funding'] = {'source': src, 'rows': len(best), 'from': min(best) if best else None, 'notes': notes}
    print(s, report[f'{s}_funding'], flush=True)
(OUT / 'report_funding.json').write_text(json.dumps(report, indent=1))
