import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const raw=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
 .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {}');
const {chooseWhalePollAddresses}=await import('data:text/javascript;base64,'+Buffer.from(raw).toString('base64'));
const items=Array.from({length:63},(_,i)=>({address:'address'+i,label:'Binance'})),now=Date.now();
const records=Object.fromEntries(items.map((x,i)=>[x.address,{
 backfill_complete:i!==40,gap_possible:false,checked_ms:now-i*60000,error:null
}]));
let saw=0,seen=new Set(),nextIndex=0;
for(let i=0;i<24;i++){
 const result=chooseWhalePollAddresses(items,records,nextIndex,now);
 assert.equal(result.selected.length,4,'exact same bounded provider budget');
 assert.equal(new Set(result.selected.map(x=>x.address)).size,4,'no duplicate provider requests in one cycle');
 if(result.selected.some(x=>x.address===items[40].address))saw++;
 result.selected.forEach(x=>seen.add(x.address));nextIndex=result.nextIndex;
}
assert.equal(saw,24,'single incomplete address receives one retry/minute without more requests');
assert(seen.size>40,'other watchlist addresses remain in fair rotation');
assert.equal(chooseWhalePollAddresses(items,records,0,now).nextIndex,4);
const errored={...records,[items[40].address]:{
 backfill_complete:false,error:'esplora_http_429',last_attempt_ms:now-45000,checked_ms:now-1000000
}};
const r=chooseWhalePollAddresses(items,errored,0,now);
assert(!r.selected.some(x=>x.address===items[40].address),'429 rate-limited address is not immediately reprioritized');
console.log('PASS incomplete BTC address backfill fairness, 4/min rate bound, 429 cooldown and no provider count inflation');
