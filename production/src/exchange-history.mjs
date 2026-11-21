/** Read-only hourly sample of existing immutable, source-isolated public R2 history.
 * No new collector, Cron, private API, or trading path.
 */
import {EX_COINS,EX_NAMES,EX_PREFIX} from './exchange-compare.mjs';
const HOUR=3600000,SCHEMA='lumex_exchange_compare_v1';
const respond=(x,status=200)=>new Response(JSON.stringify(x),{status,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}});
const num=(x,min,max)=>{if(x===null||x===undefined||x===''||typeof x==='boolean')return null;const n=Number(x);return Number.isFinite(n)&&n>=min&&n<=max?n:null};
const stamp=(x,now)=>{const n=num(x,1.5e12,now+120000);return n===null?null:Math.round(n)};
const daysBetween=(from,to)=>{const dates=[];for(let d=Math.floor(from/86400000)*86400000;d<=to;d+=86400000)dates.push(new Date(d).toISOString().slice(0,10).replaceAll('-','/'));return dates};
export function sanitizeHistoricalSnapshot(raw,symbol,keyTime,now=Date.now()){
  if(raw?.schema!==SCHEMA||raw?.symbol!==symbol||raw?.order_execution!==false||
     raw?.aggregation!=='none'||raw?.missing_as_zero!==false||!Array.isArray(raw.exchanges)||raw.exchanges.length!==5||
     raw.generated_at_ms!==keyTime||!Number.isSafeInteger(keyTime)||keyTime>now+120000||keyTime<now-26*HOUR)return null;
  const output=[];
  for(let i=0;i<5;i++){
    const r=raw.exchanges[i];if(!r||r.exchange!==EX_NAMES[i])return null;
    const v={exchange:r.exchange,account:null,open_interest:null,funding:null};
    const a=r.account;
    if(a?.denominator==='exchange_long_short_accounts'){
      const l=num(a.long_pct,0,100),s=num(a.short_pct,0,100),ts=stamp(a.asof_ms,now);
      if(l!==null&&s!==null&&Math.abs(l+s-100)<4.1&&ts!==null&&Math.abs(keyTime-ts)<=26*60000)
        v.account={long_pct:l,short_pct:s,asof_ms:ts,source:String(a.source||'').slice(0,75),
          method:String(a.method||'').slice(0,80),denominator:'exchange_long_short_accounts'};
    }
    const oi=r.open_interest;
    if(oi&&['USD','USDT'].includes(oi.unit)){
      const value=num(oi.value,0.00001,1e16),ts=stamp(oi.asof_ms,now);
      if(value!==null&&ts!==null&&Math.abs(keyTime-ts)<=26*60000)
        v.open_interest={value,unit:oi.unit,asof_ms:ts,source:String(oi.source||'').slice(0,75)};
    }
    const f=r.funding;
    if(f){
      const value=num(f.rate_pct,-20,20),ts=stamp(f.asof_ms,now),interval=num(f.interval_hours,1,24);
      if(value!==null&&ts!==null&&Math.abs(keyTime-ts)<=26*60000&&interval!==null)
        v.funding={rate_pct:value,interval_hours:interval,asof_ms:ts,source:String(f.source||'').slice(0,75)};
    }
    output.push(v);
  }
  return {at_ms:keyTime,exchanges:output};
}
export async function archiveHourlyHistory(env,symbol,now=Date.now()){
  if(!EX_COINS.includes(symbol.slice(0,-4))||!symbol.endsWith('USDT')||!env?.MARKET_DATA)throw Error('invalid_request');
  const first=now-24*HOUR,coin=symbol.slice(0,-4),chosen=new Map();
  for(const day of daysBetween(first,now)){
    const prefix=EX_PREFIX+'history/'+day+'/';
    const result=await env.MARKET_DATA.list({prefix,limit:1000});
    if(result?.truncated===true)throw Error('incomplete_archive_listing');
    if(!Array.isArray(result?.objects))throw Error('archive_listing_missing');
    for(const item of result.objects){
      const key=String(item.key||'');
      if(!key.startsWith(prefix+coin+'-')||!key.endsWith('.json')||Number(item.size)>180000)continue;
      const match=new RegExp('^'+coin+'-([0-9]{13})\\.json$').exec(key.slice(prefix.length));
      if(!match)continue;
      const t=Number(match[1]);if(!Number.isSafeInteger(t)||t<first||t>now+120000)continue;
      const hour=Math.floor(t/HOUR)*HOUR,prior=chosen.get(hour);
      if(!prior||t>prior.at_ms)chosen.set(hour,{key,at_ms:t});
    }
  }
  const selected=[...chosen.values()].sort((a,b)=>a.at_ms-b.at_ms).slice(-25);
  const output=[];
  for(let i=0;i<selected.length;i+=5){
    const batch=await Promise.all(selected.slice(i,i+5).map(async item=>{
      try{const obj=await env.MARKET_DATA.get(item.key);
        if(!obj||obj.size>180000)return null;
        return sanitizeHistoricalSnapshot(await obj.json(),symbol,item.at_ms,now);
      }catch{return null}
    }));
    for(const item of batch)if(item)output.push(item);
  }
  return output;
}
export async function serveExchangeHistory(request,env,now=Date.now()){
  const u=new URL(request.url),symbol=String(u.searchParams.get('symbol')||'').toUpperCase();
  const hours=u.searchParams.get('hours')||'24';
  if(!EX_COINS.some(c=>symbol===c+'USDT')||hours!=='24')return respond({ok:false,error:'unsupported_request'},400);
  try{
    const snapshots=await archiveHourlyHistory(env,symbol,now);
    const count=snapshots.filter(s=>s.exchanges.some(x=>x.funding||x.open_interest||x.account)).length;
    return respond({ok:true,schema:'lumex_exchange_history_v1',symbol,window_hours:24,
      source_scope:'source_isolated_observed_public_exchange_history',
      cadence:'at_most_one_real_record_per_hour',observed_only:true,market_total_estimate:false,
      order_execution:false,snapshots,verified_hourly_records:count,history_started:snapshots.length>0,
      missing_is_zero:false,generated_at_ms:now});
  }catch{return respond({ok:false,error:'verified_exchange_history_unavailable'},503)}
}
