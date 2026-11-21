/**
 * Gate public market execution validator. Venue-isolated: these are NOT Binance archive trades.
 * The venue broadcasts market executions, not original order sizes or wallet identity.
 */
export const FLOW_SYMBOLS=['BTC','ETH','SOL','XRP'];
export const FLOW_MARKETS=['spot','um-futures'];
const symbols=new Set(FLOW_SYMBOLS.map(s=>s+'_USDT'));
const qty=x=>{const n=Number(x);return x!==null&&x!==undefined&&x!==''&&Number.isFinite(n)&&n>0&&n<1e15?n:null;};
export function decimalId(x){
 if(typeof x==='number'&&!Number.isSafeInteger(x))return null;
 const s=String(x??'');
 return /^\d{1,30}$/.test(s)?s.replace(/^0+(?=\d)/,''):null;
}
export function orderIdAfter(next,previous){
 if(!previous)return true;
 return next.length>previous.length||(next.length===previous.length&&next>previous);
}
export function parseGateExecution(market,row,multipliers={},now=Date.now()){
 if(!FLOW_MARKETS.includes(market)||!row||typeof row!=='object'||row.is_internal===true)return null;
 const pair=String(market==='spot'?row.currency_pair:row.contract||'');
 if(!symbols.has(pair))return null;
 const symbol=pair.replace('_USDT','');
 const id=decimalId(market==='spot'?(row.id_market??row.id):row.id);
 if(!id)return null;
 // Spot and WebSocket generally send ms. Some Gate futures REST responses
 // report seconds with three decimal places (or only create_time).
 const originalTime=row.create_time_ms??row.create_time;
 const raw=Number(originalTime);
 if(!Number.isFinite(raw))return null;
 const tsRaw=raw>=1e9&&raw<1e11?raw*1000:raw;
 if(!Number.isFinite(tsRaw)||tsRaw<1e12||tsRaw>now+120000||tsRaw<now-172800000)return null;
 const ts=raw>=1e9&&raw<1e11?Math.round(tsRaw):Math.floor(tsRaw);
 const price=qty(row.price);
 if(!price)return null;
 let taker,base;
 if(market==='spot'){
  if((row.money&&row.money!=='USDT')||(row.trade_quote&&row.trade_quote!=='USDT'))return null; // unified non-USDT quotes must not be mixed.
  taker=row.side;
  base=qty(row.amount);
  if(taker!=='buy'&&taker!=='sell')return null;
 }else{
  const signed=Number(row.size);
  const multiplier=qty(multipliers[pair]);
  if(!Number.isFinite(signed)||signed===0||!multiplier)return null;
  taker=signed>0?'buy':'sell';
  base=Math.abs(signed)*multiplier;
 }
 if(!base||!Number.isFinite(base*price)||base*price<=0||base*price>1e20)return null;
 return {source:'gateio',market,symbol,id,ts,price,base_qty:base,quote_usdt:base*price,taker};
}
export function parseGatePacket(market,packet,multipliers={},now=Date.now()){
 const channel=market==='spot'?'spot.trades':'futures.trades';
 if(packet?.channel!==channel||packet?.event!=='update')return [];
 const rows=Array.isArray(packet.result)?packet.result:[packet.result];
 if(rows.length>10000)return [];
 // Gate may batch executions in reverse order. Sort by exact decimal IDs
 // before the collector compares high-water marks, never by imprecise JS Number.
 return rows.map(x=>parseGateExecution(market,x,multipliers,now)).filter(Boolean)
  .sort((a,b)=>a.id.length-b.id.length||(a.id<b.id?-1:a.id>b.id?1:0));
}
