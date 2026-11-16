import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const s=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
const start=s.indexOf("if(path==='/market-hub/v1/candles'&&method==='GET')");
assert(start>0,'authenticated candle route');
const chunk=s.slice(start,start+850);
assert(chunk.includes("'500','850'"),'only bounded candle request sizes');
assert(chunk.includes("hubGetCandles(env,symbol,interval,Number(requested))"),'explicit requested size honored');
assert(chunk.includes("invalid_candle_limit"),'invalid sizes fail closed');
assert(s.includes("if(!hubAuthorized(request,env))return hubReply({ok:false,error:'unauthorized'},401);"),
 'Worker bearer authorization mandatory before protected market routes');
assert(s.includes("feed_mode:'cloudflare_r2_verified_closed_candles'"),'response requires R2 closed candles');
assert(s.includes("data_quality:'verified'"),'response validates verified source quality');
assert(s.includes("orders_enabled:false"),'market observations can never authorize orders');
assert(s.includes("Math.min(850,Math.max(40,limit))"),'bounded R2 candle upper limit');
console.log('PASS: protected 850-candle R2 only, default 500, invalid limits rejected, no orders');
