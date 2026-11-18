import assert from 'node:assert/strict';
import {scheduledRegimeResearch,privateRegimeReport} from '../src/regime-research.mjs';

const stored=new Map();
const bucket={
 get:async key=>stored.has(key)?{json:async()=>JSON.parse(stored.get(key))}:null,
 put:async(key,blob)=>{stored.set(key,String(blob))}
};
const token='T'.repeat(64),time=Date.parse('2026-11-18T08:15:00.000Z');
let calls=0;
const valid={
 ok:true,schema:'lumex_regime_meta_research_v1',
 data_sha256:'a'.repeat(64),aligned_bars_per_symbol:3300,
 live_approved:false,order_execution:false,
 promotion:'PROHIBITED_UNTIL_INDEPENDENT_FORWARD_AND_ADMIN_APPROVAL',
 retrospective_gate_passed:false
};
const env={MARKET_DATA:bucket,LUMEX_AI_LAB_WORKER_TOKEN:token,LUMEX_CONTAINER_KEY:'K'.repeat(64),
 RESEARCH_CONTAINER:{getByName:()=>({fetch:async()=>{calls++;return new Response(JSON.stringify(valid),{status:200})}})}};
const unauthorized=await privateRegimeReport(new Request('https://research/market-hub/v1/regime-research-report'),env);
assert.equal(unauthorized.status,401);
let state=await scheduledRegimeResearch(env,time);
assert.equal(state.ok,true);assert.equal(calls,1);
const authorized=await privateRegimeReport(new Request('https://research/market-hub/v1/regime-research-report',{headers:{authorization:'Bearer '+token}}),env);
assert.equal(authorized.status,200);
const report=await authorized.json();
assert.equal(report.latest.live_approved,false);
assert.equal(report.latest.order_execution,false);
assert.equal(report.latest.storage,'cloudflare_r2_research_only');
state=await scheduledRegimeResearch(env,time+300000);
assert.equal(state.skipped,'already_completed');
assert.equal(calls,1);
assert.equal((await privateRegimeReport(new Request('https://research',{method:'POST'}),env)).status,405);
console.log('PASS research-only authenticated report, durable daily dedupe, no orders');
