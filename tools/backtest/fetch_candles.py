"""Fetch ~50 days of public USDT-perpetual candles (no keys) for backtesting.
Tries Bybit, then OKX, then Gate per symbol/interval; records which venue answered. Output: CSV per series."""
import json, sys, time, urllib.request, pathlib, csv
OUT = pathlib.Path(sys.argv[1]); OUT.mkdir(parents=True, exist_ok=True)
SYMS = ['BTC','ETH','SOL','XRP','DOGE','BNB','ADA','LINK','AVAX','SUI']
IVS = {'15': 900, '60': 3600, '240': 14400}
DAYS = 50; now = int(time.time()); start = now - DAYS*86400
def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'lumex-backtest/1.0', 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=20) as r: return json.loads(r.read())
def bybit(s, iv, sec):
    rows = {}; end = now*1000
    while True:
        j = get(f'https://api.bybit.com/v5/market/kline?category=linear&symbol={s}USDT&interval={iv}&limit=1000&end={end}')
        if j.get('retCode') != 0: raise RuntimeError(j.get('retMsg'))
        L = j['result']['list']
        if not L: break
        for r in L: rows[int(r[0])] = [int(r[0])//1000, *map(float, r[1:6])]
        oldest = min(int(r[0]) for r in L)
        if oldest//1000 <= start or len(L) < 1000: break
        end = oldest - 1
    return rows
def okx(s, iv, sec):
    bar = {'15':'15m','60':'1H','240':'4H'}[iv]; rows = {}; after = ''
    for _ in range(40):
        j = get(f'https://www.okx.com/api/v5/market/history-candles?instId={s}-USDT-SWAP&bar={bar}&limit=100' + (f'&after={after}' if after else ''))
        if j.get('code') != '0': raise RuntimeError(j.get('msg'))
        L = j['data']
        if not L: break
        for r in L: rows[int(r[0])] = [int(r[0])//1000, float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[6])]
        oldest = min(int(r[0]) for r in L); after = str(oldest)
        if oldest//1000 <= start: break
        time.sleep(0.15)
    return rows
def gate(s, iv, sec):
    i = {'15':'15m','60':'1h','240':'4h'}[iv]; rows = {}; frm = start
    while frm < now:
        to = min(now, frm + sec*1900)
        L = get(f'https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract={s}_USDT&interval={i}&from={frm}&to={to}')
        for r in L: rows[int(r['t'])*1000] = [int(r['t']), float(r['o']), float(r['h']), float(r['l']), float(r['c']), float(r.get('sum') or 0)/max(float(r['c']),1e-12)]
        frm = to + sec
    return rows
report = {}
for s in SYMS:
    for iv, sec in IVS.items():
        for name, fn in (('bybit', bybit), ('okx', okx), ('gate', gate)):
            try:
                rows = fn(s, iv, sec)
                data = sorted(v for k, v in rows.items() if v[0] >= start and v[0] + sec <= now)  # closed candles only
                if len(data) < 100: raise RuntimeError(f'only {len(data)} rows')
                with open(OUT / f'{s}_{iv}.csv', 'w', newline='') as f:
                    w = csv.writer(f); w.writerow(['t','o','h','l','c','v']); w.writerows(data)
                report[f'{s}_{iv}'] = {'venue': name, 'rows': len(data), 'from': data[0][0], 'to': data[-1][0]}
                break
            except Exception as e:
                report.setdefault(f'{s}_{iv}_errors', []).append(f'{name}: {str(e)[:120]}')
(OUT / 'report.json').write_text(json.dumps(report, indent=1))
print(json.dumps(report, indent=1))
