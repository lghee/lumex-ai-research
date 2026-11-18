import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const s=(await readFile(new URL('../src/index.js',import.meta.url),'utf8')).replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {}');
const {observedAnalyticView}=await import('data:text/javascript;base64,'+Buffer.from(s).toString('base64'));
const now=Date.now(),start=now-7200000,end=now-3600000;
const rows=['bybit','binance','gateio'].map((source,i)=>({source,ts:start+60000*(i+1),payload:JSON.stringify({id:source+'-test',price:100,quantity:2,position_side:'long'})}));
const sql={exec(query,...args){assert(query.includes("source IN ('bybit','binance')"));return {toArray:()=>rows.filter(r=>['bybit','binance'].includes(r.source))}}};
for(const path of ['/observed-pressure','/observed-replay?start_ms='+start+'&end_ms='+end]){
 const res=observedAnalyticView(sql,new URL('https://hub'+path),now);
 assert.equal(res.status,200);
 const data=await res.json();
 assert.equal(data.ok,true);assert.equal(data.exchange_counts.Bybit,1);assert.equal(data.exchange_counts.Binance,1);
 if(data.events)assert.equal(data.events.length,2);
}
const broken={exec:()=>({toArray:()=>[{...rows[0],payload:'bad'}]})};
assert.equal(observedAnalyticView(broken,new URL('https://hub/observed-pressure'),now).status,503);
console.log('PASS Gate rows no longer poison Bybit/Binance pressure/replay; malformed in-scope records still rejected');
