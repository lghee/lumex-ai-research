import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
 .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {}');
const {decodeGateContractInfo,decodeGateLiquidations,gatePublicLiquidationId,
  hubValidateEvent}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const now=Date.now(),ts=now-5000;
const meta={channel:'futures.contract_info',event:'all',result:{contract:'BTC_USDT',quanto_multiplier:'0.0001'}};
assert.deepEqual(decodeGateContractInfo(meta),[{symbol:'BTCUSDT',multiplier:0.0001}]);
assert.deepEqual(decodeGateContractInfo({...meta,result:{...meta.result,quanto_multiplier:null}}),[]);
const frame={channel:'futures.public_liquidates',event:'update',result:[
 {contract:'BTC_USDT',price:'65000',size:'-250',time_ms:ts},
 {contract:'BTC_USDT',price:'65001',size:'12.5',time_ms:ts+1},
 {contract:'DOGE_USDT',price:'0.1',size:'999',time_ms:ts},
 {contract:'BTC_USDT',price:'65002',size:'-11',time_ms:now-800000}
]};
assert.deepEqual(decodeGateLiquidations(frame,{},now),[],'no fake notional without official quanto multiplier');
const events=decodeGateLiquidations(frame,{BTCUSDT:0.0001},now);
assert.equal(events.length,2);
assert.equal(events[0].quantity,0.025);
assert.equal(events[0].side,'sell');
assert.equal(events[0].position_side,'long');
assert.equal(events[0].price_type,'unspecified','price is order price, not executed fill');
assert.equal(events[1].quantity,0.00125);
assert.equal(events[1].position_side,'short');
const id=await gatePublicLiquidationId(events[0]);
assert.match(id,/^gateio:liq:BTCUSDT:[a-f0-9]{32}$/);
assert.equal(id,await gatePublicLiquidationId(events[0]),'replay must use the same exact dedupe id');
assert.notEqual(id,await gatePublicLiquidationId(events[1]));
assert(source.includes("'futures.contract_info','futures.public_liquidates'"),
 'real Cloudflare Gate socket must subscribe to both official channels');
assert(source.includes('this.ctx.waitUntil(this.ingestItems(observed))'),
 'observed gate liquidation events must flow to native MarketEventHub->R2');
assert(source.includes('gate_public_liquidations:{...this.metrics.gate_public_liquidations,'),
 'the public health API must expose actual subscription/event evidence');
console.log('PASS Gate public liquidation decoding: verified contract size, original source, no invented USD, stable dedupe, Cloudflare sink');
