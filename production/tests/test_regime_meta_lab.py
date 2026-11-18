"""Synthetic integrity tests only; results are never claimed as real backtest returns."""
import sys,unittest,time
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from engine.regime_meta_lab import SYMBOLS,FRAME,ResearchFailure,validated_market,build_research

def markets(now,n=3300):
    rng=np.random.default_rng(42)
    end=(now//FRAME-1)*FRAME
    stamp=end-(n-1)*FRAME+np.arange(n)*FRAME
    result={}
    for i,s in enumerate(SYMBOLS):
        returns=rng.normal(.0001,.007+i*.001,n)
        close=25000*np.exp(np.cumsum(returns))
        op=close*(1-rng.normal(0,.001,n))
        high=np.maximum(op,close)*1.004
        low=np.minimum(op,close)*.996
        volume=rng.uniform(100,1000,n)
        result[s]=np.column_stack((stamp,op,high,low,close,volume))
    return result

class RegimeMetaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.now=(int(time.time())//FRAME)*FRAME+40
        cls.data=markets(cls.now)
    def test_reproducible_and_nontrading(self):
        a=build_research(self.data,self.now)
        b=build_research(self.data,self.now)
        self.assertEqual(a,b)
        self.assertFalse(a['order_execution'])
        self.assertFalse(a['live_approved'])
        self.assertFalse(a['paper_forward_verified'])
        self.assertIn('PROHIBITED',a['promotion'])
        self.assertEqual(a['aligned_bars_per_symbol'],3300)
        self.assertLessEqual(a['holdout_ai_filter']['decisions'],a['holdout_baseline']['decisions'])
    def test_stress_penalizes_not_rewarded(self):
        a=build_research(self.data,self.now)
        self.assertLessEqual(a['holdout_cost_2x']['return_pct'],a['holdout_ai_filter']['return_pct'])
    def test_holdout_cannot_change_validation(self):
        a=build_research(self.data,self.now)
        altered={s:v.copy() for s,v in self.data.items()}
        for v in altered.values():v[int(len(v)*.82):,1:5]*=1.02
        b=build_research(altered,self.now)
        self.assertEqual(a['chosen_threshold'],b['chosen_threshold'])
        self.assertEqual(a['validation_threshold_trials'],b['validation_threshold_trials'])
    def test_bad_ohlcv_and_gap_rejected(self):
        a=self.data['BTCUSDT']
        rows=[dict(t=int(r[0]),o=str(r[1]),h=str(r[2]),l=str(r[3]),c=str(r[4]),v=str(r[5])) for r in a]
        self.assertEqual(len(validated_market(rows,self.now)),len(a))
        rows.pop(100)
        with self.assertRaises(ResearchFailure):validated_market(rows,self.now)
        with self.assertRaises(ResearchFailure):build_research({'BTCUSDT':a},self.now)

if __name__=='__main__':unittest.main()
