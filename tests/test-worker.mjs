import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
// Local Node QA cannot import Cloudflare's virtual workers module.
const source=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
 .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {}');
const handler=(await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))).default;
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
