import {normalizeBook} from '../src/liquidity-intelligence.mjs';
const symbol='BTCUSDT';
const sources=[
 ['Bybit','https://api.bybit.com/v5/market/orderbook?category=linear&symbol=BTCUSDT&limit=100'],
 ['Binance','https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=100'],
];
for(const [name,url] of sources){
  try{
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),8000);
    let response;
    try{response=await fetch(url,{signal:controller.signal,headers:{accept:'application/json'}})}
    finally{clearTimeout(timer)}
    if(!response.ok){console.log(name,'HTTP',response.status,'provider unreachable from runner');continue}
    const raw=await response.json();
    const result=normalizeBook(name,raw,symbol,Date.now());
    console.log(name,'HTTP',response.status,'book_valid',Boolean(result),
      'levels',result?result.levels:null,
      'official_ts_path',name==='Bybit'?'result.ts':'T/E');
  }catch(e){console.log(name,'NETWORK',e.name||'unavailable')}
}
try{
 const response=await fetch('https://lumex-ai-research2.kpiplus195.workers.dev/market-hub/v1/liquidity?symbol=BTCUSDT',{signal:AbortSignal.timeout(8000)});
 console.log('CURRENT_PRODUCTION_LIQUIDITY_ROUTE_HTTP',response.status,
  response.status===401?'route exists and requires bearer':'not confirmed deployed');
}catch(e){console.log('CURRENT_PRODUCTION_WORKER_UNREACHABLE',e.name||'error')}
console.log('Diagnostics never send credentials or place orders.');
