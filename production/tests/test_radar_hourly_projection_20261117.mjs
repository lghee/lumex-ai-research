import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const raw=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
 .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {}');
const {verifiedHourlyFromQuarter}=await import('data:text/javascript;base64,'+Buffer.from(raw).toString('base64'));
const now=Date.now(),hour=Math.floor(now/3600000)*3600000;
const bars=Array.from({length:62*4},(_,i)=>{
 const t=hour-62*3600000+i*900000,p=100+i*.1;
 return {t,o:p,h:p+1,l:p-1,c:p+.2,v:2};
});
const hours=verifiedHourlyFromQuarter(bars,now);
assert.equal(hours.length,62,'no missing 1-hour bars in 62 completed hours');
assert.equal(hours[0].t,hour-62*3600000);
assert.equal(hours.at(-1).t,hour-3600000);
assert.equal(hours.at(-1).v,8,'the entire four quarter volumes sum in native units');
assert.equal(hours.at(-1).o,bars.at(-4).o);
assert.equal(hours.at(-1).c,bars.at(-1).c);
const missing=bars.filter(b=>b.t!==hour-8*3600000+900000);
const valid=verifiedHourlyFromQuarter(missing,now);
assert.equal(valid.length,7,'a hole 8h back breaks contiguous history; cannot bridge silently');
const malformed=[...bars];malformed[malformed.length-3]={...malformed.at(-3),h:0};
const broken=verifiedHourlyFromQuarter(malformed,now);
assert.equal(broken.at(-1).t,hour-2*3600000,'invalid last hour cannot pass');
const future=[...bars,{t:hour,o:50,h:51,l:49,c:50,v:1}];
assert.equal(verifiedHourlyFromQuarter(future,now).length,62,'never include unfinished current hour');
assert(verifiedHourlyFromQuarter(bars.slice(-12)).length<51,'insufficient source bars cannot pretend to provide technical history');
assert(raw.includes("derivation:'four_consecutive_verified_15m_closed_bars'"));
assert(raw.includes("if(frame===60&&(v.stale===true||r[name].status!=='ok'))"));
console.log('PASS strictly verified 1h radar fallback: hourly OHLCV, close times, contiguous gaps, source provenance');
