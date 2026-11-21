/** Diagnostic only. No keys, orders, or private data. */
const API='https://api.hyperliquid.xyz/info';
const test=async body=>{
 const r=await fetch(API,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
  signal:AbortSignal.timeout(12000)});
 const raw=r.ok?await r.json():null;
 return {status:r.status,raw};
};
try{
 const now=Date.now();
 const candle=await test({type:'candleSnapshot',req:{coin:'BTC',interval:'1h',startTime:now-86400000,endTime:now}});
 console.log('Hyperliquid candles HTTP',candle.status,'rows',Array.isArray(candle.raw)?candle.raw.length:'unavailable',
  'first keys',Array.isArray(candle.raw)?Object.keys(candle.raw[0]||{}).sort().join(','):'none');
}catch(e){console.log('Hyperliquid candles network',e.name||'unavailable')}
try{
 const r=await fetch('https://lumex-ai-research2.kpiplus195.workers.dev/market-hub/v1/hyperliquid-whales',{
  signal:AbortSignal.timeout(8000)});
 const doc=r.ok?await r.json():null;
 const wallet=doc?.rows?.[0]?.address;
 console.log('Existing Worker leaderboard HTTP',r.status,'tracked wallets',doc?.rows?.length||0);
 if(wallet&&/^0x[0-9a-f]{40}$/.test(wallet)){
  const p=await test({type:'portfolio',user:wallet});
  console.log('Hyperliquid portfolio HTTP',p.status,'period names',
    Array.isArray(p.raw)?p.raw.map(x=>x?.[0]).slice(0,12).join(','):'unavailable');
 }
}catch(e){console.log('Hyperliquid tracked portfolio check',e.name||'unavailable')}
