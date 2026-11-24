/** Signal ledger for copy-trading (AI 자동매매 실거래 연동).
 *
 * The paper league is the single source of truth: what a strategy's league account holds is the
 * target every connected customer account follows. This module publishes, per strategy,
 * a monotonically increasing sequence number that changes ONLY when the league account's
 * holdings change (a fill), together with the target legs frozen at that moment:
 *   {symbol, side, weight (notional ÷ account equity), entry (league fill), opened_ms, stop, take, take_frac?}
 * No customer data, keys or orders here. Core reads the ledger with the hub token, checks the
 * HMAC signature (same shared token) and freshness, and executes per customer.
 */
export const SIGNALS='paper-league/v1/signals.json';
export const SIGNAL_SCHEMA='lumex_paper_league_signals_v1';
const rd=(x,d=6)=>Number(Number(x).toFixed(d));
const fin=x=>typeof x==='number'&&Number.isFinite(x);

/** Identity of the holdings: changes only when the league account opens/closes/resizes. */
export function holdingsKey(acc){
  return Object.values(acc?.positions||{}).map(p=>`${p.symbol}:${p.side}:${rd(p.qty,10)}:${p.opened_ms||0}`).sort().join('|');
}
export function legsOf(acc){
  const eq=Number(acc?.equity);if(!fin(eq)||eq<=0)return [];
  return Object.values(acc.positions||{}).map(p=>{const mark=fin(p.last_mark)?p.last_mark:p.entry;
    const leg={symbol:p.symbol,side:p.side,weight:rd(Math.abs(p.qty*mark)/eq,4),entry:rd(p.entry,10),opened_ms:p.opened_ms||null};
    if(fin(p.stop)&&p.stop>0)leg.stop=rd(p.stop,10);if(fin(p.take)&&p.take>0)leg.take=rd(p.take,10);
    // 2026-11-24: a partial target (SIGNAL 50 %) — followers must not place a full-size take; they follow the league's reduction
    if(fin(p.take_frac)&&p.take_frac>0&&p.take_frac<1&&leg.take)leg.take_frac=rd(p.take_frac,4);
    return leg;}).filter(l=>l.weight>0).sort((a,b)=>a.symbol.localeCompare(b.symbol));
}
/** Update st.signals in place; returns the public ledger document (unsigned). */
export function signalTick(st,strategies,now){
  st.signals=st.signals&&typeof st.signals==='object'?st.signals:{};
  const out=[];
  for(const def of strategies){
    const acc=st.accounts?.[def.id];if(!acc)continue;
    const key=holdingsKey(acc);let s=st.signals[def.id];
    if(!s){s=st.signals[def.id]={seq:1,key,changed_ms:now,legs:legsOf(acc)};}
    else if(s.key!==key){s.seq+=1;s.key=key;s.changed_ms=now;s.legs=legsOf(acc);}
    else{ // same holdings: protective levels can move (trailing stops) without a new sequence
      const cur=legsOf(acc);for(const l of s.legs){const c=cur.find(x=>x.symbol===l.symbol&&x.side===l.side);if(c){if(fin(c.stop))l.stop=c.stop;if(fin(c.take))l.take=c.take;}}
    }
    out.push({id:def.id,seq:s.seq,changed_ms:s.changed_ms,legs:s.legs,
      gross:rd(s.legs.reduce((a,l)=>a+l.weight,0),4),
      risk_state:acc.memo?.risk_state||'normal',status:acc.status==='error'||acc.status==='data_unavailable'?acc.status:'ok'});
  }
  return {ok:true,schema:SIGNAL_SCHEMA,order_execution:false,generated_at_ms:now,strategies:out};
}
async function hmacHex(key,text){
  const k=await crypto.subtle.importKey('raw',new TextEncoder().encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const sig=await crypto.subtle.sign('HMAC',k,new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
/** Response body: {"payload": "<json>", "sig": hex HMAC-SHA256(payload, worker token)}. */
export async function signedLedger(doc,key){
  const payload=JSON.stringify(doc);
  return {payload,sig:typeof key==='string'&&key.length>=32?await hmacHex(key,payload):null,alg:'HMAC-SHA256'};
}
const reply=(doc,status=200)=>new Response(JSON.stringify(doc),{status,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}});
export async function serveSignals(env,now=Date.now()){
  try{const o=await env.MARKET_DATA.get(SIGNALS);const doc=o?await o.json():null;
    if(doc?.schema!==SIGNAL_SCHEMA||now-doc.generated_at_ms>30*60000)return reply({ok:false,error:'signals_unavailable_or_stale'},503);
    const signed=await signedLedger(doc,env.LUMEX_AI_LAB_WORKER_TOKEN);
    if(!signed.sig)return reply({ok:false,error:'signing_key_missing'},503);
    return reply({ok:true,...signed});}
  catch{return reply({ok:false,error:'signals_read_failed'},503);}
}
