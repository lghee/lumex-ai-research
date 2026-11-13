<?php
// No WordPress runtime needed for pure gate explanation.
define('ABSPATH',__DIR__.'/');
require_once __DIR__.'/../../../lumex-core/includes/class-lumex-ai-research-lab.php';
$bad=['gate'=>'failed_gate','oos_days'=>30,
  'oos'=>['trades'=>12,'net_return_pct'=>-2,'profit_factor'=>0.5,'mdd_pct'=>14],
  'double_cost'=>['net_return_pct'=>-3],'one_bar_delay'=>['net_return_pct'=>-2]];
$r=Lumex_AI_Research_Lab::gate_failures($bad);
if(count($r)!==6){fwrite(STDERR,'gate failure classifier mismatch: '.json_encode($r)."\n");exit(1);}
$good=$bad;$good['gate']='candidate_review';
if(Lumex_AI_Research_Lab::gate_failures($good)!==[]){exit(2);}
echo "PASS core gate explanations\n";
