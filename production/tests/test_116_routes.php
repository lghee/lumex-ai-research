<?php
define('ABSPATH',__DIR__.'/');
require_once __DIR__.'/../../../lumex-core/includes/class-lumex-ai-research-lab.php';
foreach (['/lumex/v1/research-lab/forward/jobs'=>'GET','/lumex/v1/research-lab/forward/records'=>'POST'] as $route=>$method) {
    if(!Lumex_AI_Research_Lab::is_lab_route($route,$method))exit(1);
    if(Lumex_AI_Research_Lab::is_lab_route($route,$method==='GET'?'POST':'GET'))exit(2);
}
if(Lumex_AI_Research_Lab::is_lab_route('/lumex/v1/research-lab/forward/records','GET'))exit(3);
echo "PASS signed REST route scope for forward evidence\n";
