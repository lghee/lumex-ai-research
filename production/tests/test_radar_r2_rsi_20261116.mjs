import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
  .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {}');
const {hubRsi14}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const bars=Array.from({length:60},(_,i)=>({c:100+i*2}));
assert.equal(hubRsi14(bars),100,'14 consecutive gains');
const flat=Array.from({length:60},()=>({c:100}));
assert.equal(hubRsi14(flat),50,'14 unchanged bars are neutral, not zero');
const falling=Array.from({length:60},(_,i)=>({c:200-i}));
assert.equal(hubRsi14(falling),0,'14 consecutive losses');
assert.equal(hubRsi14(bars.slice(-14)),null,'no invented RSI on short data');
assert.equal(hubRsi14([...bars.slice(-14),{c:NaN}]),null,'invalid close fails closed');
assert(source.includes('r[name].last_candle_open_ms=v.last_candle_open_ms'),'per-co​in observed candle clock');
assert(source.includes('if(frame===15)r[name].rsi=hubRsi14(v.candles)'),'radar must use verified 15m R2 candles');
console.log('PASS verified R2 15-minute radar RSI14, partial coverage and measured timestamp');
