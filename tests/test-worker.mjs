import assert from 'node:assert/strict';
import handler from '../src/index.js';
const env={LUMEX_SITE_URL:'https://lumexbot.com',LUMEX_ADMIN_API_TOKEN:'x'.repeat(48)};
async function get(path,headers={}){return handler.fetch(new Request('https://example.workers.dev'+path,{headers}),env);}
const health=await get('/health');assert.equal(health.status,200);assert.equal((await health.json()).research_enabled,false);
assert.equal((await get('/status')).status,401);
assert.equal((await get('/admin/order')).status,404);
const status=await get('/status',{authorization:'Bearer '+env.LUMEX_ADMIN_API_TOKEN});assert.equal(status.status,503); // No WordPress secret configured.
console.log('OK: health, admin auth, no-order routes, missing-secret state');
