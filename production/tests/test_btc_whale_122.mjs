import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const s=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
 .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {}');
const mod=await import('data:text/javascript;base64,'+Buffer.from(s).toString('base64'));
const {decodeBtcAddressFlow,BtcReserveCollector,default:handler}=mod;
const address='34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo';
const now=Math.floor(Date.now()/1000),txid='a'.repeat(64);
const tx={txid,status:{confirmed:true,block_time:now},
  vin:[{prevout:{scriptpubkey_address:address,value:100000000}}],
  vout:[{scriptpubkey_address:address,value:300000000},{scriptpubkey_address:'another',value:100000000}]};
const flow=decodeBtcAddressFlow(tx,address,'Binance legacy');
assert.equal(flow.side,'in');assert.equal(flow.quantity,2);assert.equal(flow.price,0);
assert.equal(flow.capture,'confirmed_chain_poll');assert.equal(flow.txhash,txid);
assert.equal(decodeBtcAddressFlow({...tx,status:{confirmed:false}},address),null);
assert.equal(decodeBtcAddressFlow({...tx,vout:[{scriptpubkey_address:address,value:100000000}]},address),null);
const out=decodeBtcAddressFlow({...tx,vout:[{scriptpubkey_address:address,value:1}]},address);
assert.equal(out.side,'out');assert(out.quantity>0);
const state=new Map();let ingested=[];
const storage={async get(k){return state.get(k)},async put(k,v){state.set(k,v)}};
const env={AUTO_WHALE_FETCH:'true',LUMEX_AI_LAB_WORKER_TOKEN:'w'.repeat(64),
 MARKET_EVENT_HUB:{getByName:s=>({fetch:async req=>{
  assert.equal(s,'BTCUSDT');const data=await req.json();ingested.push(...data.events);
  return new Response(JSON.stringify({ok:true,accepted:data.events.length}),{status:200});
 }})},
 MARKET_DATA:{async list(){return {objects:[],truncated:false}}}};
const orig=globalThis.fetch;
let blockCalls=0,forceWpStatus=404;
globalThis.fetch=async url=>{
 const u=new URL(url);
 if(u.hostname==='lumexbot.com')return new Response('not available',{status:forceWpStatus});
 if(u.hostname==='blockstream.info'){
  blockCalls++;
  return new Response(JSON.stringify([tx]),{status:200,headers:{'content-type':'application/json'}});
 }
 throw Error('unexpected origin '+u.hostname);
};
const collector=new BtcReserveCollector({storage},env);
let result=await (await collector.fetch(new Request('https://test/poll'))).json();
assert.equal(result.ok,true);assert.equal(result.accepted,1);
assert.equal(result.watchlist_source,'legacy_seed_fallback');
assert.equal(ingested.length,1);assert.equal(ingested[0].watched_address,address);
assert.equal((await (await collector.fetch(new Request('https://test/status'))).json()).accepted,1);
const archiveStatus=await (await handler.fetch(new Request('https://test/market-hub/v1/archive-health'),env)).json();
assert.equal(archiveStatus.schema,'lumex_archive_recent_health_v2');
assert.equal(archiveStatus.list_checks,12);
assert.equal(archiveStatus.recent_liquidation_sample_verified,false);
assert.equal(archiveStatus.safe_to_disable_wordpress_crons,false);
forceWpStatus=403;
result=await (await collector.fetch(new Request('https://test/poll'))).json();
assert.equal(result.ok,false);assert.equal(result.error,'wordpress_watchlist_http_403');
assert.equal(blockCalls,1,'WP 403 must not trigger public fallback');
globalThis.fetch=orig;
console.log('PASS 1.2.2 BTC confirmed address net flows, watchlist fallback only on 404, 403 blocked, R2 audit');
