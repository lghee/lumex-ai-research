import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const raw=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
  .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }');
const mod=await import('data:text/javascript;base64,'+Buffer.from(raw).toString('base64'));
class Store {
  objects=new Map();
  async get(k){const v=this.objects.get(k);return v&&{size:v.bytes.byteLength,customMetadata:v.metadata,
    text:async()=>new TextDecoder().decode(v.bytes),json:async()=>JSON.parse(new TextDecoder().decode(v.bytes))};}
  async head(k){const v=this.objects.get(k);return v&&{size:v.bytes.byteLength,customMetadata:v.metadata};}
  async put(k,x,opt={}){const bytes=x instanceof ArrayBuffer?new Uint8Array(x):
    typeof x==='string'?new TextEncoder().encode(x):new Uint8Array(x);
    this.objects.set(k,{bytes,metadata:opt.customMetadata||{}});}
}
function build(interval){
  const step=interval*60000;
  const latest=Math.floor(Date.now()/step)*step-step;
  const count=Math.ceil(90*1440/interval)+270;
  const rows=['timestamp,open,high,low,close,volume'];
  for(let i=count-1;i>=0;i--){
    const ts=latest-i*step;
    rows.push(`${ts},100,102,99,101,${interval===60?48:12}`);
  }
  return rows.join('\n')+'\n';
}
const clean15=build(15);const clean60=build(60);
const R2=new Store();
let csv=clean15,source='gateio_usdt_perpetual';
const env={MARKET_DATA:R2,AUTO_FETCH:'true',AUTO_RESEARCH:'false',AUTO_AI:'false',
  LUMEX_CONTAINER_KEY:'x'.repeat(64),LUMEX_ADMIN_API_TOKEN:'y'.repeat(64),
  RESEARCH_CONTAINER:{getByName:()=>({fetch:async()=>new Response(csv,{headers:{'X-Lumex-Market-Source':source}})})}};
async function run(interval){
  const msg={body:{kind:'fetch',symbol:'BTCUSDT',interval_min:interval},attempts:1,
    ack(){this.acked=true;},retry(){this.retried=true;}};
  await mod.default.queue({messages:[msg]},env);return msg;
}
assert((await run(15)).acked);
assert.equal((await R2.head('market/BTCUSDT_15.csv')).customMetadata.schema,'ohlcv_v2');
csv=clean60;
assert((await run(60)).acked,'clean 15/60 market must reconcile');
let old60=await R2.head('market/BTCUSDT_60.csv');
assert.equal(old60.customMetadata.quality,'verified');
// Inflated volume on one fully completed hour must be caught before R2 write.
const lines=clean60.trimEnd().split('\n');
const fields=lines[500].split(',');fields[5]='400';lines[500]=fields.join(',');
csv=lines.join('\n')+'\n';
const corrupted=await run(60);
assert(corrupted.retried,'cross-frame mismatch must reject update');
assert.equal((await R2.head('market/BTCUSDT_60.csv')).size,old60.size,'old good data untouched');
const diagnostic=await(await R2.get('control/last-market-fetch.json')).json();
assert.equal(diagnostic.ok,false);assert.match(diagnostic.error,/cross_frame_15m_60m_mismatch/);
console.log('PASS cross-interval quality: verified 15m+60m aggregate, bad 60m quarantined, R2 unmodified');
