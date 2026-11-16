import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
// Local Node QA cannot import Cloudflare's virtual workers module.
const source=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
 .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {}');
const workerModule=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const handler=workerModule.default;
const env={LUMEX_SITE_URL:'https://lumexbot.com',LUMEX_ADMIN_API_TOKEN:'x'.repeat(48),
 AUTO_FETCH:'false',AUTO_RESEARCH:'false',AUTO_AI:'false'};
async function get(path,headers={}){return handler.fetch(new Request('https://example.workers.dev'+path,{headers}),env);}
const health=await get('/health');assert.equal(health.status,200);
const data=await health.json();assert.equal(data.version,'1.1.7');assert.equal(data.auto_research,false);assert.equal(data.trading_enabled,false);
assert.equal((await get('/status')).status,401);
assert.equal((await get('/admin/order')).status,401);
const status=await get('/status',{authorization:'Bearer '+env.LUMEX_ADMIN_API_TOKEN});
assert.equal(status.status,200);const body=await status.json();
assert.equal(body.trading_enabled,false);assert.equal(body.has_wordpress_token,false);
console.log('PASS bootstrap Worker 1.1.7: health, bearer authorization, no order routes, secret absence');

const a='34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo';
const b='3M219KR5vEneNb47ewrPfWyb5jQ2DjxRP6';
const watch=[{address:a,label:'Binance'},{address:b,label:'Binance'}];
const txBase={txid:'a'.repeat(64),status:{confirmed:true,block_time:Math.floor(Date.now()/1000)-60}};
assert.equal(workerModule.decodeBtcTrackedNet({...txBase,vin:[{prevout:{scriptpubkey_address:a,value:200000000}}],vout:[{scriptpubkey_address:b,value:200000000}]},watch),null,'internal reserve transfer must not inflate flows');
const inbound=workerModule.decodeBtcTrackedNet({...txBase,vin:[{prevout:{scriptpubkey_address:'external',value:500000000}}],vout:[{scriptpubkey_address:a,value:500000000}]},watch);
assert.equal(inbound?.side,'in');
assert.equal(inbound?.quantity,5);
assert.equal(inbound?.watch_label,'Binance');
assert.equal(workerModule.decodeBtcTrackedNet({...txBase,vin:[{prevout:{scriptpubkey_address:a,value:100000000}}],vout:[{scriptpubkey_address:'external',value:100000000}]},watch)?.side,'out');
