/** Read only. Inspect Gate public taker trade schema; do not assert continuous coverage. */
const root='https://api.gateio.ws/api/v4';
const requests=[
 ['spot',root+'/spot/trades?currency_pair=BTC_USDT&limit=100'],
 ['futures',root+'/futures/usdt/trades?contract=BTC_USDT&limit=100'],
 ['contract',root+'/futures/usdt/contracts/BTC_USDT']
];
const now=Date.now();
for(const [name,url] of requests){
 try{
  const r=await fetch(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(10000)});
  const body=r.ok?await r.json():null;
  const sample=Array.isArray(body)?body[0]:body;
  if(name==='contract'){
   console.log('GATE_FLOW_PROBE',name,'HTTP',r.status,'contract',sample?.name,
    'type',sample?.type,'quanto_multiplier',sample?.quanto_multiplier);
  }else{
   const ms=Number(sample?.create_time_ms||0);
   console.log('GATE_FLOW_PROBE',name,'HTTP',r.status,'count',Array.isArray(body)?body.length:0,
    'schema_keys',Object.keys(sample||{}).slice(0,20).join(','),
    'timestamp_age_seconds',ms?Math.round((now-ms)/1000):null,
    'side_or_size',name==='spot'?sample?.side:(sample?.size>0?'positive':sample?.size<0?'negative':null),
    'has_id',Boolean(sample?.id),'read_only',true);
  }
 }catch(e){console.log('GATE_FLOW_PROBE',name,'SOURCE_UNAVAILABLE',e.name||'network_error')}
}
console.log('PROBE_ONLY: no continuity guarantee, no live collection enabled');
