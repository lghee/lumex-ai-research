#!/usr/bin/env python3
"""LUMEX public customer contract audit. GET only; no credentials, account data or writes."""
import concurrent.futures, datetime, json, urllib.request, urllib.error, time, os
WP='https://lumexbot.com/wp-json/lumex/v1/'
W='https://lumex-ai-research2.kpiplus195.workers.dev/market-hub/v1/'
tasks=[
('overview',WP+'public/market-overview'),
('pulse',WP+'market/pulse'),
('scanner',WP+'market/scanner'),
('whales',WP+'onchain/whales?days=30&min_btc=10'),
('ai-bots',WP+'public/ai-bots'),
('worker-live',W+'live-health'),
('worker-pulse',W+'public-pulse-health'),
('worker-archive',W+'archive-health'),
('worker-whales',W+'whale-health'),
('worker-binance-relay',W+'binance-external-health'),
('worker-binance-github',W+'github-binance-health'),
('worker-legacy-backfill',W+'legacy-backfill-health'),
('paid-terminal',WP+'market-hub/terminal?symbol=BTCUSDT'),
('paid-chart-ticket',WP+'market-hub/ticket?symbol=BTCUSDT'),
('paid-strategies',WP+'demo/historical-strategies')]
for coin in ('BTC','ETH','SOL','XRP'):
 for name,path in [
 ('intelligence','market/intelligence?coin='+coin),
 ('oi','market/liquidation-lab?coin='+coin+'&days=7'),
 ('derivatives','market-hub/derivatives?symbol='+coin+'USDT'),
 ('liquidation','market/liquidation-observed?coin='+coin+'&hours=1'),
 ('pressure','market/liquidation-pressure?coin='+coin),
 ('exchanges','market/liquidation-exchanges?coin='+coin),
 ('timeline','market/flow-timeline?coin='+coin+'&days=7'),
 ('convergence','market/convergence?coin='+coin)]:
  tasks.append((name+'-'+coin,WP+path))
def num(x):
 return isinstance(x,(int,float)) and not isinstance(x,bool)
def age(s):
 try:return int(time.time()-datetime.datetime.fromisoformat(s.replace('Z','+00:00')).timestamp())
 except:return None
def run(task):
 name,url=task;beg=time.time();status=None;data={}
 try:
  req=urllib.request.Request(url,headers={'Accept':'application/json','User-Agent':'LUMEX-readonly-public-data-QA/1.0'})
  with urllib.request.urlopen(req,timeout=19) as response:
   status=response.status
   raw=response.read(1000000)
   if len(raw)>=1000000: raise ValueError('response_size')
   data=json.loads(raw)
 except urllib.error.HTTPError as e:
  status=e.code
 except Exception:
  return {'name':name,'http':status,'state':'FAIL','issues':['network_timeout_or_invalid_json'],'seconds':int(time.time()-beg)}
 if name.startswith('paid-'):
  return {'name':name,'http':status,'state':'PASS' if status in (401,403) else 'FAIL','issues':[] if status in (401,403) else ['paid_endpoint_unprotected']}
 if status!=200:
  return {'name':name,'http':status,'state':'FAIL','issues':['http_'+str(status)]}
 issues=[];summary={}
 if data.get('ok') is False:issues.append('api_ok_false')
 if name=='overview':
  rows=data.get('coins') or [];summary['coin_count']=len(rows)
  for coin in ('BTC','ETH','SOL','XRP'):
   row=next((x for x in rows if x.get('coin')==coin),{})
   if not num(row.get('price_usdt')): issues.append(coin+'_price_null')
   if not num(row.get('rsi')):issues.append(coin+'_rsi_null')
   if not num(row.get('funding_rate_pct')):issues.append(coin+'_funding_null')
   delay=age(row.get('observed_at_utc') or '')
   if delay is None or delay>1200:issues.append(coin+'_quote_stale')
 elif name=='ai-bots':
  rows=data.get('bots') or []
  verified=sum(isinstance(x.get('performance'),dict) and
      x['performance'].get('provenance')=='continuous_paper_carry_v3' for x in rows)
  summary={'bots':len(rows),'verified_forward_equity':verified}
  if len(rows)<5:issues.append('bot_catalog_incomplete')
  if verified<1:issues.append('no_verified_forward_equity')
 elif name=='pulse':
  summary['feeds']={k:(data.get('feeds',{}).get(k) or {}).get('status') for k in ('tickers','ratio','sentiment')}
  if any(x not in ('fresh','delayed') for x in summary['feeds'].values()):issues.append('pulse_missing')
 elif name.startswith('intelligence-'):
  coin=name.split('-')[-1]
  row=next((x for x in (data.get('coins') or []) if x.get('coin')==coin),data.get('selected') or {})
  summary={'price':row.get('price'),'technical':(row.get('technical') or {}).get('status'),
    'oi':(row.get('oi') or {}).get('status'),'funding':row.get('funding_rate_pct'),
    'account_ratio':row.get('long_account_pct')}
  for key in ('price','funding','account_ratio'):
   if not num(summary[key]):issues.append(key+'_missing')
  if summary['technical']!='ok':issues.append('technical_missing')
  if summary['oi']!='ok':issues.append('oi_missing')
 elif name.startswith('oi-'):
  summary={'price_present':num(data.get('price')),'oi_present':num(data.get('oi_usd')),
    'history_rows':len(data.get('history') or [])}
  if not summary['price_present'] or not summary['oi_present']:issues.append('oi_current_missing')
  if summary['history_rows']<24:issues.append('oi_history_short')
 elif name.startswith('liquidation-'):
  rows=data.get('events') or [];summary={'events':len(rows),
      'bybit':sum(x.get('exchange')=='Bybit' for x in rows),
      'binance':sum(x.get('exchange')=='Binance' for x in rows)}
  if data.get('source')!='cloudflare_hot_public_liquidations':issues.append('unexpected_source')
  if len(rows)==0:issues.append('recent_events_empty')
 elif name.startswith('pressure-'):
  p=data.get('pressure') or {}
  summary={'60m_count':((p.get('windows') or {}).get('60m') or {}).get('count'),'score_present':num(p.get('score'))}
  if not summary['score_present']:issues.append('pressure_model_unavailable')
 elif name=='whales':
  summary={'status':data.get('status'),'observed_events':data.get('observed_events'),
     'backfill_complete':data.get('backfill_complete'),'price_usd':data.get('price_usd')}
  if summary['status']!='ok':issues.append('whale_status_not_ok')
  if not num(summary['price_usd']) or summary['price_usd']<=0:issues.append('btc_price_missing')
 elif name=='worker-live':
  summary={k:(data.get('feeds',{}).get(k) or {}).get('connected') for k in ('bybit','gate','binance')}
  for k,x in summary.items():
   if x is not True:issues.append(k+'_stream_disconnected')
 elif name=='worker-pulse':
  summary={'verified_sources':sum(v.get('ok') is True for v in ((data.get('report') or {}).get('sources') or {}).values())}
  if summary['verified_sources']<8:issues.append('pulse_feeds_partial')
 elif name=='worker-archive':
  summary={k:((data.get('kinds') or {}).get(k) or {}).get('sample_verified') for k in ('liquidation','whale_transfer')}
  for k,x in summary.items():
   if x is not True:issues.append(k+'_r2_missing')
 elif name=='worker-whales':
  rows=data.get('watchlist') or []
  summary={'configured':data.get('watchlist_count'),
    'completed':sum(x.get('backfill_complete') is True and not x.get('gap_possible') and not x.get('error') for x in rows)}
  if summary['completed']!=summary['configured']:issues.append('whale_backfill_incomplete')
 elif name=='worker-binance-relay':
  summary={'configured':data.get('configured') is True}
  if not summary['configured']:issues.append('binance_relay_not_running')
 elif name=='worker-binance-github':
  summary={'coverage':data.get('coverage')}
  if summary['coverage']!='continuous':issues.append('binance_observation_not_continuous')
 elif name=='worker-legacy-backfill':
  summary={'sources':[(x.get('source'),x.get('caught_up')) for x in (data.get('sources') or [])]}
  if any(x[1] is not True for x in summary['sources']):issues.append('archive_not_caught_up')
 elif name=='scanner':
  summary={'count':len(data.get('items') or [])}
  for c in ('BTC','ETH','SOL','XRP'):
   row=next((x for x in (data.get('items') or []) if x.get('symbol')==c+'USDT'),{})
   if (row.get('15m') or {}).get('status')!='ok':issues.append(c+'_15m_missing')
   if (row.get('1h') or {}).get('status')!='ok':issues.append(c+'_1h_missing')
 return {'name':name,'http':status,'state':'WARN' if issues else 'PASS','issues':issues,'summary':summary,
     'seconds':int(time.time()-beg)}
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:results=list(pool.map(run,tasks))
for r in results:print('PUBLIC_DATA_AUDIT',json.dumps(r,ensure_ascii=False,separators=(',',':')))
counts={s:sum(x['state']==s for x in results) for s in ('PASS','WARN','FAIL')}
print('PUBLIC_DATA_TOTAL',json.dumps({'checked_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'total':len(results),'states':counts},separators=(',',':')))
with open('public-data-audit.json','w',encoding='utf8') as f:json.dump({'results':results,'counts':counts},f,ensure_ascii=False,indent=2)
# A blocked public route or exposed paid API must fail. Missing measured
# data is a WARN: a valid missing observation must not be fabricated to pass.
raise SystemExit(1 if counts['FAIL'] else 0)
