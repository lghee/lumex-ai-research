// 외부 감시: judges, alert after N failures, hourly reminder, recovery, no pile-on while the home page is down,
// safe-stop increase, Telegram target (env secret > site-provided, cached while the site is down, cleared when
// the operator turns it off), 404 before Core 0.7.16, report size and no secrets in the report.
import assert from 'node:assert/strict';
import {judgeHome,judgeHealth,judgeScheduler,judgeAccounts,judgeFresh,evaluate,report,siteMonitorTick,duration,
  STATE_KEY,REMIND_MS,MIN_GAP_MS} from '../src/site-monitor.mjs';
const MIN=60000,T0=Date.UTC(2026,10,24,12,0);
const html='<!doctype html><html><body>'+'x'.repeat(2000)+'</body></html>';
// 1) judges
assert.equal(judgeHome({status:200,text:html,ms:120}).ok,true);
assert.deepEqual(judgeHome({status:503,text:'busy'}),{ok:false,detail:'HTTP 503'});
assert.equal(judgeHome({status:0,error:'timeout'}).detail,'응답 없음(15초)');
assert.equal(judgeHome({status:200,text:'<html></html>'}).ok,false,'empty page is a failure');
const H=o=>({status:200,text:JSON.stringify({schema:'lumex_ops_health_v1',db_ok:true,scheduler:{state:'ok',age_s:30},accounts:{running:2,stale:0,blocked:0},kill_switch:false,notify:null,...o})});
assert.deepEqual(judgeHealth({status:404,text:'{}'}),{api:null,health:null,missing:true},'Core < 0.7.16: no alert');
assert.equal(judgeHealth({status:401,text:'{}'}).api.detail,'인증 실패(Worker 토큰 확인)');
assert.equal(judgeHealth(H({db_ok:false})).api.detail,'DB 연결 실패');
const hh=judgeHealth(H({}));assert.equal(hh.api.ok,true);
assert.equal(judgeScheduler({scheduler:{state:'stale',age_s:1500}}).detail,'마지막 실행 25분 전');
assert.equal(judgeScheduler({scheduler:{state:'not_configured'}}),null);
assert.equal(judgeAccounts({accounts:{stale:2}}).ok,false);
assert.equal(judgeAccounts({accounts:{stale:2},kill_switch:true}).ok,true,'operator pause is not a fault');
assert.equal(judgeFresh({last_tick_ms:T0-25*MIN},'last_tick_ms',T0,20*MIN).detail,'25분째 갱신 없음');
assert.equal(judgeFresh(null,'last_tick_ms',T0,20*MIN).ok,false);
assert.equal(duration(95*MIN),'1시간 35분');
// 2) evaluate: home needs 2 fails, scheduler 1; reminder hourly; recovery once
let r=evaluate({},{home:{ok:false,detail:'HTTP 503'}},T0);
assert.equal(r.messages.length,0,'first home failure: wait');
r=evaluate(r.state,{home:{ok:false,detail:'HTTP 503'}},T0+5*MIN);
assert.equal(r.messages.length,1);assert.match(r.messages[0],/홈 화면 문제\nHTTP 503\n11\.24 21:00 KST부터/);
r=evaluate(r.state,{home:{ok:false,detail:'HTTP 503'}},T0+30*MIN);assert.equal(r.messages.length,0,'no repeat inside the hour');
r=evaluate(r.state,{home:{ok:false,detail:'HTTP 502'}},T0+5*MIN+REMIND_MS);assert.match(r.messages[0],/계속: 홈 화면 문제 — 1시간 5분째\nHTTP 502/);
r=evaluate(r.state,{home:{ok:true}},T0+70*MIN);assert.match(r.messages[0],/복구: 홈 화면 정상\n중단 약 1시간 10분 \(11\.24 21:00~22:10 KST\)/);
assert.deepEqual(r.state.incidents,{});
r=evaluate({},{home:{ok:false,detail:'x'}},T0);r=evaluate(r.state,{home:{ok:true}},T0+5*MIN);assert.equal(r.messages.length,0,'one blip: no alert, no recovery');
// home down → api/scheduler/accounts are not judged (no pile-on); league is independent
r=evaluate({},{home:{ok:false,detail:'x'},api:{ok:false,detail:'y'},scheduler:{ok:false,detail:'z'},league:{ok:false,detail:'25분째'}},T0);
assert.deepEqual(Object.keys(r.state.incidents).sort(),['home','league']);assert.equal(r.messages.length,1);assert.match(r.messages[0],/AI 모의 리그 갱신 문제/);
r=evaluate({},{scheduler:{ok:false,detail:'마지막 실행 12분 전'}},T0);assert.match(r.messages[0],/자동매매 주문 처리 문제\n마지막 실행 12분 전/);
// safe-stop increase
r=evaluate({},{},T0,{health:{accounts:{blocked:1}}});assert.equal(r.messages.length,0,'first read sets the baseline');
r=evaluate(r.state,{},T0+5*MIN,{health:{accounts:{blocked:2}}});assert.match(r.messages[0],/안전 중지 계정이 늘었습니다: 1개 → 2개/);
r=evaluate(r.state,{},T0+10*MIN,{health:{accounts:{blocked:1}}});assert.equal(r.messages.length,0);assert.equal(r.state.blocked_last,1);
// report: compact, capped, never the token
const big={incidents:{home:{since_ms:T0,detail:'x'.repeat(500),alerted_ms:T0}},events:Array.from({length:40},(_,i)=>({k:'home',kind:'down',at_ms:T0+i,detail:'y'.repeat(200)})),tg:{bot_token:'111:SECRET',chat_ids:['5']},tg_status:'ok'};
const rep=report(big,T0);assert.ok(rep.length<=3500);assert.ok(!rep.includes('SECRET'));assert.equal(JSON.parse(rep).v,1);
// 3) tick with fake R2 + fetch
function env(extra={}){const store=new Map();return {store,LUMEX_SITE_URL:'https://lumexbot.com',LUMEX_AI_LAB_WORKER_TOKEN:'t'.repeat(64),AUTO_PAPER_LEAGUE:'true',
  MARKET_DATA:{async get(k){const v=store.get(k);return v===undefined?null:{json:async()=>JSON.parse(v)};},async put(k,v){store.set(k,v);}},...extra};}
function net(plan){const sent=[];const calls=[];const f=async(url,init={})=>{calls.push({url,init});
  if(url.startsWith('https://api.telegram.org/'))return {status:plan.tg??200,text:async()=>{sent.push({url,body:JSON.parse(init.body)});return '{"ok":true}';}};
  if(url.includes('/wp-json/lumex/v1/ops/health')){const x=plan.health;if(x===0)throw Error('down');return {status:x.status,text:async()=>x.text};}
  const x=plan.home;if(x===0)throw Error('down');return {status:x.status,text:async()=>x.text};};return {f,sent,calls};}
const E=env();E.store.set('paper-league/v1/state.json',JSON.stringify({last_tick_ms:T0-2*MIN}));E.store.set('paper-league/v1/signals.json',JSON.stringify({generated_at_ms:T0-2*MIN}));
const tgOn=H({notify:{telegram:{bot_token:'123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ',chat_ids:['5550001']}}});
let n=net({home:{status:200,text:html},health:tgOn});
let out=await siteMonitorTick(E,T0,n.f);assert.equal(out.ok,true);assert.equal(out.sent,0);assert.equal(n.sent.length,0);
const auth=n.calls.find(c=>c.url.includes('ops/health')).init.headers;assert.equal(auth.authorization,'Bearer '+'t'.repeat(64));assert.equal(auth['x-lumex-ops'],auth.authorization);
assert.equal(JSON.parse(E.store.get(STATE_KEY)).tg.chat_ids[0],'5550001','site-provided target cached');
out=await siteMonitorTick(E,T0+MIN,n.f);assert.equal(out.skipped,'recent_run','runs at most every ~3 minutes');
// site goes down completely: alert on the 2nd check with the cached target
n=net({home:0,health:0});
await siteMonitorTick(E,T0+5*MIN,n.f);assert.equal(n.sent.length,0);
await siteMonitorTick(E,T0+10*MIN,n.f);assert.equal(n.sent.length,1);assert.match(n.sent[0].body.text,/홈 화면 문제\n연결 실패/);assert.equal(n.sent[0].body.chat_id,'5550001');
assert.ok(n.sent[0].url.includes('bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ/sendMessage'));
assert.ok(JSON.parse(E.store.get(STATE_KEY)).tg,'cache kept while the site is down');
// comes back; report sent to the site carries the open problem but not the token
n=net({home:{status:200,text:html},health:tgOn});
E.store.set('paper-league/v1/state.json',JSON.stringify({last_tick_ms:T0+14*MIN}));E.store.set('paper-league/v1/signals.json',JSON.stringify({generated_at_ms:T0+14*MIN}));
await siteMonitorTick(E,T0+15*MIN,n.f);assert.equal(n.sent.length,1);assert.match(n.sent[0].body.text,/복구: 홈 화면 정상\n중단 약 10분 \(11\.24 21:05~21:15 KST\)/);
const sentReport=decodeURIComponent(n.calls.find(c=>c.url.includes('ops/health')).url.split('report=')[1]);
assert.equal(JSON.parse(sentReport).open[0].k,'home');assert.ok(!sentReport.includes('ABCDEFGHIJ'));
// operator turns alerts off → cache cleared, nothing sent afterwards
n=net({home:{status:200,text:html},health:H({notify:null,scheduler:{state:'stale',age_s:900}})});
await siteMonitorTick(E,T0+20*MIN,n.f);assert.equal(JSON.parse(E.store.get(STATE_KEY)).tg,undefined);assert.equal(n.sent.length,0);
assert.equal(JSON.parse(E.store.get(STATE_KEY)).tg_status,'none');assert.ok(JSON.parse(E.store.get(STATE_KEY)).incidents.scheduler,'problem still recorded');
// env secrets win over the site
const E2=env({LUMEX_OPS_TELEGRAM_BOT_TOKEN:'999999:ZYXWVUTSRQPONMLKJIHGFEDCBA',LUMEX_OPS_TELEGRAM_CHAT_ID:'111222, 333444'});
E2.store.set('paper-league/v1/state.json',JSON.stringify({last_tick_ms:T0}));E2.store.set('paper-league/v1/signals.json',JSON.stringify({generated_at_ms:T0}));
n=net({home:{status:200,text:html},health:H({scheduler:{state:'never'},notify:{telegram:{bot_token:'1:x',chat_ids:['1']}}})});
await siteMonitorTick(E2,T0,n.f);assert.equal(n.sent.length,2);assert.deepEqual(n.sent.map(x=>x.body.chat_id),['111222','333444']);
assert.ok(n.sent.every(x=>x.url.includes('bot999999:')));assert.match(n.sent[0].body.text,/예약 실행 기록 없음/);
// Core < 0.7.16 → 404: no api alert even after many checks
const E3=env();E3.store.set('paper-league/v1/state.json',JSON.stringify({last_tick_ms:T0}));E3.store.set('paper-league/v1/signals.json',JSON.stringify({generated_at_ms:T0}));
for(let i=0;i<4;i++){n=net({home:{status:200,text:html},health:{status:404,text:'{"code":"rest_no_route"}'}});await siteMonitorTick(E3,T0+i*5*MIN,n.f);}
const s3=JSON.parse(E3.store.get(STATE_KEY));assert.deepEqual(s3.incidents,{});assert.equal(s3.api_missing,true);
// stale league ledger → alert with no Telegram target → recorded as 'none'
const E4=env();E4.store.set('paper-league/v1/state.json',JSON.stringify({last_tick_ms:T0-40*MIN}));E4.store.set('paper-league/v1/signals.json',JSON.stringify({generated_at_ms:T0}));
n=net({home:{status:200,text:html},health:H({})});out=await siteMonitorTick(E4,T0,n.f);
assert.deepEqual(out.open,['league']);assert.equal(out.telegram,'none');
console.log('site monitor: judges, thresholds, reminder, recovery, no pile-on, safe-stop increase, Telegram target and cache, 404, report — ok');
