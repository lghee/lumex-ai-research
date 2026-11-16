import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const raw=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
 .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {}');
const {BtcReserveCollector}=await import('data:text/javascript;base64,'+Buffer.from(raw).toString('base64'));
const address='34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo';
const ctx={storage:{get:async()=>({watchlist_source:'wordpress_configured',watchlist_count:2,
 addresses:{[address]:{label:'Binance',backfill_complete:true,checked_ms:Date.now()-20000},
 ['3M219KR5vEneNb47ewrPfWyb5jQ2DjxRP6']:{label:'Binance',backfill_complete:false,error:'esplora_response_oversize'}}})}};
const collector=new BtcReserveCollector(ctx,{AUTO_WHALE_FETCH:'true'});
const status=await (await collector.fetch(new Request('https://whales/status'))).json();
assert.equal(status.active_error_count,1);
assert.equal(status.pending_backfill_count,1);
assert.equal(status.last_error,'active_address_failures');
const original=globalThis.fetch;
try{
 globalThis.fetch=async()=>new Response('['+' '.repeat(2700000)+']',{status:200,headers:{'content-type':'application/json'}});
 const page=await collector.fetchPage(address);assert.deepEqual(page,[]);
 globalThis.fetch=async()=>new Response('['+' '.repeat(10000001)+']',{status:200,headers:{'content-type':'application/json'}});
 await assert.rejects(()=>collector.fetchPage(address),/esplora_response_oversize/);
}finally{globalThis.fetch=original}
console.log('PASS Esplora high-volume payload, strict 10 MB cap, address failure health visibility');
