import assert from 'node:assert/strict';
import fs from 'node:fs';
import {decodeBinanceLiquidations} from '../src/index.js';

// Production-only public-data toggle. Does not enable private orders or customer keys.
const conf=JSON.parse(fs.readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
assert.equal(conf.vars.AUTO_LIVE_STREAM,'true');
assert.equal(conf.vars.AUTO_BINANCE_LIQUIDATIONS,'true');
assert.equal(conf.vars.AUTO_BINANCE_TAKER_FETCH,'false');
const now=Date.now();
const um={e:'forceOrder',E:now,st:1,o:{s:'BTCUSDT',S:'SELL',X:'FILLED',T:now,ap:'65000.1',z:'0.25'}};
const accepted=decodeBinanceLiquidations(um,now);
assert.equal(accepted.length,1);
assert.equal(accepted[0].source,'binance');
assert.equal(accepted[0].capture,'sampled_1s');
assert.equal(accepted[0].position_side,'long');
assert.equal(accepted[0].price_type,'avg_execution_price');
assert.equal(decodeBinanceLiquidations({...um,st:2},now).length,0,'COIN-M must not enter UM ledger');
assert.equal(decodeBinanceLiquidations({...um,o:{...um.o,s:'DOGEUSDT'}},now).length,0,'only supported 4 symbols');
console.log('PASS public Binance liquidation offload toggle + source isolation');
