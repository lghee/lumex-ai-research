"""v3 — 1-year public USDT-perp history for strategy research (no keys, read-only).
Candles: OKX history-candles (1H/4H 365d, 15m 180d), Gate fallback. Funding: OKX + Gate funding history.
Writes CSV per series + report.json."""
import json, sys, time, urllib.request, pathlib, csv
OUT = pathlib.Path(sys.argv[1]); OUT.mkdir(parents=True, exist_ok=True)
SYMS = ['BTC','ETH','SOL','XRP','DOGE','BNB','ADA','LINK','AVAX','SUI']
PLAN = {'15': (900, 180), '60': (3600, 365), '240': (14400, 365)}
now = int(time.time())
def get(url, tries=4):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'lumex-research/1.0', 'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=25) as r: return json.loads(r.read())
        except Exception as e:
            if k == tries-1: raise
            time.sleep(1.5*(k+1))
def okx(s, iv, sec, start):
    bar = {'15':'15m','60':'1H','240':'4H'}[iv]; rows = {}; after = ''
    for _ in range(2000):
        j = get(f'https://www.okx.com/api/v5/market/history-candles?instId={s}-USDT-SWAP&bar={bar}&limit=100' + (f'&after={after}' if after else ''))
        if j.get('code') != '0': raise RuntimeError(j.get('msg'))
        L = j['data']
        if not L: break
        for r in L: rows[int(r[0])//1000] = [int(r[0])//1000, float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[6])]
        oldest = min(int(r[0]) for r in L); after = str(oldest)
        if oldest//1000 <= start: break
        time.sleep(0.11)
    return rows
def gate(s, iv, sec, start):
    i = {'15':'15m','60':'1h','240':'4h'}[iv]; rows = {}; frm = start
    while frm < now:
        to = min(now, frm + sec*1900)
        for r in get(f'https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract={s}_USDT&interval={i}&from={frm}&to={to}'):
            rows[int(r['t'])] = [int(r['t']), float(r['o']), float(r['h']), float(r['l']), float(r['c']), float(r.get('sum') or 0)/max(float(r['c']),1e-12)]
        frm = to + sec; time.sleep(0.1)
    return rows
def funding(s):
    out = {}
    try:
        for r in get(f'https://api.gateio.ws/api/v4/futures/usdt/funding_rate?contract={s}_USDT&limit=1000'): out[int(r['t'])] = float(r['r'])
        src = 'gate'
    except Exception as e: src = f'gate failed: {e}'
    try:
        after = ''
        for _ in range(30):
            j = get(f'https://www.okx.com/api/v5/public/funding-rate-history?instId={s}-USDT-SWAP&limit=100' + (f'&after={after}' if after else ''))
            L = j.get('data') or []
            if not L: break
            for r in L: out.setdefault(int(r['fundingTime'])//1000, float(r['realizedRate'] or r['fundingRate']))
            after = str(min(int(r['fundingTime']) for r in L)); time.sleep(0.11)
        src += '+okx'
    except Exception as e: src += f' okx failed: {e}'
    return out, src
report = {}
for s in SYMS:
    for iv, (sec, days) in PLAN.items():
        start = now - days*86400
        for name, fn in (('okx', okx), ('gate', gate)):
            try:
                rows = fn(s, iv, sec, start)
                data = sorted(v for v in rows.values() if v[0] >= start and v[0] + sec <= now)
                if len(data) < days*86400/sec*0.9: raise RuntimeError(f'only {len(data)} rows')
                with open(OUT / f'{s}_{iv}.csv', 'w', newline='') as f:
                    w = csv.writer(f); w.writerow(['t','o','h','l','c','v']); w.writerows(data)
                report[f'{s}_{iv}'] = {'venue': name, 'rows': len(data), 'from': data[0][0], 'to': data[-1][0]}; break
            except Exception as e: report.setdefault(f'{s}_{iv}_errors', []).append(f'{name}: {str(e)[:120]}')
    fr, src = funding(s)
    with open(OUT / f'{s}_funding.csv', 'w', newline='') as f:
        w = csv.writer(f); w.writerow(['t','rate']); w.writerows(sorted(fr.items()))
    report[f'{s}_funding'] = {'source': src, 'rows': len(fr), 'from': min(fr) if fr else None}
    print(s, 'done', flush=True)
(OUT / 'report.json').write_text(json.dumps(report, indent=1))
print(json.dumps(report, indent=1))
