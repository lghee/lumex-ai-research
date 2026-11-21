/** Gate and OKX USDT perpetual fallback. Never assume contract size = base quantity.
 * Gate size × verified quanto_multiplier, OKX size × verified ctVal × ctMult.
 * This layer reads PUBLIC endpoints only, never orders or private account APIs.
 */
const validNum=(x,min=1e-12,max=1e12)=>{if(x===null||x===undefined||x===''||typeof x==='boolean')return null;const n=Number(x);return Number.isFinite(n)&&n>=min&&n<=max?n:null};
const within=(ms,now)=>Number.isSafeInteger(ms)&&ms>=1500000000000&&ms<=now+2000&&now-ms<=15000;
async function safeJson(url,fetchImpl){
 try{
  const resp=await fetchImpl(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(5000)});
  if(!resp.ok||Number(resp.headers.get('content-length')||0)>160000)return null;
  const body=await resp.text();if(body.length<20||body.length>160000)return null;
  return JSON.parse(body);
 }catch{return null}
}
function rows(source,desc,multiplier){
 if(!Array.isArray(source)||source.length<2||source.length>100)return null;
 const output=[];let prev=desc?Infinity:0;
 for(const item of source){
  const p=validNum(Array.isArray(item)?item[0]:item?.p);
  const rawQ=validNum(Array.isArray(item)?item[1]:item?.s);
  if(p===null||rawQ===null)return null;
  const q=rawQ*multiplier;if(!Number.isFinite(q)||q<=0||q>1e12||(desc?p>=prev:p<=prev))return null;
  output.push([p,q]);prev=p;
 }
 return output;
}
export function normalizeAlternative(venue,book,metadata,symbol,now=Date.now()){
 const coin=symbol.endsWith('USDT')?symbol.slice(0,-4):'';
 if(!/^[A-Z0-9]{2,20}$/.test(coin))return null;
 let bids,asks,ts,units;
 if(venue==='Gate'){
  if(metadata?.name!==coin+'_USDT'||metadata?.type!=='direct')return null;
  units=validNum(metadata.quanto_multiplier,1e-12,1e8);
  ts=Number.isFinite(Number(book?.current))?Math.round(Number(book.current)*1000):0;
  bids=book?.bids;asks=book?.asks;
 }else if(venue==='OKX'){
  const target=coin+'-USDT-SWAP',meta=Array.isArray(metadata?.data)?metadata.data[0]:null;
  const row=Array.isArray(book?.data)?book.data[0]:null;
  if(metadata?.code!=='0'||book?.code!=='0'||meta?.instId!==target||meta?.instType!=='SWAP'||
     meta?.ctType!=='linear'||meta?.ctValCcy!==coin||meta?.settleCcy!=='USDT'||meta?.state!=='live')return null;
  const ct=validNum(meta.ctVal,1e-12,1e12);
  const multiplier=meta.ctMult==null||meta.ctMult===''?1:validNum(meta.ctMult,1e-12,1e8);
  units=ct===null||multiplier===null?null:ct*multiplier;
  ts=Number(row?.ts);
  bids=row?.bids;asks=row?.asks;
 }else{return null;}
 if(units===null||!within(ts,now))return null;
 const b=rows(bids,true,units),a=rows(asks,false,units);
 if(!b||!a||b[0][0]>=a[0][0])return null;
 const mid=(b[0][0]+a[0][0])/2;
 return {exchange:venue,symbol,asof_ms:ts,price_unit:'USDT',quantity_unit:'base_asset',
  best_bid:b[0][0],best_ask:a[0][0],mid,spread_bps:Number(((a[0][0]-b[0][0])/mid*10000).toFixed(3)),
  bids:b,asks:a,levels:{bids:b.length,asks:a.length},
  scope:'visible_orderbook_snapshot_only',unit_proof:venue==='Gate'?'contract_quanto_multiplier':'linear_ctVal_ctMult'};
}
export async function alternativeBooks(symbol,{now=Date.now(),fetchImpl=fetch}={}){
 const coin=symbol.slice(0,-4),gate=coin+'_USDT',okx=coin+'-USDT-SWAP';
 const [gateBook,gateMeta,okxBook,okxMeta]=await Promise.all([
  safeJson('https://api.gateio.ws/api/v4/futures/usdt/order_book?contract='+gate+'&limit=100',fetchImpl),
  safeJson('https://api.gateio.ws/api/v4/futures/usdt/contracts/'+gate,fetchImpl),
  safeJson('https://www.okx.com/api/v5/market/books?instId='+okx+'&sz=100',fetchImpl),
  safeJson('https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId='+okx,fetchImpl),
 ]);
 return [normalizeAlternative('Gate',gateBook,gateMeta,symbol,now),
   normalizeAlternative('OKX',okxBook,okxMeta,symbol,now)].filter(Boolean);
}
