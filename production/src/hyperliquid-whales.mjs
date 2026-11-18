/** Public Hyperliquid leaderboard and cached, read-only trader observations.
 * No wallet signatures, customer accounts, trading, or impersonation. */
const ROOT='market-hub/hyperliquid-whales/v1/';
const LEADER='https://stats-data.hyperliquid.xyz/Mainnet/leaderboard';
const INFO='https://api.hyperliquid.xyz/info';
const addr=x=>typeof x==='string'&&/^0x[0-9a-f]{40}$/i.test(x);
const n=x=>x!==null&&x!==undefined&&x!==''&&typeof x!=='boolean'&&Number.isFinite(Number(x))?Number(x):null;
const cleanCoin=x=>typeof x==='string'&&/^[a-zA-Z0-9:@._/-]{1,36}$/.test(x)?x:null;
const LIMIT=80, USD_MIN=100000;
export function normalizeLeader(row){
 if(!addr(row?.ethAddress))return null;
 const equity=n(row.accountValue);if(equity===null||equity<USD_MIN)return null;
 const windows={};
 for(const pair of Array.isArray(row.windowPerformances)?row.windowPerformances:[]){
  if(!Array.isArray(pair)||!['day','week','month','allTime'].includes(pair[0]))continue;
  const p=pair[1],roi=n(p?.roi),pnl=n(p?.pnl),volume=n(p?.vlm);
  if(roi===null||pnl===null||volume===null||volume<0||Math.abs(roi)>1e7||Math.abs(pnl)>1e12)continue;
  windows[pair[0]]={roi_pct:roi*100,pnl_usd:pnl,volume_usd:volume};
 }
 if(!windows.month||!windows.week||!windows.allTime||windows.month.volume_usd<10000)return null;
 return {address:row.ethAddress.toLowerCase(),equity_usd:equity,windows};
}
function topAdd(a,row,key,limit){
 if(a.some(x=>x.address===row.address))return;
 if(a.length>=limit&&key(row)<=key(a.at(-1)))return;
 a.push(row);a.sort((x,y)=>key(y)-key(x)||x.address.localeCompare(y.address));
 if(a.length>limit)a.pop();
}
// Streaming scan of leaderboardRows: keep only candidate rows; never parse the
// entire ~40MB document into a Worker isolate. String/escape-aware JSON framing.
export async function readLeaderboard(response){
 if(!response.ok||!response.body)throw Error('leaderboard_http_'+response.status);
 const reader=response.body.getReader(),decoder=new TextDecoder();
 let bytes=0,prefix='',started=false,done=false,depth=0,quoted=false,escaped=false,row='',scanned=0,eligible=0;
 const roi=[],pnl=[],equity=[];
 try{
  while(!done){
   const part=await reader.read();if(part.done)break;
   bytes+=part.value.byteLength;if(bytes>70000000)throw Error('leaderboard_limit');
   let chunk=decoder.decode(part.value,{stream:true});
   if(!started){
    prefix+=chunk;const match=/"leaderboardRows"\s*:\s*\[/.exec(prefix);
    if(!match){if(prefix.length>65536)throw Error('leaderboard_schema');continue}
    chunk=prefix.slice(match.index+match[0].length);prefix='';started=true;
   }
   for(const ch of chunk){
    if(depth===0){
     if(ch===']'){done=true;break}
     if(ch!=='{'){if(!/[\s,]/.test(ch))throw Error('leaderboard_row');continue}
     depth=1;row='{';quoted=false;escaped=false;continue;
    }
    row+=ch;if(row.length>32768)throw Error('leaderboard_row_limit');
    if(quoted){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;continue}
    if(ch==='"'){quoted=true;continue}
    if(ch==='{')depth++;
    if(ch==='}'&&--depth===0){
     scanned++;if(scanned>100000)throw Error('leaderboard_count_limit');
     const x=normalizeLeader(JSON.parse(row));row='';
     if(x){eligible++;topAdd(roi,x,y=>y.windows.month.roi_pct,40);topAdd(pnl,x,y=>y.windows.month.pnl_usd,25);topAdd(equity,x,y=>y.equity_usd,25)}
    }
   }
  }
 }finally{await reader.cancel().catch(()=>{})}
 if(!started||!done||scanned<10||eligible<1)throw Error('leaderboard_incomplete');
 const candidates=[...new Map([...roi,...pnl,...equity].map(x=>[x.address,x])).values()].slice(0,LIMIT);
 return {candidates,scanned,eligible};
}
export function normalizePositions(data){
 if(!Array.isArray(data?.assetPositions))throw Error('positions_schema');
 const rows=[];
 for(const row of data.assetPositions){
  const p=row?.position,coin=cleanCoin(p?.coin),size=n(p?.szi),entry=n(p?.entryPx),value=n(p?.positionValue),unrealized=n(p?.unrealizedPnl);
  if(!coin||size===null||size===0)continue;
  if(entry===null||entry<=0||value===null||value<0||unrealized===null)throw Error('position_field');
  rows.push({coin,side:size>0?'long':'short',size:Math.abs(size),entry_price:entry,position_value_usd:value,unrealized_pnl_usd:unrealized,liquidation_price:n(p.liquidationPx),leverage:n(p.leverage?.value),roe_pct:n(p.returnOnEquity)===null?null:n(p.returnOnEquity)*100});
 }
 return rows.sort((a,b)=>b.position_value_usd-a.position_value_usd).slice(0,50);
}
export function normalizeFills(data,now=Date.now()){
 if(!Array.isArray(data))throw Error('fills_schema');
 const rows=[],seen=new Set();
 for(const f of data){
  const coin=cleanCoin(f?.coin),ts=n(f?.time),price=n(f?.px),size=n(f?.sz),id=String(f?.tid??'');
  if(!coin||!Number.isSafeInteger(ts)||ts>now+120000||ts<now-86400000*7||!(price>0)||!(size>0)||!id||seen.has(id))continue;
  seen.add(id);
  rows.push({id,coin,ts,price,size,direction:String(f.dir||'').slice(0,40),side:f.side==='B'?'buy':f.side==='A'?'sell':null,closed_pnl_usd:n(f.closedPnl),fee_usd:n(f.fee),value_usd:price*size});
 }
 return rows.sort((a,b)=>b.ts-a.ts).slice(0,80);
}
async function get(bucket,key){const x=await bucket.get(ROOT+key);return x?await x.json():null}
async function put(bucket,key,x){await bucket.put(ROOT+key,JSON.stringify(x),{httpMetadata:{contentType:'application/json'}})}
async function info(type,user,extra={}){
 const r=await fetch(INFO,{method:'POST',headers:{'content-type':'application/json','accept':'application/json'},body:JSON.stringify({type,user,...extra}),signal:AbortSignal.timeout(10000)});
 if(!r.ok)throw Error('info_http_'+r.status);
 const txt=await r.text();if(txt.length>2500000)throw Error('info_size');return JSON.parse(txt);
}
export async function collectHyperWhales(env,now=Date.now()){
 const bucket=env.MARKET_DATA;if(!bucket)return;
 let list=await get(bucket,'latest.json'),previous=list;
 let boardError=null;
 if(!list?.rows?.length||now-list.leaderboard_at_ms>=3600000){
  try{
   const response=await fetch(LEADER,{headers:{accept:'application/json'},signal:AbortSignal.timeout(40000)});
   const stats=await readLeaderboard(response);
   const old=new Map((list?.rows||[]).map(r=>[r.address,r]));
   // Retain original per-wallet observation timestamps; leaderboard updates do not
   // relabel cached positions as fresh.
   list={ok:true,schema:'lumex_hyperliquid_whales_v1',source:'Hyperliquid',leaderboard_at_ms:now,source_last_modified:response.headers.get('last-modified'),scanned:stats.scanned,eligible:stats.eligible,
     rows:stats.candidates.map(x=>({...x,profile:old.get(x.address)?.profile||null})),cursor:Number(previous?.cursor||0)%stats.candidates.length,orders_enabled:false,scope:'selected_leaderboard_accounts_default_perp_dex'};
   await put(bucket,'latest.json',list);
  }catch(e){boardError=String(e.message||e).slice(0,100);list=previous}
 }
 if(!list?.rows?.length){await put(bucket,'health.json',{ok:false,checked_ms:now,reason:boardError||'no_leaderboard'});return}
 // Three accounts per minute, bounded to six concurrent public info reads. No
 // upstream calls are ever driven by a page visitor. Fill/position failures
 // are isolated, and last successful values retain their original time.
 let count=0,errors=0;const errorKinds={};
 const indices=Array.from({length:Math.min(3,list.rows.length)},(_,i)=>(Number(list.cursor||0)+i)%list.rows.length);
 await Promise.all(indices.map(async i=>{
  const row=list.rows[i],old=await get(bucket,'profiles/'+row.address+'.json').catch(()=>null);
  const [positions,fills]=await Promise.allSettled([
   info('clearinghouseState',row.address).then(normalizePositions),
   info('userFills',row.address,{aggregateByTime:true}).then(x=>normalizeFills(x,now))
  ]);
  for(const [type,result] of [['positions',positions],['fills',fills]])if(result.status==='rejected'){const code=type+'_'+String(result.reason?.message||'unavailable').replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,70);errorKinds[code]=(errorKinds[code]||0)+1;}
  if(positions.status!=='fulfilled'&&fills.status!=='fulfilled'){errors++;return}
  const detail={ok:true,schema:'lumex_hyperliquid_profile_v1',address:row.address,
   positions:positions.status==='fulfilled'?positions.value:old?.positions??null,
   positions_at_ms:positions.status==='fulfilled'?now:old?.positions_at_ms??null,
   fills:fills.status==='fulfilled'?fills.value:old?.fills??null,
   fills_at_ms:fills.status==='fulfilled'?now:old?.fills_at_ms??null,
   orders_enabled:false,source:'Hyperliquid',scope:'default_perp_positions_recent_fill_sample'};
  await put(bucket,'profiles/'+row.address+'.json',detail);
  row.profile={positions_at_ms:detail.positions_at_ms,fills_at_ms:detail.fills_at_ms,
   positions:detail.positions===null?null:detail.positions.slice(0,8).map(p=>({coin:p.coin,side:p.side,entry_price:p.entry_price,position_value_usd:p.position_value_usd})),
   last_fill:detail.fills?.[0]||null};
  count++;if(positions.status!=='fulfilled'||fills.status!=='fulfilled')errors++;
 }));
 list.cursor=(Number(list.cursor||0)+indices.length)%list.rows.length;
 await put(bucket,'latest.json',list);
 await put(bucket,'health.json',{ok:true,checked_ms:now,leaderboard_at_ms:list.leaderboard_at_ms,rows:list.rows.length,profiles:list.rows.filter(r=>r.profile?.positions_at_ms).length,updated:count,errors,error_kinds:errorKinds,leaderboard_error:boardError});
}
export async function hyperWhalesRoute(request,env){
 const u=new URL(request.url),bucket=env.MARKET_DATA;
 const reply=(x,status=200)=>new Response(JSON.stringify(x),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'public,max-age=30','x-content-type-options':'nosniff'}});
 if(request.method!=='GET'||!bucket)return reply({ok:false},503);
 if(u.pathname.endsWith('/hyperliquid-whales-health'))return reply(await get(bucket,'health.json')||{ok:false,reason:'not_collected'});
 const list=await get(bucket,'latest.json');
 if(!list?.rows?.length)return reply({ok:false,reason:'not_collected'},503);
 if(u.pathname.endsWith('/hyperliquid-whales')){
  const {cursor,...publicList}=list;return reply(publicList);
 }
 const address=u.searchParams.get('address')?.toLowerCase();
 if(!addr(address)||!list.rows.some(r=>r.address===address))return reply({ok:false},404);
 const detail=await get(bucket,'profiles/'+address+'.json');
 return detail?reply(detail):reply({ok:false,reason:'profile_pending'},503);
}