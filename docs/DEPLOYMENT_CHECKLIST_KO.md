# GitHub → Cloudflare Workers 자동배포: 한국어 체크리스트

**화면 상태:** 사용자가 보여준 Cloudflare GitHub 연결 / Build 설정 화면에서 진행.

1. GitHub `lumex-ai-research` (Private) 저장소 생성
2. ZIP을 압축 해제하고 **프로젝트 파일과 폴더를 저장소 최상단에 업로드**. `README.md`, `package.json`, `wrangler.jsonc` 등이 GitHub 최상단에 보여야 함. `LUMEX_GITHUB_UPLOAD_READY.zip` 하나만 GitHub에 올리면 배포되지 않음.
3. Cloudflare 화면에서 GitHub 저장소 선택. 프로젝트 이름 `lumex-ai-research`.
4. **Production branch**: `main` / **Root directory**: `/`.
5. **Build command**: 비움(가능하면) / 입력 요구 시 `npm install --no-audit --no-fund`.
6. **Deploy command**: `npx wrangler deploy`.
7. Preview builds는 아직 필요하지 않으므로 OFF 권장(Containers가 포함될 때 특히 주의).
8. Deploy 클릭 후 **Deployments → Success** 확인.
9. 생성된 `.workers.dev/health`에 `research_enabled:false` 확인.
10. Worker Secrets 등록 후 `/status` 인증 점검. 인증 토큰을 웹브라우저 URL에 직접 적지 마세요.
11. GitHub README 한 글자 수정 후 Commit → Cloudflare Deployments 신규 배포 자동 생성되는지 확인.

**첫 단계에서는 R2, Queues, Containers, OpenAI 키가 필요하지 않습니다.** 먼저 자동배포 경로만 검증하세요.

**현재 상태의 명확한 한계:** 자동 연구/시세 수집/백테스트/AI 생성은 아직 꺼져 있습니다. 이 패키지의 Bootstrap 배포를 성공했다는 이유만으로 연구가 자동 실행됐다고 판단하지 마세요.
