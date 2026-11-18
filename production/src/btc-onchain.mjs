// BTC public chain observations, collected on existing 5-minute schedule.
const ROOT='market-hub/onchain/btc/v1/';
const BASE='https://blockstream.info/api';
const int=(x,min,max)=>Number.isSafeInteger(x)&&x>=min&&x<=max;
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
export function subsidySat(height){return Math.floor(5000000000/2**Math.floor(height/210000));}
export function issuedSat(height){
 if(!int(height,0,10000000))throw Error('height');
 let total=0;
 for(let start=0;start<=height;start+=210000)total+=Math.min(210000,height-start+1)*subsidySat(start);
 return total;
}
export function normalizeBlocks(rows,now=Date.now()){
 if(!Array.isArray(rows)||rows.length<6||rows.length>10)throw Error('blocks_count');
 const blocks=rows.map(b=>{
  if(!hash(b?.id)||!hash(b?.previousblockhash)||!int(b.height,1,10000000)||
     !int(b.timestamp,1231006505,Math.floor(now/1000)+7200)||
     !int(b.tx_count,1,100000)||!int(b.weight,1,4000000)||
     typeof b.difficulty!=='number'||!Number.isFinite(b.difficulty)||b.difficulty<=0)
    throw Error('block_schema');
  return {hash:b.id,previous:b.previousblockhash,height:b.height,ts:b.timestamp,transactions:b.tx_count,weight:b.weight,difficulty:b.difficulty};
 });
 for(let i=1;i<blocks.length;i++)if(blocks[i-1].height!==blocks[i].height+1||blocks[i-1].previous!==blocks[i].hash)throw Error('block_continuity');
 if(now/1000-blocks[0].ts>21600)throw Error('tip_stale');
 return blocks;
}
export function normalizeMempool(x){
 if(!int(x?.count,0,100000000)||!int(x?.vsize,0,100000000000)||!int(x?.total_fee,0,2100000000000000))throw Error('mempool_schema');
 return {count:x.count,vsize:x.vsize,total_fee_btc:x.total_fee/1e8};
}
async function read(bucket,k){try{return await (await bucket.get(ROOT+k))?.json()||null}catch{return null}}
async function write(bucket,k,x){await bucket.put(ROOT+k,JSON.stringify(x),{httpMetadata:{contentType:'application/json'}});}
async function upstream(path){
 const r=await fetch(BASE+path,{headers:{accept:'application/json'},signal:AbortSignal.timeout(8000)});
 if(!r.ok)throw Error('esplora_http_'+r.status);
 const raw=await r.text();if(raw.length>500000)throw Error('size');
 return JSON.parse(raw);
}
export async function collectBtcOnchain(env,now=Date.now()){
 const bucket=env.MARKET_DATA;if(!bucket)return;
 const old=await read(bucket,'latest.json');
 const [blocks,mem]=await Promise.allSettled([upstream('/blocks').then(x=>normalizeBlocks(x,now)),upstream('/mempool').then(normalizeMempool)]);
 const network=blocks.status==='fulfilled'?{observed_ms:now,blocks:blocks.value,
   tip_height:blocks.value[0].height,issued_max_btc:issuedSat(blocks.value[0].height)/1e8,
   block_reward_btc:subsidySat(blocks.value[0].height)/1e8,
   next_halving_height:(Math.floor(blocks.value[0].height/210000)+1)*210000}:old?.network||null;
 const mempool=mem.status==='fulfilled'?{...mem.value,observed_ms:now}:old?.mempool||null;
 // Samples are measured, not synthetic daily aggregates; no gaps filled with zero.
 let history=Array.isArray(old?.history)?old.history.filter(x=>x.ts>=now-366*86400000):[];
 if(blocks.status==='fulfilled'&&mem.status==='fulfilled'){
  const date=new Date(now).toISOString().slice(0,10);
  const sample={date,ts:now,height:network.tip_height,mempool_count:mempool.count,
   difficulty:network.blocks[0].difficulty,issued_max_btc:network.issued_max_btc};
  history=history.filter(x=>x.date!==date);history.push(sample);history=history.slice(-366);
 }
 const data={ok:!!network||!!mempool,schema:'lumex_btc_onchain_v1',source:'Blockstream Esplora / Bitcoin public chain',checked_ms:now,
   network,mempool,history,errors:[blocks.status==='rejected'?'blocks':null,mem.status==='rejected'?'mempool':null].filter(Boolean),orders_enabled:false};
 if(data.ok)await write(bucket,'latest.json',data);
}
export async function btcOnchainRoute(request,env){
 if(request.method!=='GET')return new Response(null,{status:405,headers:{allow:'GET'}});
 const data=env.MARKET_DATA?await read(env.MARKET_DATA,'latest.json'):null;
 return new Response(JSON.stringify(data||{ok:false,error:'not_collected'}),{status:data?200:503,
  headers:{'content-type':'application/json; charset=utf-8','cache-control':'public, max-age=60','x-content-type-options':'nosniff'}});
}
