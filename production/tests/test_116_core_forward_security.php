<?php
// Test fail-closed paper-forward API: only candidate_review jobs may create records.
define('ABSPATH',__DIR__.'/');
define('ARRAY_A','ARRAY_A');
class WP_Error {public function __construct(public $code,public $message,public $data){} }
class FakeWpdb {
    public string $prefix='test_';public int $inserts=0;
    public function prepare($query,...$args){return $query;}
    public function get_row($sql,$format){return ['id'=>42,'symbol'=>'BTCUSDT','interval_min'=>15,'status'=>'completed','finished_unix'=>time()-3600];}
    public function insert(...$args){$this->inserts++;return 1;}
}
$GLOBALS['wpdb']=new FakeWpdb();
require_once __DIR__.'/../../../lumex-core/includes/class-lumex-ai-research-lab.php';
$step=900000;$now=time()*1000;$candle=(int)(floor($now/$step)-1)*$step;
$payload=['id'=>42,'job_hash'=>str_repeat('b',64),'symbol'=>'BTCUSDT','interval_min'=>15,
 'candle_open_ms'=>$candle,'direction'=>'flat','close_price'=>100,'data_sha256'=>str_repeat('a',64),
 'source'=>'gateio_usdt_perpetual'];
$m=new ReflectionMethod('Lumex_AI_Research_Lab','record_forward');
$result=$m->invoke(null,$payload);
if(!($result instanceof WP_Error) || $result->code!=='lumex_ai_lab_forward_candidate_not_eligible' || $GLOBALS['wpdb']->inserts!==0){
 fwrite(STDERR,"FORWARD GATE NOT ENFORCED\n");exit(1);
}
echo "PASS forward: completed / failed_gate jobs cannot publish paper observations\n";
