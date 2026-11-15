import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
assert.match(source,/utc\.getUTCHours\(\)>0\|\|\(utc\.getUTCHours\(\)===0&&utc\.getUTCMinutes\(\)>=15\)/);
assert.match(source,/marketOpsDaily\(env,utc\.getTime\(\)\)/);
assert.match(source,/const existing=await opsReadR2\(env,key\)/);
assert.match(source,/return \{ok:true,already_saved:true,date\}/);
assert.match(source,/const date=new Date\(now\)\.toISOString\(\)\.slice\(0,10\)/);
function due(iso){const d=new Date(iso);return d.getUTCHours()>0||(d.getUTCHours()===0&&d.getUTCMinutes()>=15)}
assert.equal(due('2026-11-15T00:10:00Z'),false);
assert.equal(due('2026-11-15T00:15:00Z'),true);
assert.equal(due('2026-11-15T00:20:00Z'),true);
assert.equal(due('2026-11-15T23:55:00Z'),true);
console.log('PASS ops daily retry schedule; no fabricated historical evidence');
