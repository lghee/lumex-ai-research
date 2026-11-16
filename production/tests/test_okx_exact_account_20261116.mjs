import assert from 'node:assert/strict';
import {readOKX,buildExchangeComparison} from '../src/exchange-compare.mjs';
const now=Date.parse('2026-11-16T03:00:00Z');
const ts=now-2*60*1000;
const body=x=>({ok:true,text:async()=>JSON.stringify(x)});
const okxFixture=async(url)=>{
  const u=new URL(url);
  if(u.pathname.endsWith('/long-short-account-ratio-contract')){
    assert.equal(u.searchParams.get('instId'),'BTC-USDT-SWAP');
    assert.equal(u.searchParams.get('period'),'5m');
    assert.equal(u.searchParams.get('limit'),'2');
    assert(!u.searchParams.has('ccy')); // must not mix all BTC contracts
    return body({code:'0',data:[[String(ts-300000),'2'],[String(ts),'3']]});
  }
  if(u.pathname.endsWith('/open-interest'))return body({code:'0',data:[
    {instId:'BTC-USDT-SWAP',oiUsd:'2340000000',ts:String(ts)}]});
  if(u.pathname.endsWith('/funding-rate'))return body({code:'0',data:[
    {instId:'BTC-USDT-SWAP',fundingRate:'0.000075',ts:String(ts)}]});
  throw Error('unexpected venue URL');
};
const x=await readOKX('BTC',okxFixture,now);
assert.equal(x.status,'ok');
assert.equal(x.account.source,'okx_rubik_usdt_swap_account_ratio_5min');
assert.equal(x.account.market_scope,'single_usdt_swap_contract');
assert.equal(x.account.method,'derived_from_account_long_short_ratio');
assert.equal(x.account.long_pct,75);
assert.equal(x.account.short_pct,25);
assert.equal(x.open_interest.value,2340000000);
assert.equal(x.funding.rate_pct,.0075);
let calls=0;
const rateLimitOnce=async url=>{
  if(url.includes('long-short-account-ratio-contract')){
    calls++;
    if(calls===1)return {ok:false,status:429,text:async()=>''};
  }
  return okxFixture(url);
};
const recovered=await readOKX('BTC',rateLimitOnce,now);
assert.equal(calls,2);
assert.equal(recovered.account.long_pct,75);
assert.equal(recovered.status,'ok');
let fundingCalls=0;
const fundingLimited=await readOKX('BTC',async url=>{
  if(url.includes('/public/funding-rate')){
    fundingCalls++;
    if(fundingCalls===1)return {ok:false,status:429,text:async()=>''};
  }
  return okxFixture(url);
},now);
assert.equal(fundingCalls,2);
assert.equal(fundingLimited.status,'ok');
assert.equal(fundingLimited.funding.rate_pct,.0075);
const old=await readOKX('BTC',async url=>{
  if(url.includes('long-short-account-ratio-contract'))
    return body({code:'0',data:[[String(now-35*60000),'2.7']]});
  return okxFixture(url);
},now);
assert.equal(old.account,null);
assert.equal(old.status,'partial');
assert.equal(old.open_interest.value,2340000000);
console.log('PASS OKX BTC-USDT-SWAP exact source, newest timestamp selection, 429 backoff recovery, stale rejection');
