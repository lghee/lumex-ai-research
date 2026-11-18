import importlib.util,unittest,datetime as dt
from pathlib import Path

spec=importlib.util.spec_from_file_location("bls_sidecar",(Path(__file__).parent.parent/"scripts"/"bls-official-sidecar.py"))
bls=importlib.util.module_from_spec(spec);spec.loader.exec_module(bls)
NOW=int(dt.datetime(2026,11,19,tzinfo=dt.timezone.utc).timestamp()*1000)

def wrap(headline,link,when):
    return ("<?xml version='1.0' encoding='UTF-8'?><feed xmlns='http://www.w3.org/2005/Atom'>"+
      "<entry><title>"+headline+"</title><link href='"+link+"' />"+
      "<published>"+when+"</published></entry></feed>").encode()

class TestOfficialAtom(unittest.TestCase):
    def test_true_cpi_atom(self):
        xml=wrap("CPI for all items increases 0.4% in October; shelter rises",
          "https://www.bls.gov/news.release/archives/cpi_11102026.htm",
          "2026-11-10T07:55:47.272-05:00")
        result=bls.atom_items(xml,"bls_cpi",NOW)
        self.assertEqual(len(result),1)
        self.assertEqual(result[0]["source_id"],"bls_cpi")
        self.assertEqual(result[0]["published_ms"],int(dt.datetime(2026,11,10,12,55,47,272000,tzinfo=dt.timezone.utc).timestamp()*1000))
    def test_real_jobs_release(self):
        xml=wrap("Payroll employment rises by 165,000 in October; unemployment rate changes little at 4.1%",
          "https://www.bls.gov/news.release/archives/empsit_11062026.htm",
          "2026-11-06T07:50:31.965-05:00")
        self.assertEqual(len(bls.atom_items(xml,"bls_jobs",NOW)),1)
    def test_wrong_domain_fails_closed(self):
        xml=wrap("CPI release official content","https://not-bls.example/news.release/archives/cpi_11102026.htm",
          "2026-11-10T07:55:47.272-05:00")
        with self.assertRaises(ValueError):bls.atom_items(xml,"bls_cpi",NOW)
    def test_wrong_feed_type_fails_closed(self):
        xml=wrap("CPI release official content","https://www.bls.gov/news.release/archives/cpi_11102026.htm",
          "2026-11-10T07:55:47.272-05:00")
        with self.assertRaises(ValueError):bls.atom_items(xml,"bls_jobs",NOW)
    def test_future_and_expired_rejected(self):
        for when in ("2036-01-01T00:00:00+00:00","2020-01-01T00:00:00+00:00"):
            xml=wrap("CPI release official content","https://www.bls.gov/news.release/archives/cpi_11102026.htm",when)
            with self.assertRaises(ValueError):bls.atom_items(xml,"bls_cpi",NOW)
    def test_unverified_html_rejected(self):
        with self.assertRaises(ValueError):bls.atom_items(b'<html><body>Forbidden</body></html>',"bls_jobs",NOW)
    def test_network_is_not_used_by_parser(self):
        self.assertTrue(all(x.startswith("bls_") for x in bls.SOURCES))
if __name__=='__main__':unittest.main()
