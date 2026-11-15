import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const src=(await readFile(new URL('../src/index.js',import.meta.url),'utf8'))
 .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}');
const {binancePublicLiqEndpoint,decodeBinanceLiquidations}=
 await import('data:text/javascript;base64,'+Buffer.from(src).toString('base64'));
const expected=['usd_market_raw','usd_market_combined','merged_coin_raw'];
for(let i=0;i<9;i++){
 const x=binancePublicLiqEndpoint(i);
 assert.equal(x.route,expected[i%3]);
 assert(x.url.startsWith('wss://')&&x.url.endsWith('!forceOrder@arr'));
 assert(!x.url.includes('/private/'));
}
const now=Date.now(),f={e:'forceOrder',E:now,st:1,o:{s:'BTCUSDT',S:'SELL',X:'FILLED',T:now,ap:'70000',z:'0.1'}};
assert.equal(decodeBinanceLiquidations(f,now).length,1,'UM liquidation allowed');
assert.equal(decodeBinanceLiquidations({...f,st:2},now).length,0,'CM merged-stream events blocked');
assert.equal(decodeBinanceLiquidations({...f,o:{...f.o,s:'DOGEUSDT'}},now).length,0);
console.log('PASS Binance public WS endpoint rotation, USD-M isolation and no private data');
