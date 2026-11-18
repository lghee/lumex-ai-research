#!/usr/bin/env python3
"""Public BLS Atom RSS -> signed GitHub Actions OIDC -> LUMEX Cloudflare R2.
No credentials or trading data. Source headlines only, explicit provenance.
"""
from __future__ import annotations
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from typing import Any

AUDIENCE = "lumex-official-bls-v1"
INGEST = "https://lumex-ai-research2.kpiplus195.workers.dev/market-hub/v1/bls-oidc-ingest"
SOURCES = {
    "bls_cpi": ("https://www.bls.gov/feed/cpi.rss", re.compile(r"^/news\.release/archives/cpi_\d{8}\.htm$")),
    "bls_jobs": ("https://www.bls.gov/feed/empsit.rss", re.compile(r"^/news\.release/archives/empsit_\d{8}\.htm$")),
}
ATOM = "{http://www.w3.org/2005/Atom}"


def clean_title(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def atom_items(payload: bytes, source_id: str, now_ms: int) -> list[dict[str, Any]]:
    if not isinstance(payload, bytes) or len(payload) > 500000:
        raise ValueError("atom_bytes_invalid")
    root = ET.fromstring(payload)
    if root.tag != ATOM + "feed":
        raise ValueError("atom_feed_root_invalid")
    pattern = SOURCES[source_id][1]
    items = []
    used = set()
    for entry in root.findall(ATOM + "entry")[:50]:
        title = clean_title(entry.findtext(ATOM + "title") or "")
        link = next((e.get("href", "") for e in entry.findall(ATOM + "link")
                     if e.get("rel") in (None, "alternate") and e.get("href")), "")
        published = entry.findtext(ATOM + "published") or entry.findtext(ATOM + "updated")
        if not link or not published or len(title) < 9 or len(title) > 230 or "<" in title or ">" in title:
            continue
        parsed = urllib.parse.urlparse(link)
        if (parsed.scheme != "https" or parsed.hostname != "www.bls.gov" or parsed.port or
                parsed.username or parsed.password or parsed.query or parsed.fragment or
                not pattern.fullmatch(parsed.path) or link in used):
            continue
        try:
            stamp = dt.datetime.fromisoformat(published.replace("Z", "+00:00"))
            if stamp.tzinfo is None:
                raise ValueError("naive_date")
            published_ms = int(stamp.timestamp() * 1000)
        except (ValueError, TypeError):
            continue
        if published_ms > now_ms + 3600000 or published_ms < now_ms - 90*86400000:
            continue
        used.add(link)
        items.append(dict(source_id=source_id, title=title, source_url=link,
                          published_ms=published_ms))
    if not items:
        raise ValueError("atom_recent_official_articles_missing")
    return items[:12]


def request_bytes(url: str, timeout: int = 15, headers: dict | None = None) -> bytes:
    req = urllib.request.Request(url, headers=headers or {
        "Accept": "application/atom+xml,application/rss+xml",
        "User-Agent": "Mozilla/5.0 (compatible; LUMEX official-public-data-research/1.0)",
    })
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.read(500001)


def github_oidc() -> str:
    base = os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"]
    secret = os.environ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]
    url = base + ("&" if "?" in base else "?") + urllib.parse.urlencode({"audience": AUDIENCE})
    raw = request_bytes(url, timeout=12, headers={"Authorization": "Bearer " + secret,
                                                    "Accept": "application/json"})
    token = json.loads(raw).get("value")
    if not isinstance(token, str) or not (100 < len(token) < 15000):
        raise ValueError("oidc_token_missing")
    return token


def collect(now_ms: int) -> dict:
    results = []
    feeds = []
    for key, (url, _) in SOURCES.items():
        try:
            raw = request_bytes(url)
            items = atom_items(raw, key, now_ms)
            results.extend(items)
            feeds.append(dict(id=key, status="verified"))
        except Exception as exc:
            feeds.append(dict(id=key, status="unavailable"))
            print("BLS_OFFICIAL_SOURCE_UNAVAILABLE " + json.dumps(
                {"source": key, "reason": type(exc).__name__}, ensure_ascii=False))
    if not results:
        raise RuntimeError("all_BLS_official_feeds_unavailable")
    return dict(schema="lumex_bls_official_atom_oidc_v1",run_id=os.environ["GITHUB_RUN_ID"],
                checked_ms=now_ms,feeds=feeds,items=results)


def main():
    now_ms = int(time.time()*1000)
    payload = collect(now_ms)
    token = github_oidc()
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(raw) > 35000:
        raise ValueError("payload_oversized")
    result = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(INGEST, raw, method="POST", headers={
                "Authorization": "Bearer "+token, "Content-Type": "application/json",
                "Accept": "application/json", "User-Agent": "LUMEX-Official-BLS-OIDC/1.0"})
            with urllib.request.urlopen(req,timeout=20) as response:
                result = json.load(response)
            if result.get("ok") is not True:
                raise ValueError("not_acknowledged")
            break
        except urllib.error.HTTPError as exc:
            # Report only a server-defined error CODE. Never log OIDC JWT or request payload.
            reason = "edge_or_unclassified"
            try:
                body = json.loads(exc.read(2048))
                name = str(body.get("error", ""))
                if re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", name):
                    reason = name
            except (ValueError, TypeError):
                pass
            if exc.code in (400, 401, 403, 413):
                raise RuntimeError("BLS_OIDC_PERMANENT_REJECT_"+str(exc.code)+"_"+reason) from None
            if attempt==2:
                raise RuntimeError("BLS_OIDC_DELIVERY_HTTP_"+str(exc.code)) from None
        except Exception as exc:
            if attempt == 2:
                raise RuntimeError("BLS_OIDC_DELIVERY_UNAVAILABLE") from exc
        time.sleep(4 * (attempt+1))
    if result is None or result.get("ok") is not True:
        raise RuntimeError("BLS_OIDC_DELIVERY_UNCONFIRMED")
    print("LUMEX_BLS_OFFICIAL_OIDC_PROOF " + json.dumps({
        "ok": True, "run_id": payload["run_id"], "sources": payload["feeds"],
        "sent": len(payload["items"]), "worker_verified": result.get("received"),
        "no_orders": True}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("LUMEX_BLS_OFFICIAL_ERROR " + re.sub("[^a-zA-Z0-9_-]", "_", str(exc))[:90],
              file=sys.stderr)
        raise SystemExit(1)
