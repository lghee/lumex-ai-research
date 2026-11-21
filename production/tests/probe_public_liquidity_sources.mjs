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
for(const [name,url] of [
 ['Gate futures','https://api.gateio.ws/api/v4/futures/usdt/order_book?contract=BTC_USDT&limit=50'],
 ['Gate contract','https://api.gateio.ws/api/v4/futures/usdt/contracts/BTC_USDT'],
 ['OKX swap','https://www.okx.com/api/v5/market/books?instId=BTC-USDT-SWAP&sz=50'],
 ['OKX contract','https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=BTC-USDT-SWAP']
]){
 try{
  const response=await fetch(url,{signal:AbortSignal.timeout(8000)});
  const raw=response.ok?await response.json():null;
  const count=name==='Gate futures'?raw?.bids?.length:name==='OKX swap'?raw?.data?.[0]?.bids?.length:null;
  const multiplier=name==='Gate contract'?raw?.quanto_multiplier:name==='OKX contract'?raw?.data?.[0]?.ctVal:null;
  console.log('ALTERNATIVE',name,'HTTP',response.status,'levels',count,'multiplier',multiplier);
 }catch(e){console.log('ALTERNATIVE',name,'NETWORK',e.name||'error')}
}
try{
 const response=await fetch('https://lumex-ai-research2.kpiplus195.workers.dev/market-hub/v1/liquidity?symbol=BTCUSDT',{signal:AbortSignal.timeout(8000)});
 console.log('CURRENT_PRODUCTION_LIQUIDITY_ROUTE_HTTP',response.status,
  response.status===401?'route exists and requires bearer':'not confirmed deployed');
}catch(e){console.log('CURRENT_PRODUCTION_WORKER_UNREACHABLE',e.name||'error')}
console.log('Diagnostics never send credentials or place orders.');
