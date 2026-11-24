// LUMEX 외부 감시 — every 5 minutes from the Worker cron (AUTO_SITE_MONITOR).
// Read-only checks: the site home page, the WordPress health route (/lumex/v1/ops/health: order scheduler,
// live accounts, DB), and this Worker's own paper league + signal ledger in R2. Problems and recoveries go to
// the operator's Telegram. No order, account or member data is read or sent.
//
// Telegram target: Worker secrets LUMEX_OPS_TELEGRAM_BOT_TOKEN + LUMEX_OPS_TELEGRAM_CHAT_ID (comma list) if set;
// otherwise what the site hands over in the health response (operator switch in 운영센터), cached in R2 so alerts
// still go out while the site is down.
import {SIGNALS} from './paper-league-signals.mjs';

export const STATE_KEY='ops/site-monitor/v1/state.json';
const LEAGUE_KEY='paper-league/v1/state.json';
const MIN=60000;
export const RULES={
  home:{label:'홈 화면',after:2},                 // two checks in a row ≈ 10 minutes
  api:{label:'사이트 점검 응답',after:2},
  scheduler:{label:'자동매매 주문 처리',after:1},  // the site already applies a 10-minute rule
  accounts:{label:'자동매매 계정 실행',after:2},
  league:{label:'AI 모의 리그 갱신',after:1},      // 20 minutes without a tick
  signals:{label:'자동매매 신호 장부',after:1},    // 15 minutes without a ledger
};
export const REMIND_MS=60*MIN, LEAGUE_STALE_MS=20*MIN, SIGNALS_STALE_MS=15*MIN, MIN_GAP_MS=200000;

const kst=ms=>{const d=new Date(ms+9*3600000);const p=n=>String(n).padStart(2,'0');return `${p(d.getUTCMonth()+1)}.${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;};
export function duration(ms){const m=Math.max(1,Math.round(ms/MIN));if(m<60)return `${m}분`;const h=Math.floor(m/60),r=m%60;return r?`${h}시간 ${r}분`:`${h}시간`;}
const clip=(s,n=120)=>String(s??'').replace(/[\u0000-\u001f]/g,' ').slice(0,n);

async function timed(fetchImpl,url,init,ms){
  const ac=new AbortController();const t=setTimeout(()=>ac.abort(),ms);const t0=Date.now();
  try{const r=await fetchImpl(url,{...init,signal:ac.signal});const text=await r.text();return {status:r.status,text,ms:Date.now()-t0};}
  catch(e){return {status:0,error:ac.signal.aborted?'timeout':'network',ms:Date.now()-t0};}
  finally{clearTimeout(t);}
}
/** Home page: 2xx/3xx with a real HTML document. */
export function judgeHome(r){
  if(!r||r.status===0)return {ok:false,detail:r?.error==='timeout'?'응답 없음(15초)':'연결 실패'};
  if(r.status>=400)return {ok:false,detail:`HTTP ${r.status}`};
  if(!/<\/html>/i.test(r.text||'')||(r.text||'').length<1000)return {ok:false,detail:'페이지 내용이 비어 있음'};
  return {ok:true,detail:`${r.ms}ms`};
}
/** Health route → results for api / scheduler / accounts (null = unknown: no alert change). */
export function judgeHealth(r){
  if(!r||r.status===0)return {api:{ok:false,detail:r?.error==='timeout'?'점검 응답 없음(15초)':'점검 연결 실패'},health:null};
  if(r.status===404)return {api:null,health:null,missing:true};          // Core < 0.7.16: route not installed yet
  if(r.status===401||r.status===403)return {api:{ok:false,detail:'인증 실패(Worker 토큰 확인)'},health:null};
  let j=null;try{j=JSON.parse(r.text||'');}catch{}
  if(r.status!==200||j?.schema!=='lumex_ops_health_v1')return {api:{ok:false,detail:`HTTP ${r.status}`},health:null};
  if(j.db_ok!==true)return {api:{ok:false,detail:'DB 연결 실패'},health:j};
  return {api:{ok:true,detail:''},health:j};
}
export function judgeScheduler(h){
  const s=h?.scheduler;if(!s)return null;
  if(s.state==='not_configured')return null;
  if(s.state==='ok')return {ok:true,detail:''};
  if(s.state==='never')return {ok:false,detail:'예약 실행 기록 없음'};
  return {ok:false,detail:`마지막 실행 ${duration((Number(s.age_s)||0)*1000)} 전`};
}
export function judgeAccounts(h){
  const a=h?.accounts;if(!a)return null;
  if(h.kill_switch)return {ok:true,detail:''};   // operator paused everything on purpose
  return (Number(a.stale)||0)>0?{ok:false,detail:`운용 중 ${a.stale}개 계정이 15분 넘게 실행되지 않음`}:{ok:true,detail:''};
}
export function judgeFresh(doc,field,now,limit){
  const t=Number(doc?.[field]);if(!doc||!Number.isFinite(t)||t<=0)return {ok:false,detail:'기록 없음'};
  return now-t>limit?{ok:false,detail:`${duration(now-t)}째 갱신 없음`}:{ok:true,detail:''};
}

/** Pure: previous state + results → next state + messages. results[k] = {ok,detail} | null (unknown). */
export function evaluate(prev,results,now,extra={}){
  const st={incidents:{},events:[],blocked_last:null,...prev};st.incidents={...(prev?.incidents||{})};st.events=[...(prev?.events||[])];
  const out=[];const push=(k,kind,detail,text)=>{out.push(text);st.events.push({k,kind,at_ms:now,detail:clip(detail)});};
  // the home page being down explains everything behind it: don't pile on
  const homeDown=results.home&&results.home.ok===false;
  for(const k of Object.keys(RULES)){
    let r=results[k];if(r===undefined)r=null;
    if(homeDown&&k!=='home'&&['api','scheduler','accounts'].includes(k))r=null;
    if(r===null)continue;
    const inc=st.incidents[k];const label=RULES[k].label;
    if(r.ok){
      if(inc){delete st.incidents[k];
        if(inc.alerted_ms)push(k,'up','',`[LUMEX 감시] 복구: ${label} 정상\n중단 약 ${duration(now-inc.since_ms)} (${kst(inc.since_ms)}~${kst(now).slice(6)} KST)`);}
      continue;
    }
    const cur=inc?{...inc,fails:inc.fails+1,detail:clip(r.detail)}:{since_ms:now,fails:1,detail:clip(r.detail),alerted_ms:0};
    if(!cur.alerted_ms&&cur.fails>=RULES[k].after){cur.alerted_ms=now;
      push(k,'down',cur.detail,`[LUMEX 감시] ${label} 문제\n${cur.detail}\n${kst(cur.since_ms)} KST부터 · ${extra.site||'lumexbot.com'}`);}
    else if(cur.alerted_ms&&now-cur.alerted_ms>=REMIND_MS){cur.alerted_ms=now;
      push(k,'again',cur.detail,`[LUMEX 감시] 계속: ${label} 문제 — ${duration(now-cur.since_ms)}째\n${cur.detail}`);}
    st.incidents[k]=cur;
  }
  // more accounts in safe stop since the last good read → tell the operator once per increase
  const b=Number(extra.health?.accounts?.blocked);
  if(extra.health&&Number.isFinite(b)){
    if(st.blocked_last!==null&&b>st.blocked_last)push('blocked','info',`${st.blocked_last}→${b}`,`[LUMEX 감시] 안전 중지 계정이 늘었습니다: ${st.blocked_last}개 → ${b}개\n운영센터 › 주문·포지션에서 사유를 확인하세요.`);
    st.blocked_last=b;
  }
  st.events=st.events.slice(-20);
  return {state:st,messages:out};
}
/** Compact report the site keeps for the 운영센터 screen (≤ 4,000 chars). */
export function report(st,now){
  const open=Object.entries(st?.incidents||{}).map(([k,v])=>({k,since_ms:v.since_ms,detail:clip(v.detail,100),alerted:!!v.alerted_ms}));
  const r={v:1,checked_ms:now,tg:st?.tg_status||'none',open,events:(st?.events||[]).slice(-10).map(e=>({...e,detail:clip(e.detail,80)}))};
  let s=JSON.stringify(r);while(s.length>3500&&r.events.length){r.events.shift();s=JSON.stringify(r);}
  return s;
}
function telegramTarget(env,st){
  const tok=env.LUMEX_OPS_TELEGRAM_BOT_TOKEN,ids=String(env.LUMEX_OPS_TELEGRAM_CHAT_ID||'').split(',').map(x=>x.trim()).filter(x=>/^-?\d{3,20}$/.test(x));
  if(typeof tok==='string'&&/^\d{5,15}:[\w-]{20,80}$/.test(tok)&&ids.length)return {bot_token:tok,chat_ids:ids,source:'env'};
  const c=st?.tg;if(c&&typeof c.bot_token==='string'&&Array.isArray(c.chat_ids)&&c.chat_ids.length)return {...c,source:'site'};
  return null;
}
async function sendTelegram(fetchImpl,target,text){
  let ok=0;
  for(const id of target.chat_ids.slice(0,5)){
    const r=await timed(fetchImpl,`https://api.telegram.org/bot${target.bot_token}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({chat_id:id,text,disable_web_page_preview:true})},10000);
    if(r.status===200)ok++;
  }
  return ok;
}

export async function siteMonitorTick(env,now=Date.now(),fetchImpl=fetch){
  if(!env.MARKET_DATA)return {ok:false,reason:'r2_missing'};
  const read=async k=>{try{const o=await env.MARKET_DATA.get(k);return o?await o.json():null;}catch{return null;}};
  const prev=(await read(STATE_KEY))||{};
  if(prev.last_run_ms&&now-prev.last_run_ms<MIN_GAP_MS)return {ok:true,skipped:'recent_run'};
  const site=String(env.LUMEX_SITE_URL||'https://lumexbot.com').replace(/\/+$/,'');
  const token=typeof env.LUMEX_AI_LAB_WORKER_TOKEN==='string'&&env.LUMEX_AI_LAB_WORKER_TOKEN.length>=48?env.LUMEX_AI_LAB_WORKER_TOKEN:'';
  const auth=token?{authorization:`Bearer ${token}`,'x-lumex-ops':`Bearer ${token}`}:{};
  const [home,health,league,ledger]=await Promise.all([
    timed(fetchImpl,site+'/',{headers:{'cache-control':'no-cache','user-agent':'LUMEX-Monitor/1.0'},redirect:'follow'},15000),
    token?timed(fetchImpl,`${site}/wp-json/lumex/v1/ops/health?report=${encodeURIComponent(report(prev,now))}`,{headers:{...auth,accept:'application/json','cache-control':'no-cache','user-agent':'LUMEX-Monitor/1.0'}},15000):Promise.resolve(null),
    read(LEAGUE_KEY),read(SIGNALS)]);
  const h=token?judgeHealth(health):{api:null,health:null};
  const results={home:judgeHome(home),api:h.api,scheduler:judgeScheduler(h.health),accounts:judgeAccounts(h.health),
    league:env.AUTO_PAPER_LEAGUE==='true'?judgeFresh(league,'last_tick_ms',now,LEAGUE_STALE_MS):null,
    signals:env.AUTO_PAPER_LEAGUE==='true'?judgeFresh(ledger,'generated_at_ms',now,SIGNALS_STALE_MS):null};
  const {state,messages}=evaluate(prev,results,now,{site:site.replace(/^https?:\/\//,''),health:h.health});
  state.last_run_ms=now;state.api_missing=!!h.missing;
  // Telegram target from the site (only when the site answered): keep, replace or clear.
  if(h.health){const t=h.health.notify?.telegram;
    if(t&&typeof t.bot_token==='string'&&Array.isArray(t.chat_ids))state.tg={bot_token:t.bot_token,chat_ids:t.chat_ids.map(String).slice(0,5),fetched_ms:now};
    else delete state.tg;}
  const target=telegramTarget(env,state);
  if(messages.length){
    if(!target)state.tg_status='none';
    else{let sent=0;for(const m of messages)sent+=await sendTelegram(fetchImpl,target,m);state.tg_status=sent?(target.source==='env'?'env':'ok'):'error';}
  }else if(!target)state.tg_status='none';
  await env.MARKET_DATA.put(STATE_KEY,JSON.stringify(state),{httpMetadata:{contentType:'application/json'}});
  return {ok:true,open:Object.keys(state.incidents),sent:messages.length,telegram:state.tg_status||'none'};
}
