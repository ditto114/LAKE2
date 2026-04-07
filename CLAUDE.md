# LAKE2 — 메이플 윷놀이 온라인 미니게임

## 프로젝트 구조

- `server/server.js` — Express + Socket.IO 서버 (인증 REST API 포함)
- `server/auth.js` — 회원가입/로그인/토큰 검증 (bcrypt + JWT)
- `server/supabase.js` — Supabase 클라이언트 초기화
- `server/room-manager.js` — 방/로비 관리
- `shared/game-logic.js` — 윷놀이 규칙 엔진 (서버+클라이언트 공유)
- `js/client.js` — 프론트엔드 게임 클라이언트
- `js/board.js` — 캔버스 윷판 렌더러
- `index.html` — 메인 HTML (auth/lobby/game 3개 화면)

## 실행

```bash
npm install
npm start        # http://localhost:47984
npm run dev      # --watch 모드
```

## 코딩 규칙

- 모든 UI 텍스트의 기본 폰트는 **굴림(Gulim) 9pt**로 통일한다.
  - CSS: `font-family: "Gulim","Dotum","Tahoma",sans-serif; font-size: 9pt;`
  - 새로운 UI 요소를 추가할 때 반드시 이 기본값을 따른다.
- 프론트엔드는 Vanilla JS (프레임워크 없음)
- 서버는 Node.js + Express + Socket.IO
- DB는 Supabase (PostgreSQL) — 서버에서만 Service Role Key로 접근
