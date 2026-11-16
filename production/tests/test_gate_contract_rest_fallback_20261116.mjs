import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
 .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {}');
const {MarketLiveCollector,decodeGateLiquidations}=
 await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const orig=globalThis.fetch,requests=[];
try{
 globalThis.fetch=async(url)=>{
  const contract=String(url).split('/').at(-1);requests.push(contract);
  return new Response(JSON.stringify({name:contract,type:'direct',quanto_multiplier:'0.0001'}),
   {status:200,headers:{'content-type':'application/json'}});
 };
 const collector=new MarketLiveCollector({}, {AUTO_LIVE_STREAM:'true'});
 await collector.refreshGateMultipliers();
 assert.equal(requests.length,4,'four real Gate contract metadata reads');
 assert.deepEqual(Object.keys(collector.gateMultipliers).sort(),['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT']);
 const time=Date.now()-5000;
 const liqs=decodeGateLiquidations({channel:'futures.public_liquidates',event:'update',result:[
  {contract:'BTC_USDT',price:'65980',size:'-100',time_ms:time}
 ]},collector.gateMultipliers,Date.now());
 assert.equal(liqs.length,1);
 assert.equal(liqs[0].quantity,0.01,'must multiply contracts by verified real quanto multiplier');
 assert.equal(liqs[0].source,'gateio');
 assert.equal(liqs[0].price_type,'unspecified');
 const previous=collector.lastGateMultiplierFetch;
 await collector.refreshGateMultipliers();
 assert(collector.lastGateMultiplierFetch>=previous);
 globalThis.fetch=async(url)=>new Response(JSON.stringify({
   name:'EVIL_CONTRACT',type:'direct',quanto_multiplier:'1.0'
 }),{status:200});
 const bad=new MarketLiveCollector({}, {AUTO_LIVE_STREAM:'true'});
 await bad.refreshGateMultipliers();
 assert.equal(Object.keys(bad.gateMultipliers).length,0,'never accept wrong contract identity');
}finally{globalThis.fetch=orig}
console.log('PASS Gate public contract-info REST fallback, exact identity match and unit-correct liquidation size');
