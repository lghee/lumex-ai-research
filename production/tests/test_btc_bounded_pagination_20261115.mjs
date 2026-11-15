import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const src=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
 .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}');
const {BtcReserveCollector,nativeWhaleWatchlistBackfillProof}=
  await import('data:text/javascript;base64,'+Buffer.from(src).toString('base64'));
const addr='34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo',now=Math.floor(Date.now()/1000);
const tx=(i)=>({txid:i.toString(16).padStart(64,'0'),status:{confirmed:true,block_time:now-60-i},
 vin:[{prevout:{scriptpubkey_address:addr,value:100000000}}],
 vout:[{scriptpubkey_address:addr,value:200000000}]});
const pages=[
 Array.from({length:25},(_,i)=>tx(i+1)),
 Array.from({length:25},(_,i)=>tx(i+26)),
 Array.from({length:25},(_,i)=>tx(i+51)),
 Array.from({length:10},(_,i)=>tx(i+76))
];
const map=new Map(),storage={get:async(k)=>map.get(k),put:async(k,v)=>map.set(k,v)};
const env={AUTO_WHALE_FETCH:'true',MARKET_EVENT_HUB:{getByName:()=>({
 fetch:async req=>new Response(JSON.stringify({ok:true,accepted:(await req.json()).events.length}),{status:200})
})}};
const collector=new BtcReserveCollector({storage},env);
let calls=0;
collector.watchlist=async()=>({items:[{address:addr,label:'Binance'}],mode:'wordpress_configured'});
collector.fetchPage=async()=>{const x=pages[calls++];if(!x)throw Error('excess_paginate');return x};
const result=await collector.poll();
assert.equal(result.ok,true,'successful bounded history');
assert.equal(calls,4,'one newest and three bounded historic pages');
assert.equal(result.backfill_complete,true);
const status=await (await collector.fetch(new Request('https://whales/status'))).json();
assert.equal(status.watchlist_count,1);
assert.equal(status.watchlist[0].backfill_complete,true);
assert.equal(nativeWhaleWatchlistBackfillProof(status,Date.now()),true);
collector.fetchPage=async()=>{calls++;return pages[0]};
assert.equal((await collector.poll()).backfill_complete,true,'complete scan must not regress on 25 latest transactions');
assert.equal(calls,5,'no unnecessary historical page after completion');
console.log('PASS bounded BTC 35-day Esplora scan + persistent completion + strict native proof');
