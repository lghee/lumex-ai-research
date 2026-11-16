import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const src=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
 .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {}');
const {MarketLiveCollector}=await import('data:text/javascript;base64,'+Buffer.from(src).toString('base64'));
const prior=globalThis.fetch;
try{
 globalThis.fetch=async()=>new Response('forbidden',{status:403});
 const live=new MarketLiveCollector({}, {AUTO_LIVE_STREAM:'true'});
 await live.refreshGateMultipliers();
 const health=live.safeStatus();
 assert.equal(health.gate_public_liquidations.contracts_ready,0);
 assert.equal(health.gate_public_liquidations.metadata_error_count,4);
 assert.equal(health.gate_public_liquidations.metadata_last_error,'gate_contract_http_403');
 assert(health.gate_public_liquidations.metadata_attempt_ms>0);
}finally{globalThis.fetch=prior}
console.log('PASS Gate real metadata error health is never reported as source-ready');
