import assert from 'node:assert/strict';
import {normalizeAlternative,alternativeBooks} from '../src/liquidity-futures-alternatives.mjs';
import {sampleLiquidity} from '../src/liquidity-intelligence.mjs';
const now=Date.UTC(2026,10,21,8,0),symbol='BTCUSDT';
const gateBook={current:now/1000,update:now/1000,
 bids:[{p:'94998',s:10},{p:'94997',s:20}],asks:[{p:'95002',s:10},{p:'95003',s:20}]};
const gateMeta={name:'BTC_USDT',type:'direct',quanto_multiplier:'0.0001'};
const okxBook={code:'0',data:[{ts:String(now),bids:[['94996','10','0','3'],['94995','20','0','3']],
 asks:[['95004','10','0','3'],['95005','20','0','3']]}]};
const okxMeta={code:'0',data:[{instId:'BTC-USDT-SWAP',instType:'SWAP',ctType:'linear',
 ctVal:'0.01',ctMult:'1',ctValCcy:'BTC',settleCcy:'USDT',state:'live'}]};
const gate=normalizeAlternative('Gate',gateBook,gateMeta,symbol,now);
const okx=normalizeAlternative('OKX',okxBook,okxMeta,symbol,now);
assert.equal(gate.bids[0][1],0.001);
assert.equal(okx.bids[0][1],0.1);
assert.equal(gate.unit_proof,'contract_quanto_multiplier');
assert.equal(okx.unit_proof,'linear_ctVal_ctMult');
assert.equal(normalizeAlternative('Gate',gateBook,{name:'BTC_USDT',type:'direct'},symbol,now),null);
assert.equal(normalizeAlternative('OKX',okxBook,{...okxMeta,data:[{...okxMeta.data[0],ctValCcy:'USD'}]},symbol,now),null);
assert.equal(normalizeAlternative('OKX',{...okxBook,data:[{...okxBook.data[0],ts:String(now-25000)}]},okxMeta,symbol,now),null);
let requests=0;
const fetchImpl=async url=>{
 requests++;
 if(url.includes('api.bybit.com'))return {ok:false,status:403,headers:new Headers(),text:async()=>''};
 if(url.includes('fapi.binance.com'))return {ok:false,status:451,headers:new Headers(),text:async()=>''};
 let doc=url.includes('gateio')?(url.includes('order_book')?gateBook:gateMeta):
   (url.includes('market/books')?okxBook:okxMeta);
 return {ok:true,status:200,headers:new Headers(),text:async()=>JSON.stringify(doc)};
};
const alt=await alternativeBooks(symbol,{now,fetchImpl});
assert.equal(alt.length,2);
const data=await sampleLiquidity(symbol,{now,fetchImpl});
assert.equal(data.venues.length,2);
assert.equal(data.available_venues,2);
assert.equal(data.venue_target,4);
assert.deepEqual(data.venues.map(v=>v.exchange),['Gate','OKX']);
assert.equal(data.orders_enabled,false);
assert.equal(requests,10); // four alternative-only + two blocked + four metadata and depth
console.log('PASS real-format Gate/OKX futures metadata conversion and geo-block alternative fallback');
