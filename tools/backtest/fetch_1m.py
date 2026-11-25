"""1-minute USDT-perp candles for the scalping study (no keys, read-only, data branch only).
OKX history-candles, 100 bars per page, newest → oldest, for the last DAYS days. Writes <COIN>_1.csv (t ms,o,h,l,c,vol)."""
import json, sys, time, urllib.request, pathlib, csv
OUT = pathlib.Path(sys.argv[1]); OUT.mkdir(parents=True, exist_ok=True)
SYMS = ['BTC', 'ETH', 'SOL']; DAYS = 365
now_ms = int(time.time() // 60 * 60 * 1000); start_ms = now_ms - DAYS * 86400 * 1000
def get(url, tries=6):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'lumex-research/1.0', 'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=25) as r:
                j = json.loads(r.read())
                if j.get('code') not in ('0', 0): raise RuntimeError(j.get('msg'))
                return j['data']
        except Exception:
            if k == tries - 1: raise
            time.sleep(1.5 * (k + 1))
report = {'generated_ms': now_ms, 'days': DAYS, 'source': 'OKX /api/v5/market/history-candles <COIN>-USDT-SWAP bar=1m'}
for s in SYMS:
    rows = {}; after = now_ms; t0 = time.time()
    while True:
        L = get(f'https://www.okx.com/api/v5/market/history-candles?instId={s}-USDT-SWAP&bar=1m&limit=100&after={after}')
        if not L: break
        for r in L:
            if r[8] == '1': rows[int(r[0])] = [float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5])]
        oldest = min(int(r[0]) for r in L)
        if oldest <= start_ms or oldest >= after: break
        after = oldest; time.sleep(0.11)
    with open(OUT / f'{s}_1.csv', 'w', newline='') as f:
        w = csv.writer(f); w.writerow(['t', 'o', 'h', 'l', 'c', 'v'])
        for t in sorted(rows):
            if t >= start_ms: w.writerow([t, *rows[t]])
    gaps = sum(1 for a, b in zip(sorted(rows), sorted(rows)[1:]) if b - a > 60000)
    report[s] = {'rows': len(rows), 'from': min(rows), 'to': max(rows), 'gaps': gaps, 'secs': round(time.time() - t0)}
    print(s, report[s], flush=True)
(OUT / 'report_1m.json').write_text(json.dumps(report, indent=1))
