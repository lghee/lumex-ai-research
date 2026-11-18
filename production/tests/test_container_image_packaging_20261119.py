"""Offline image/source contract: fail before production if a Python module is omitted."""
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
class ContainerImagePackaging(unittest.TestCase):
    def test_binance_module_copied_into_docker_image(self):
        docker=(ROOT/'Dockerfile').read_text()
        self.assertIn('COPY cloudflare_binance_capture.py /app/cloudflare_binance_capture.py',docker)
        self.assertIn('COPY server.py /app/server.py',docker)
        self.assertIn('RUN python -c "import server;',docker,
            'must fail Docker image build before Cloudflare deployment if imports fail')
        self.assertTrue((ROOT/'cloudflare_binance_capture.py').is_file())
    def test_server_routes_and_image_health_contract(self):
        server=(ROOT/'server.py').read_text()
        for val in ('/binance-egress-probe','/binance-cloudflare-capture',
                    'lumex_binance_capture_20261119_v2',
                    'from cloudflare_binance_capture import collector'):
            self.assertIn(val,server)
    def test_worker_rollout_and_fail_closed(self):
        worker=(ROOT/'src/index.js').read_text()
        self.assertIn('container.inspect()',worker)
        self.assertIn('container.destroy(',worker)
        self.assertIn("if(binanceRoute&&container.running)",worker)
        self.assertIn('container_image_contract_mismatch',worker)
        self.assertIn('/market-hub/v1/binance-container-image-health',worker)
        self.assertNotIn("container.destroy('all_jobs')",worker)

if __name__=='__main__':
    unittest.main()
