import assert from 'node:assert/strict';
import {issuedSat,subsidySat,normalizeBlocks,normalizeMempool,collectBtcOnchain,btcOnchainRoute} from '../src/btc-onchain.mjs';
const now=Date.now(),z=i=>i.toString(16).padStart(64,'0');
const rows=Array.from({length:10},(_,i)=>({id:z(100-i),previousblockhash:z(99-i),height:900000-i,timestamp:Math.floor(now/1000)-600*i,tx_count:1500,weight:3000000,difficulty:100e12}));
assert.equal(subsidySat(840000),312500000);assert.equal(issuedSat(209999),1050000000000000);assert.equal(issuedSat(210000),1050002500000000);
assert.equal(normalizeBlocks(rows,now).length,10);assert.throws(()=>normalizeBlocks([rows[0],...rows.slice(2)],now));assert.throws(()=>normalizeBlocks(rows,now+7*3600000));
assert.equal(normalizeMempool({count:0,vsize:0,total_fee:0}).count,0);assert.throws(()=>normalizeMempool({count:-1,vsize:0,total_fee:0}));
const store=new Map(),bucket={get:async k=>store.has(k)?{json:async()=>JSON.parse(store.get(k))}:null,put:async(k,v)=>store.set(k,v)};
const oldFetch=globalThis.fetch;
try{globalThis.fetch=async url=>new Response(JSON.stringify(url.endsWith('/blocks')?rows:{count:120,vsize:50000,total_fee:15000}));
await collectBtcOnchain({MARKET_DATA:bucket},now);let d=await (await btcOnchainRoute(new Request('https://example.com'),{MARKET_DATA:bucket})).json();assert.equal(d.network.tip_height,900000);assert.equal(d.mempool.count,120);assert.equal(d.history.length,1);
globalThis.fetch=async()=>new Response('',{status:503});await collectBtcOnchain({MARKET_DATA:bucket},now+60000);d=await (await btcOnchainRoute(new Request('https://example.com'),{MARKET_DATA:bucket})).json();assert.equal(d.network.observed_ms,now);assert.equal(d.mempool.observed_ms,now);assert.equal(d.errors.length,2);assert.equal(d.history.length,1);assert.equal((await btcOnchainRoute(new Request('https://example.com',{method:'POST'}),{MARKET_DATA:bucket})).status,405);
}finally{globalThis.fetch=oldFetch}
console.log('BTC onchain: subsidy, validation, write/read, stale preservation, GET-only passed');

const {normalizeDaily,collectBtcOnchainDaily,btcOnchainDailyRoute}=await import('../src/btc-onchain.mjs');
const today=Math.floor(now/86400000)*86400,raw=Array.from({length:1500},(_,i)=>({t:today-(1499-i)*86400,o:'100',h:'110',l:'90',c:'105',v:25}));
assert.equal(normalizeDaily(raw,now).length,1499);
assert.throws(()=>normalizeDaily(raw.filter((_,i)=>i!==50),now));
assert.throws(()=>normalizeDaily([...raw.slice(0,-1),raw[2]],now));
assert.throws(()=>normalizeDaily(raw.slice(0,-5),now));
assert.throws(()=>normalizeDaily(raw.map((x,i)=>i===8?{...x,l:'300'}:x),now));
try{globalThis.fetch=async()=>new Response(JSON.stringify(raw));
await collectBtcOnchainDaily({MARKET_DATA:bucket},now);
let d=await (await btcOnchainDailyRoute(new Request('https://example.com'),{MARKET_DATA:bucket})).json();
assert.equal(d.candles.length,1499);assert.equal(d.candles.at(-1).t,today-86400);
globalThis.fetch=async()=>{throw Error('must not refetch valid closed day')};
await collectBtcOnchainDaily({MARKET_DATA:bucket},now+60000);
assert.equal((await btcOnchainDailyRoute(new Request('https://example.com',{method:'POST'}),{MARKET_DATA:bucket})).status,405);
}finally{globalThis.fetch=oldFetch}
console.log('BTC Gate daily: history, current candle exclusion, gap/stale/duplicate rejection and cached read passed');
