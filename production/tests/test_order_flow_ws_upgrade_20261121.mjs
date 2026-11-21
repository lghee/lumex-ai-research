import assert from 'node:assert/strict';
import {upgradeGateFuturesDecimalWebSocket,FUTURES_WS_URL} from '../src/order-flow-ws-upgrade.mjs';
let timeoutCallback=null,token={id:1},cancelled=false,seenSignal=null;
const response={status:101,webSocket:{readyState:1}};
const result=await upgradeGateFuturesDecimalWebSocket(async (url,request)=>{
 assert.equal(url,FUTURES_WS_URL);
 assert.equal(request.headers.Upgrade,'websocket');
 assert.equal(request.headers['X-Gate-Size-Decimal'],'1');
 seenSignal=request.signal;
 assert.equal(seenSignal.aborted,false);
 return response;
},{schedule:fn=>{timeoutCallback=fn;return token;},cancel:t=>{
 assert.equal(t,token);cancelled=true;}});
assert.equal(result,response);
assert.equal(cancelled,true,'handshake timer MUST be canceled immediately after HTTP 101');
assert.equal(seenSignal.aborted,false,'successful WebSocket should have a live non-aborted signal');
// Calling the captured callback models a late timeout callback that was
// correctly canceled by the scheduler. It must never be scheduled after 101.
assert.equal(typeof timeoutCallback,'function');
let abortCalled=false;
let pendingTimer;
const pending=upgradeGateFuturesDecimalWebSocket(async(url,request)=>{
 const {signal}=request;
 return new Promise((resolve,reject)=>{
  signal.addEventListener('abort',()=>{abortCalled=true;reject(Error('handshake_aborted'));});
 });
},{schedule:fn=>{pendingTimer=fn;return token;},cancel:()=>{}});
pendingTimer();
await assert.rejects(pending,/handshake_aborted/);
assert.equal(abortCalled,true,'an uncompleted handshake still obeys its 10-second deadline');
await assert.rejects(upgradeGateFuturesDecimalWebSocket(async()=>response,{timeoutMs:0}),/invalid_upgrade_timeout/);
console.log('PASS Phase38.1 cancel handshake timeout after 101; preserve timeout only for stalled websocket upgrades');
