# 릴리스 노트 — 2026-11-13

## 기존 코드 재사용
- 소스: `LUMEX_AI_WORKER_0519.zip` → `research/lumex_ai_worker.py`, `research/requirements.txt`.
- WordPress Core/Theme 소스는 이번 GitHub 배포 저장소에 포함하지 않음. GitHub는 Cloudflare 코드만 관리.

## 새로 추가
- `src/index.js`: Cloudflare에 즉시 업로드 가능한 안전한 GitHub 자동배포 시작점 (`/health`, 보호된 `/status`).
- `wrangler.jsonc`, `package.json`, `.gitignore`, 관리자 연결 점검 테스트.
- `production/`: R2·Queues·Containers와 연결하는 연구 전용 후속 단계 예제. 별도 리소스 생성·배포 검증 필요.

## 코드 안전성
- 바이비트 실제 주문, 취소, 청산 함수 없음.
- OpenAI 자동 결제나 대량 연구 호출은 기본 OFF.
- GitHub에 자격정보·API 키 저장하지 않음.
- LUMEX 사이트를 SSRF 방지용 고정 HTTPS 호스트로 제한.

## 테스트
- 로컬 `node`에서 `/health` 200, 보호된 `/status` 401, 주문 경로 404, WordPress 인증 정보 없음 503 검증.
- 이전 Python 연구 파일 문법 검사 완료.
- Cloudflare 계정·GitHub 실제 자동 배포와 실제 Bybit 90일 데이터는 미검증.
