"""Offline read-only Binance egress handshake tests, no real network."""
import unittest
import server

class FakeResponse:
    def __init__(self,status):self.status=status

class FakeConnection:
    def __init__(self,host,timeout):
        self.host=host;self.timeout=timeout;self.closed=False
        self.request_data=None;self.status=FakeConnection.next_status
    next_status=101
    def request(self,method,path,headers):
        self.request_data=(method,path,headers)
        FakeConnection.last_request=self.request_data
    def getresponse(self):return FakeResponse(self.status)
    def close(self):self.closed=True
    last_request=None

class ProbeTest(unittest.TestCase):
    def test_read_only_handshake(self):
        FakeConnection.next_status=101
        x=server.probe_binance_public_handshake(FakeConnection)
        self.assertTrue(x['ok'])
        self.assertEqual(x['handshake_http_status'],101)
        self.assertEqual(x['scope'],'http_upgrade_handshake_only')
        method,path,headers=FakeConnection.last_request
        self.assertEqual(method,'GET')
        self.assertEqual(path,'/market/stream?streams=!forceOrder@arr')
        self.assertEqual(headers['Upgrade'],'websocket')
        self.assertEqual(headers['Sec-WebSocket-Version'],'13')
        self.assertNotIn('Authorization',headers)
        self.assertFalse(x['trading_enabled'])
    def test_forbidden_is_not_success(self):
        FakeConnection.next_status=403
        x=server.probe_binance_public_handshake(FakeConnection)
        self.assertFalse(x['ok'])
        self.assertEqual(x['error_code'],'upstream_http_forbidden')
    def test_451_is_forbidden(self):
        FakeConnection.next_status=451
        x=server.probe_binance_public_handshake(FakeConnection)
        self.assertFalse(x['ok'])
        self.assertEqual(x['handshake_http_status'],451)
    def test_connection_failure(self):
        def fail(*args,**kwargs):raise OSError('network down')
        x=server.probe_binance_public_handshake(fail)
        self.assertFalse(x['ok'])
        self.assertEqual(x['error_code'],'upstream_unavailable')

if __name__=='__main__':unittest.main()
