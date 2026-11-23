// LUMEX signature math in the Worker = the chart's math (fixture produced by theme assets/lumex-signature-0700.js on real BTC 1H bars).
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {purity,coil,pressure,profile,signatureTag} from '../src/signature-math.mjs';
import {classify} from '../src/pro50-scanner.mjs';
const fx=JSON.parse(readFileSync(new URL('./fixtures_signature_btc_1h.json',import.meta.url)));
const bars=fx.rows.map(b=>({time:Math.round(b.t/1000),open:b.o,high:b.h,low:b.l,close:b.c,volume:b.v}));
assert.deepEqual(purity(bars,20).slice(-30),fx.expected.purity,'purity parity');
assert.deepEqual(coil(bars).events,fx.expected.coil,'coil parity');
assert.deepEqual(pressure(bars).events,fx.expected.pressure,'pressure parity');
const p=profile(bars,{lookback:200});assert.deepEqual({poc:p.poc,vah:p.vah,val:p.val,position:p.position},fx.expected.profile,'profile parity');
// tag: bounded windows, no look-ahead (adding a future bar never changes an earlier tag)
const H=3600000,tag=signatureTag(fx.rows,H);
assert.ok(tag&&tag.bars===200&&Math.abs(tag.purity)<=1&&['above','below','inside'].includes(tag.profile.position));
assert.ok(!tag.coil.breakout||tag.coil.breakout.bars_ago<=12);assert.ok(!tag.divergence||tag.divergence.bars_ago<=24);
const cut=signatureTag(fx.rows.slice(0,180),H),cut2=signatureTag(fx.rows.slice(0,180).concat(fx.rows.slice(180,181)).slice(0,180),H);
assert.deepEqual(cut,cut2,'same bars → same tag');
assert.equal(signatureTag(fx.rows.slice(0,100),H),null,'too few bars → null, not a guess');
// a synthetic squeeze then breakout is detected
const sq=[];let px=100;for(let i=0;i<190;i++){const amp=i<150?1.5:(i<180?0.05:0.2);px+=i>=182?0.6:(Math.sin(i)*amp*0.3);sq.push({t:i*H,o:px,h:px+amp,l:px-amp,c:px,v:10});}
const st=signatureTag(sq,H);assert.ok(st.coil.live||st.coil.breakout,'squeeze recognised');
console.log('PASS signature scanner: chart-math parity on real BTC 1H (purity/coil/pressure/profile), bounded tags, no look-ahead, squeeze');
// coil parity on a real 4H window that contains a confirmed breakout
const fc=JSON.parse(readFileSync(new URL('./fixtures_signature_coil_4h.json',import.meta.url)));
const cb=fc.rows.map(b=>({time:Math.round(b.t/1000),open:b.o,high:b.h,low:b.l,close:b.c,volume:b.v}));
const cc=coil(cb);assert.deepEqual(cc.events,fc.expected.coil,'coil parity (with breakout)');assert.deepEqual(cc.live,fc.expected.live);
assert.ok(cc.events.some(e=>e.type==='coil-break'));
console.log('PASS signature scanner: coil breakout parity on real '+fc.coin+' 4H');
