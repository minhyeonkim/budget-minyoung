# 테스트 (Firebase Emulator 전용 — 실제 서버에 접근하지 않음)

필요: Node.js, Java 11+, Google Chrome (`/Applications/Google Chrome.app`)

```
# 1) 저장소 루트에서 정적 서버 실행 (다른 터미널)
python3 -m http.server 5173 --bind 127.0.0.1

# 2) tests 폴더에서
npm install
npm test
```

- `rules.test.mjs`: Firestore 보안 규칙 — 승인 계정만 읽기/쓰기, 미승인·익명·비로그인 차단, 캘린더(events) 기존 규칙 유지
- `e2e.mjs`: 실제 `index.html`을 헤드리스 Chrome으로 열어 계산·월 이동·미저장 보호·저장 범위·충돌·자산·모바일 화면을 검증
