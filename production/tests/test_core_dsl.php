<?php
// Offline validation of the Core DSL and route permissions. No WordPress bootstrap.
define('ABSPATH', '/tmp/');
$source=getenv('LUMEX_CORE_SOURCE');
if(!$source || !is_file($source)) { fwrite(STDERR, "Set LUMEX_CORE_SOURCE to the Core class PHP file.\n"); exit(2); }
require_once $source;
function check($value, $msg) { if(!$value) { fwrite(STDERR,"FAIL: $msg\n");exit(1); } }
$good=['family'=>'breakout','lookback'=>20,'fast'=>10,'slow'=>50,'rsi'=>55,'volume_mult'=>1.2,'stop_atr'=>1.5,'take_atr'=>3.0,'max_hold'=>20,'trend_filter'=>true];
check(Lumex_AI_Research_Lab::validate_spec($good)!==null,'valid DSL spec rejected');
$bad=$good;$bad['slow']=5;
check(Lumex_AI_Research_Lab::validate_spec($bad)===null,'slow<=fast must fail');
$bad=$good;$bad['unknown']='unsafe';
check(Lumex_AI_Research_Lab::validate_spec($bad)===null,'unknown DSL keys must fail');
check(Lumex_AI_Research_Lab::generate(12,'2026-11-13')!==null,'deterministic grid spec');
check(Lumex_AI_Research_Lab::is_lab_route('/lumex/v1/research-lab/release','POST'),'release endpoint');
check(Lumex_AI_Research_Lab::is_lab_route('/lumex/v1/research-lab/telemetry','POST'),'telemetry endpoint');
check(!Lumex_AI_Research_Lab::is_lab_route('/lumex/v1/research-lab/release','GET'),'method boundary');
check(!Lumex_AI_Research_Lab::is_lab_route('/lumex/v1/trade/order','POST'),'no order exception');
echo "PASS Core DSL and REST route boundaries\n";
