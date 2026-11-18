# LUMEX Phase 10 — Cloudflare Container image 404 repair

Date: 2026-11-19. Follows Phase 9 Cloudflare-only public Binance collector. No new VPS, WordPress plugin, theme or exchange credentials.

## Incident evidence (production logs supplied by site operator)
Two 5-minute scheduled Worker runs reported:
`binance_container_proof_unavailable container_binance-egress-probe_404_unknown_error`.
The HTTP 404 originates from the Worker → ResearchContainer internal /binance-egress-probe request. It is **not** proof of Binance upstream 403, Cloudflare authentication failure, or a market value of zero.

## Root cause verified from source AND deployment build log
- The production Dockerfile copied `engine/` and `server.py`, but did NOT copy `cloudflare_binance_capture.py`, even though Phase 9 `server.py` imported this file at startup.
- The previous GitHub deployment really built and uploaded the Docker image without the module. It checked only the public Worker version 1.3.1, not the internal Container routes.
- `wrangler.jsonc` uses `scheduling_policy: durable_object`. Under this policy, uploading a different image **does not roll over running Container instances** automatically: the Durable Object must stop the old instance before `start({image: container.images.base})` uses the new image. Thus an older process can continue replying HTTP 404 while the new image cannot boot due to the missing module.
- Corollary: a successful Worker deploy is insufficient evidence that its Container program was updated.

## Phase 10 corrections
1. `production/Dockerfile` copies `cloudflare_binance_capture.py` into `/app` and executes a build-time Python import/route contract test so a broken image fails the **deployment job**.
2. `production/server.py` adds a private `/health` `binance_image_contract` marker and declares the two supported internal Binance routes; no customer data.
3. `ResearchContainer.fetch` in `production/src/index.js` uses `container.inspect().image` vs `container.images.base` on a **Binance diagnostic/capture request only**. When old and new images differ, it destroys the old instance once, then starts the current image. Unrelated research requests never initiate image changes. Existing R2/DO persisted state is left intact. Restarting an old container can interrupt any in-flight research task on that container; failed tasks must follow their existing retry policy.
4. Before a Binance route is forwarded, `/health` must return exactly `lumex_binance_capture_20261119_v2`; otherwise fail closed with explicit `container_image_contract_mismatch` (503) instead of an ambiguous 404.
5. Adds public read-only `/market-hub/v1/binance-container-image-health`, which surfaces ONLY running/matching booleans. Image digest/credentials remain internal.
6. `probeBinanceContainerEgress` differentiates outdated/missing container endpoints, image start timeout, and Binance upstream denials. Access denial still prevents source capture.
7. New Python packaging contract and Node simulated Durable Object image rotation tests are required by offline CI; production deploy has an additional packaging gate and post-deploy image health report.

## Deployment (manual-only; never delete Cron)
- Merge tested PR to `main`.
- Re-run existing GitHub Actions workflow **LUMEX Worker production deploy (manual only)**, `main` with `DEPLOY_LUMEX_131`.
- Dockerfile import validation must pass; after deploy, Worker status and image status are logged.
- The next eligible Binance 5-minute Container probe will compare the current image and the newer digest, rotating only if it detects an outdated running instance.
- Read `/market-hub/v1/binance-container-image-health` for image status. If `container_running=false`, no image is currently booted; this alone is not an error.
- Read `/market-hub/v1/binance-egress-health` for official upstream HTTP 101/403/unavailable. **HTTP 101 is a capability check, not live capture proof**.
- Read `/market-hub/v1/binance-cloudflare-health` for confirmed real frame ingestion, R2 readback and reported gaps. Before verified observation, retain existing Bybit/Gate and GitHub sampled public Binance data. Never invent missing events.

## Rollback / operational limitations
- To stop new Binance Cloudflare collection, set `AUTO_BINANCE_CLOUDFLARE_CAPTURE=false`. This does not turn off the low-frequency connectivity probe; that can independently use `AUTO_BINANCE_CONTAINER_EGRESS_PROBE=false`.
- Cloudflare `durable_object` image rotation may interrupt an in-progress computation once; WordPress cPanel Cron, Cloudflare R2 records, customer accounts and external services are untouched.
- A module/image fix does not bypass or resolve Binance 403/451 network policy. No external VPS is added. Full 24/7 uptime is not verified by code or offline tests.
- Worker 1.3.1 remains the existing public API version: the new image marker, not Worker version alone, validates the Container.
- No auto order execution, account credentials, WordPress theme/plugin changes or DB migrations.

## Validation
Integration test `production/tests/test_binance_container_image_rollover_20261119.mjs` simulates stale image, targeted rotation, image contract fail-closed, harmless read-only query, and unrelated fetch.
Packaging regression `production/tests/test_container_image_packaging_20261119.py` verifies Dockerfile and actual source coupling. Production Docker build `RUN python -c ...` prevents a missing imported module from shipping again. Production live HTTP and Binance handshake outcomes require post-deploy evidence.
