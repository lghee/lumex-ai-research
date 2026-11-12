# LUMEX AI RESEARCH — Cloudflare GitHub Auto Deploy

**Version:** github-cloudflare-1.0.0 · 2026-11-13

This repository can be imported **now** into Cloudflare Workers Builds from a private GitHub repository.

## Step 1: GitHub -> Cloudflare (immediately deployable)

1. Create a **Private** GitHub repository named `lumex-ai-research`.
2. **Extract** `LUMEX_GITHUB_UPLOAD_READY.zip` on your computer. Upload its **contents**, not the ZIP itself, to the repo root. Commit to `main`.
3. In Cloudflare **Workers & Pages → Create → Import a repository** select this repository.
4. Configure:
   - **Worker name** `lumex-ai-research`
   - **Branch** `main`
   - **Root directory** `/`
   - **Build command** blank (optional). If the UI requires one: `npm install --no-audit --no-fund`
   - **Deploy command** `npx wrangler deploy`
5. Save and deploy. For an existing Worker use **Settings → Build → Connect Git** instead of creating a duplicate Worker.
6. Open `https://lumex-ai-research.<your-workers-subdomain>.workers.dev/health`. The response should include `"deployed":true` and `"research_enabled":false`.

**This is the *safe deployment/connection stage*.** It intentionally has no queue, data writes, AI charges, exchange orders, or Python container. It proves GitHub automatic deployment and the LUMEX management API can be connected securely.

## Step 2: Connect WordPress for status (optional)

Cloudflare Worker → **Settings → Variables & Secrets**. Add Secrets:

- `LUMEX_ADMIN_API_TOKEN` – generate a new long random secret (minimum 32 characters), used **only** to authenticate administrator status requests to this Cloudflare Worker.
- `LUMEX_AI_LAB_WORKER_TOKEN` – LUMEX Core's research-only Bearer token from the site's server-side settings; DO NOT put this secret in GitHub.

Test from a trusted terminal:

```bash
curl -fsS -H 'Authorization: Bearer <LUMEX_ADMIN_API_TOKEN>' \
  'https://lumex-ai-research.<your-workers-subdomain>.workers.dev/status'
```

WordPress's research API must exist and be enabled. `401` means missing/invalid Cloudflare admin Bearer, `503` means research token is missing, and `502` means WordPress API unreachable or not ready. **No actual research jobs are run** in this stage.

## Step 3: Enable the optional full Containers stack (later)

`production/` contains an implementation of the next stage, but **it is NOT connected to the bootstrap Worker by default**. Do not set the Cloudflare project Root Directory to `production/` until your Cloudflare paid plan, R2/Queues and runtime secrets are configured and the code is tested on your account.

- Required resources: Workers Paid (Containers), R2 bucket `lumex-ai-data`, Queues `lumex-research-jobs` and `lumex-research-dead`.
- Secrets: `LUMEX_ADMIN_API_TOKEN`, `LUMEX_AI_LAB_WORKER_TOKEN`, `LUMEX_CONTAINER_KEY`, optional `OPENAI_API_KEY`.
- Research never executes orders; all execution controls default to OFF.
- Read [production/README_KO.md](production/README_KO.md) for details.

## Critical safety and correctness

- Do not put secrets in Git commits, `.env`, console screenshots, URLs, or public R2 buckets.
- Do not assume Bybit public Kline API is accessible from every Cloudflare region; earlier tests returned HTTP 403 from some regions.
- Past backtest wins are never live-trading approvals. Live order integration is not included.
- The included `research/lumex_ai_worker.py` is the existing VPS research logic for reference; production Cloudflare support requires Container deployment and market-data persistence via R2.

## QA

```bash
node tests/test-worker.mjs
python3 -m py_compile research/lumex_ai_worker.py
```

See `docs/DEPLOYMENT_CHECKLIST_KO.md` and `docs/RELEASE_NOTES_KO.md`.
