/**
 * LUMEX AI Research — GitHub auto-deploy bootstrap (2026-11-13).
 * Deliberately NOT an automated trader. No exchange secrets or order functions.
 * Steps: link GitHub -> deploy -> verify /health -> configure secrets -> verify /status.
 * Cloudflare Containers/Queues/R2 must be separately provisioned before bulk tests.
 */
const JSON_HEADERS = Object.freeze({"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff","access-control-allow-origin":"none"});
const nowISO = () => new Date().toISOString();
function reply(body,status=200){return new Response(JSON.stringify(body),{status,headers:JSON_HEADERS});}
function authorized(request,env){
  const auth=request.headers.get("authorization")||"";
  const secret=env.LUMEX_ADMIN_API_TOKEN;
  if(!secret||secret.length<32)return false;
  // Only exact Bearer value accepted, never query strings.
  return auth===`Bearer ${secret}`;
}
export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname==="/"||url.pathname==="/health"){
      if(request.method!=="GET")return reply({ok:false,error:"method_not_allowed"},405);
      return reply({ok:true,service:"LUMEX AI Research",version:"github-cloudflare-1.0.0",stage:"bootstrap",deployed:true,research_enabled:false,live_orders:false,at:nowISO()});
    }
    if(url.pathname==="/status"){
      if(request.method!=="GET")return reply({ok:false,error:"method_not_allowed"},405);
      if(!authorized(request,env))return reply({ok:false,error:"unauthorized"},401);
      const host=env.LUMEX_SITE_URL||"https://lumexbot.com";
      // Only the fixed LUMEX site is supported; no user-supplied URLs/SSRF.
      if(host!=="https://lumexbot.com")return reply({ok:false,error:"invalid_site_configuration"},503);
      if(!env.LUMEX_AI_LAB_WORKER_TOKEN)return reply({ok:false,configured:false,error:"worker_token_not_configured",research_enabled:false},503);
      try{
        const response=await fetch(`${host}/wp-json/lumex/v1/research-lab/status`,{headers:{authorization:`Bearer ${env.LUMEX_AI_LAB_WORKER_TOKEN}`,accept:"application/json"},signal:AbortSignal.timeout(10000)});
        const text=await response.text();
        // Avoid returning untrusted upstream body or account details in response.
        let upstreamOk=false;try{upstreamOk=Boolean(JSON.parse(text)?.ok);}catch{}
        return reply({ok:response.ok&&upstreamOk,service:"LUMEX AI Research",wordpress_api_reachable:response.ok,wordpress_research_ready:upstreamOk,upstream_status:response.status,research_enabled:false,at:nowISO()},response.ok&&upstreamOk?200:502);
      }catch{return reply({ok:false,error:"wordpress_unreachable",research_enabled:false,at:nowISO()},502);}
    }
    // No task submission or state-changing endpoints in bootstrap.
    return reply({ok:false,error:"not_found"},404);
  }
};
