import assert from 'node:assert/strict';
import {swolechartsVenueBackup,swolechartsBinanceBackup} from '../src/swolecharts-binance.mjs';
import {collectExchangeCompare} from '../src/exchange-compare.mjs';
const now=Date.parse('2026-11-16T02:40:00Z'),ts=now-5*60*1000;
const samples={binance:.742,bybit:.728,bitget:.801};
const valueOI={binance:6074297200,bybit:2318137400,bitget:1204760800};
const funding={binance:-.0000163,bybit:-.00006184,bitget:-.00002};
function json(x){return {ok:true,text:async()=>JSON.stringify(x)}}
const requests=[];
const fetchMock=async url=>{
  if(url.includes('swolecharts.com/api/series/')){
    const u=new URL(url),market=u.searchParams.get('market'),parts=market.split(':');
    assert.equal(parts[1],'perp');
    assert.equal(parts[2],'BTCUSDT');
    const venue=parts[0];assert(venue in samples);
    const metric=u.pathname.split('/').pop();
    const v=metric==='long-short'?samples[venue]:metric==='oi'?valueOI[venue]:funding[venue];
    if(metric==='long-short')assert.equal(u.searchParams.get('kind'),'accounts');
    requests.push({market,metric});
    return json({metric,market,db:true,step:300000,kind:metric==='long-short'?'accounts':undefined,
      t:[ts],v:[v],fields:['v'],gaps:[]});
  }
  if(url.includes('fapi.binance.com')||url.includes('api.bybit.com')||url.includes('api.bytick.com')||
     url.includes('api.bitget.com'))
    return {ok:false,status:403,text:async()=>''};
  if(url.includes('www.okx.com'))return json({code:'400',data:[]});
  if(url.includes('api.gateio.ws'))return json([]);
  throw Error('Unexpected '+url);
};
for(const venue of ['binance','bybit','bitget']){
  const r=await swolechartsVenueBackup(venue,'BTC',{now,fetchImpl:fetchMock});
  assert.equal(r.account.long_pct,Number((samples[venue]*100).toFixed(4)));
  assert.equal(r.account.short_pct,Number(((1-samples[venue])*100).toFixed(4)));
  assert.equal(r.account.denominator,'exchange_long_short_accounts');
  assert.equal(r.open_interest.value,valueOI[venue]);
  assert.equal(r.open_interest.unit,'USD');
  assert.equal(r.funding.rate_pct,Number((funding[venue]*100).toFixed(6)));
  assert.equal(r.account.venue,venue[0].toUpperCase()+venue.slice(1));
  assert.equal(r.funding.source_market,venue+':perp:BTCUSDT');
  assert.equal(r.errors.length,0);
}
assert.equal((await swolechartsBinanceBackup('BTC',{now,fetchImpl:fetchMock})).account.long_pct,74.2);
assert.throws(()=>swolechartsVenueBackup('okx','BTC'));
const wrongMarket=await swolechartsVenueBackup('bybit','BTC',{now,
 fetchImpl:async u=>json({market:'binance:perp:BTCUSDT',metric:new URL(u).pathname.split('/').pop(),
  db:true,t:[ts],v:[.5]})});
assert.equal(wrongMarket.account,null);
const tooOld=await swolechartsVenueBackup('bitget','BTC',{now,
 fetchImpl:async u=>json({market:new URL(u).searchParams.get('market'),
  metric:new URL(u).pathname.split('/').pop(),db:true,t:[now-60*60000],v:[.5]})});
assert.equal(tooOld.account,null);
const store=new Map(),env={MARKET_DATA:{
 get:async k=>store.has(k)?{json:async()=>store.get(k)}:null,
 put:async(k,v)=>store.set(k,JSON.parse(v))}};
await collectExchangeCompare(env,{now,fetchImpl:fetchMock,coins:['BTC']});
const snap=store.get('market-hub/exchange-compare/v1/latest/BTC.json');
assert.deepEqual(snap.exchanges.map(x=>x.exchange),['Binance','Bybit','OKX','Bitget','Gate']);
assert.equal(snap.coverage.account,3);
assert.equal(snap.coverage.open_interest,3);
assert.equal(snap.coverage.funding,3);
for(const idx of [0,1,3]){
  const row=snap.exchanges[idx];
  assert.equal(row.status,'ok');
  assert.equal(row.backup_provider,'Swolecharts');
  assert.equal(row.account.venue,row.exchange);
  assert.equal(row.attribution_url,'https://swolecharts.com/developers');
  assert(row.errors.some(e=>e.includes('http_403')));
}
assert.equal(snap.exchanges[2].account,null);
assert.equal(snap.exchanges[4].account,null);
assert.equal(snap.order_execution,false);
assert.equal(snap.aggregation,'none');
assert(requests.some(x=>x.market==='bybit:perp:BTCUSDT'));
assert(requests.some(x=>x.market==='bitget:perp:BTCUSDT'));
console.log('PASS free Binance/Bybit/Bitget, strict venue identity, no cross-venue substitution, 403 recovery, R2');
