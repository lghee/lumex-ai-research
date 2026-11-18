"""Cloudflare ResearchContainer read-only Binance public forceOrder observation.
No VPS, no exchange API keys, no account/order endpoints. Session continuity is
never inferred across WebSocket reconnects or container restarts.
"""
from __future__ import annotations
import collections
import json
import threading
import time
import uuid

BINANCE_PUBLIC_WSS = "wss://fstream.binance.com/market/ws/!forceOrder@arr"
SYMBOLS = frozenset(("BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"))
MAX_BUFFER = 300
MAX_BATCH = 25


def clean_public_snapshot(raw: str):
    """Allow only documented exchange public snapshots and selected markets."""
    if not isinstance(raw, str) or len(raw) > 6000:
        return None
    try:
        document = json.loads(raw)
        if not isinstance(document, dict):
            return None
        if "stream" in document and document["stream"] != "!forceOrder@arr":
            return None
        data = document.get("data", document)
        order = data.get("o")
        if (data.get("e") != "forceOrder" or not isinstance(order, dict) or
                order.get("s") not in SYMBOLS or
                order.get("S") not in ("BUY", "SELL") or
                order.get("X") not in ("FILLED", "PARTIALLY_FILLED") or
                data.get("st", 1) != 1):
            return None
        event_ms = int(data.get("E"))
        trade_ms = int(order.get("T"))
        if event_ms <= 0 or trade_ms <= 0:
            return None
        now_ms = int(time.time() * 1000)
        if abs(now_ms - event_ms) > 120000 or abs(now_ms - trade_ms) > 120000:
            return None
        price, quantity = float(order.get("ap")), float(order.get("z"))
        if not (0 < price < 10**10 and 0 < quantity < 10**12):
            return None
        # Only source facts, never account/user/trading fields.
        return {"stream": "!forceOrder@arr", "data": {
            "e": "forceOrder", "E": event_ms, "st": 1,
            "o": {"s": order["s"], "S": order["S"], "X": order["X"],
                  "T": trade_ms, "ap": str(order["ap"]), "z": str(order["z"])}}}
    except (TypeError, ValueError, OverflowError, KeyError):
        return None


class CloudflareBinanceCapture:
    def __init__(self, clock=None, socket_factory=None):
        self.clock = clock or (lambda: int(time.time() * 1000))
        self.socket_factory = socket_factory
        self.lock = threading.Lock()
        self.thread = None
        self.session_id = str(uuid.uuid4())
        self.seq = 0
        self.buffer = collections.deque(maxlen=MAX_BUFFER)
        self.connected = False
        self.last_frame_ms = 0
        self.last_message_ms = 0
        self.connect_ms = 0
        self.dropped = 0
        self.retry_at_ms = 0
        self.last_error = "not_started"
        self.total_frames = 0

    def status(self):
        with self.lock:
            return self._status()

    def _status(self):
        return {"schema": "lumex_cloudflare_binance_container_v1",
                "connected": self.connected, "session_id": self.session_id,
                "connect_ms": self.connect_ms, "last_frame_ms": self.last_frame_ms,
                "last_message_ms": self.last_message_ms, "total_frames": self.total_frames,
                "dropped_events": self.dropped, "next_retry_ms": self.retry_at_ms,
                "error_code": self.last_error, "worker_is_source_of_truth": True,
                "full_market_capture": False, "trading_enabled": False}

    def ensure(self):
        now = self.clock()
        with self.lock:
            if self.thread is not None and self.thread.is_alive():
                return self._status()
            if now < self.retry_at_ms:
                return self._status()
            self.last_error = "connecting"
            self.retry_at_ms = now + 30000
            t = threading.Thread(target=self._run, name="public-binance-observer", daemon=True)
            self.thread = t
            t.start()
            return self._status()

    def _run(self):
        ws = None
        blocked = False
        try:
            if self.socket_factory is None:
                from websocket import create_connection, WebSocketBadStatusException
                factory = create_connection
            else:
                from websocket import WebSocketBadStatusException
                factory = self.socket_factory
            ws = factory(BINANCE_PUBLIC_WSS, timeout=12, enable_multithread=True)
            ws.settimeout(25)
            with self.lock:
                self.session_id = str(uuid.uuid4())
                self.seq = 0
                self.buffer.clear()
                self.dropped = 0
                self.connected = True
                self.connect_ms = self.clock()
                self.last_frame_ms = 0
                self.last_message_ms = 0
                self.last_error = None
            while True:
                try:
                    raw = ws.recv()
                except Exception as exc:
                    if type(exc).__name__ == "WebSocketTimeoutException":
                        ws.ping()
                        continue
                    raise
                if not isinstance(raw, str):
                    raise ConnectionError("websocket_disconnected")
                received_ms = self.clock()
                clean = clean_public_snapshot(raw)
                with self.lock:
                    self.last_message_ms = received_ms
                    if clean:
                        self.seq += 1
                        if len(self.buffer) == MAX_BUFFER:
                            self.dropped += 1
                        self.buffer.append({"seq": self.seq, "frame": clean})
                        self.last_frame_ms = received_ms
                        self.total_frames += 1
        except Exception as exc:
            code = getattr(exc, "status_code", None)
            if code in (403, 451):
                blocked = True
                reason = "binance_access_denied_" + str(code)
            else:
                reason = "binance_websocket_" + type(exc).__name__[:45]
            with self.lock:
                self.last_error = reason
        finally:
            try:
                if ws is not None:
                    ws.close()
            except Exception:
                pass
            with self.lock:
                self.connected = False
                self.retry_at_ms = self.clock() + (1800000 if blocked else 60000)

    def peek(self, session_id, after_seq, limit=MAX_BATCH):
        """Non-destructive batch: Worker checkpoints only AFTER verified R2 write."""
        if not isinstance(session_id, str) or len(session_id) > 60:
            raise ValueError("invalid_cursor_session")
        if not isinstance(after_seq, int) or after_seq < 0:
            raise ValueError("invalid_cursor")
        if not isinstance(limit, int) or limit < 1 or limit > MAX_BATCH:
            raise ValueError("invalid_limit")
        with self.lock:
            changed = session_id != self.session_id
            cursor = 0 if changed else after_seq
            oldest = self.buffer[0]["seq"] if self.buffer else self.seq + 1
            gap = cursor < oldest - 1
            frames = [dict(item) for item in self.buffer if item["seq"] > cursor][:limit]
            return {**self._status(), "session_changed": changed,
                    "cursor_gap": gap, "oldest_seq": oldest,
                    "latest_seq": self.seq, "frames": frames}


collector = CloudflareBinanceCapture()
