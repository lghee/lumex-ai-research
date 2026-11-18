/** Read-only health observation. Never logs the bearer token. */
const ingest=process.env.LUMEX_RELAY_ENDPOINT||'';
if(!/^https:\/\/[A-Za-z0-9.-]+\/market-hub\/v1\/binance-external-ingest$/.test(ingest)){
  process.stderr.write('health_invalid_endpoint\n');process.exit(2);
}
const statusUrl=ingest.replace(/binance-external-ingest$/,'binance-external-health');
try{
 const r=await fetch(statusUrl,{headers:{accept:'application/json'},signal:AbortSignal.timeout(8000)});
 if(!r.ok)throw Error('health_http_'+r.status);
 const d=await r.json();
 if(d?.ok!==true||d?.configured===false||d?.stale===true||d?.connected!==true||
   !Number.isSafeInteger(d?.received_ms)||Date.now()-d.received_ms>110000)
   throw Error('relay_not_receiving_contiguous_heartbeats');
 // Connected heartbeat is not proof that every market liquidation event was captured.
 process.exit(0);
}catch(e){process.stderr.write(String(e?.message||'unavailable').slice(0,90)+'\n');process.exit(1);}
