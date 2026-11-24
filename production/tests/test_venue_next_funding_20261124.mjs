// Next funding settlement per venue: seconds/ms, (now, now+9h] window, OKX rate from its own funding source, no time without a rate.
import assert from 'node:assert/strict';
import {parseVenueBulk,nextMs,fundingExtras,matrix} from '../src/pro-venue-matrix.mjs';
const now=Date.UTC(2026,10,24,5,10),H=3600000,next8=Date.UTC(2026,10,24,8,0),allow=new Set(['BTCUSDT','ETHUSDT']);
assert.equal(nextMs(String(next8),now),next8);assert.equal(nextMs(next8/1000,now),next8,'seconds accepted');
assert.equal(nextMs(now-1,now),null,'past');assert.equal(nextMs(now+10*H,now),null,'too far');assert.equal(nextMs('x',now),null);
const by=parseVenueBulk('Bybit',{retCode:0,result:{list:[{symbol:'BTCUSDT',markPrice:'98000',openInterestValue:'5e9',fundingRate:'0.0001',nextFundingTime:String(next8)}]}},allow,now);
assert.equal(by.get('BTCUSDT').next_funding_ms,next8);
const bn=parseVenueBulk('Binance',[{symbol:'BTCUSDT',markPrice:'98010',lastFundingRate:'0.0001',nextFundingTime:next8}],allow,now);
assert.equal(bn.get('BTCUSDT').next_funding_ms,next8);
const okxFund={code:'0',data:[{instId:'BTC-USDT-SWAP',fundingRate:'-0.00005',fundingTime:String(next8),nextFundingTime:String(next8+8*H)}]};
const ok=parseVenueBulk('OKX',{code:'0',data:[{instId:'BTC-USDT-SWAP',oiUsd:'3e9'}]},allow,now,{code:'0',data:[{instId:'BTC-USDT-SWAP',markPx:'98005'}]},okxFund);
assert.equal(ok.get('BTCUSDT').funding_pct,-0.005,'OKX funding from its own funding source');assert.equal(ok.get('BTCUSDT').next_funding_ms,next8,'fundingTime = next settlement');
const okNoFund=parseVenueBulk('OKX',{code:'0',data:[{instId:'BTC-USDT-SWAP',oiUsd:'3e9'}]},allow,now,null,null);
assert.equal(okNoFund.get('BTCUSDT').funding_pct,null);assert.equal(okNoFund.get('BTCUSDT').next_funding_ms,null);
const gt=parseVenueBulk('Gate',[{contract:'BTC_USDT',mark_price:'98001',open_interest_usd:'1e9',funding_rate:'0.0002'}],allow,now,null,[{name:'BTC_USDT',funding_next_apply:next8/1000},{name:'XYZ_USDT',funding_next_apply:next8/1000}]);
assert.equal(gt.get('BTCUSDT').next_funding_ms,next8,'Gate contracts seconds');
const bg=parseVenueBulk('Bitget',{code:'00000',data:[{symbol:'BTCUSDT',markPrice:'98002',fundingRate:'0.0001'}]},allow,now,null,{code:'00000',data:[{symbol:'BTCUSDT',fundingRate:'0.0001',nextUpdate:String(next8)}]});
assert.equal(bg.get('BTCUSDT').next_funding_ms,next8,'Bitget nextUpdate');
// a time without a rate is dropped
const gt2=parseVenueBulk('Gate',[{contract:'BTC_USDT',mark_price:'98001'}],allow,now,null,[{name:'BTC_USDT',funding_next_apply:next8/1000}]);
assert.equal(gt2.get('BTCUSDT').next_funding_ms,null);
// extras ignore malformed payloads
assert.equal(fundingExtras('OKX',{code:'1'},allow,now).size,0);assert.equal(fundingExtras('Gate',{},allow,now).size,0);
// matrix carries the field, unavailable rows null
const top50={schema:'lumex_uid_top50_v1',items:[{symbol:'BTCUSDT'},{symbol:'ETHUSDT'}],generated_at_ms:now-60000};
const m=matrix(top50,{Bybit:{retCode:0,result:{list:[{symbol:'BTCUSDT',markPrice:'98000',fundingRate:'0.0001',nextFundingTime:String(next8)}]}}},now);
assert.equal(m.markets.BTCUSDT[1].next_funding_ms,next8);assert.equal(m.markets.ETHUSDT[1].next_funding_ms,null);assert.equal(m.markets.BTCUSDT[0].next_funding_ms,null);
console.log('PASS venue next funding: 5 venues, seconds/ms, 9h window, OKX own rate, no time without rate');
