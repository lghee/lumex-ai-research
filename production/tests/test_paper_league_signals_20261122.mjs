import assert from 'node:assert/strict';
import {signalTick,holdingsKey,legsOf,signedLedger,serveSignals,SIGNALS} from '../src/paper-league-signals.mjs';
const now=Date.UTC(2026,10,22,12);
const acc={equity:10000,positions:{BTCUSDT:{symbol:'BTCUSDT',side:'long',qty:0.02,entry:100000,last_mark:100000,stop:95000,take:110000,opened_ms:now-3600000}},memo:{}};
const st={accounts:{a:acc}};const defs=[{id:'a'}];
let d=signalTick(st,defs,now);assert.equal(d.strategies[0].seq,1);
assert.deepEqual(d.strategies[0].legs,[{symbol:'BTCUSDT',side:'long',weight:0.2,stop:95000,take:110000}]);
assert.equal(d.order_execution,false);
// price moves, trailing stop moves: same seq, stop updated, weight frozen
acc.positions.BTCUSDT.last_mark=105000;acc.positions.BTCUSDT.stop=99000;acc.equity=10100;
d=signalTick(st,defs,now+300000);assert.equal(d.strategies[0].seq,1,'no new sequence without a fill');
assert.equal(d.strategies[0].legs[0].weight,0.2);assert.equal(d.strategies[0].legs[0].stop,99000);
// new leg → seq 2
acc.positions.ETHUSDT={symbol:'ETHUSDT',side:'short',qty:1,entry:3000,opened_ms:now+600000};
d=signalTick(st,defs,now+600000);assert.equal(d.strategies[0].seq,2);assert.equal(d.strategies[0].legs.length,2);
assert.equal(d.strategies[0].changed_ms,now+600000);
// flat → seq 3 with empty legs (customers close everything)
acc.positions={};d=signalTick(st,defs,now+900000);assert.equal(d.strategies[0].seq,3);assert.deepEqual(d.strategies[0].legs,[]);assert.equal(d.strategies[0].gross,0);
assert.equal(holdingsKey({positions:{}}),'');assert.deepEqual(legsOf({equity:0,positions:{}}),[]);
// signature: HMAC over exact payload string, verifiable by Core (hash_hmac sha256)
const key='k'.repeat(40);const s=await signedLedger(d,key);
const k=await crypto.subtle.importKey('raw',new TextEncoder().encode(key),{name:'HMAC',hash:'SHA-256'},false,['verify']);
const hex=s.sig.match(/../g).map(h=>parseInt(h,16));
assert.ok(await crypto.subtle.verify('HMAC',k,new Uint8Array(hex),new TextEncoder().encode(s.payload)));
assert.deepEqual(JSON.parse(s.payload),d);
// serve: fresh signed; stale → 503; missing key → 503
const store={};const env={LUMEX_AI_LAB_WORKER_TOKEN:key,MARKET_DATA:{get:async k=>store[k]?{json:async()=>store[k]}:null}};
store[SIGNALS]=d;let r=await serveSignals(env,now+900000+60000);assert.equal(r.status,200);const body=await r.json();assert.equal(body.sig,s.sig);
r=await serveSignals(env,now+900000+31*60000);assert.equal(r.status,503);
r=await serveSignals({...env,LUMEX_AI_LAB_WORKER_TOKEN:''},now+900000);assert.equal(r.status,503);
console.log('PASS paper-league signals: seq changes only on fills, frozen weights, trailing stop updates, HMAC, freshness');
