/**
 * 윷놀이 클라이언트
 *
 * 이동 흐름:
 *   1. 이동 가능 말 하이라이트
 *   2. 말 클릭 → 도착지 표시 (⬇화살표)
 *   3. 도착지 클릭 → 이동 실행
 */
(function () {
  const $ = (id) => document.getElementById(id);

  let socket, myId, myNickname;
  let room = null;
  let players = [];
  let gameState = null;

  // 인증 상태
  let authToken = null;
  let currentUser = null;

  // 이동 UI 상태
  let allMovable = [];        // 이동 가능한 모든 말 ID
  let selectedPiece = null;   // 선택된 말 ID
  let destinations = [];      // 선택된 말의 도착지 목록

  let board;
  let timerEnd = null, timerInterval = null;
  let roomListTimer = null;
  let readySet = new Set();

  // 아바타 이미지 캐시
  const _avatarImgCache = {};
  function loadAvatarImg(avatarId) {
    if (!avatarId) return null;
    if (!_avatarImgCache[avatarId]) {
      const img = new Image();
      const num = avatarId.replace('avatar_', '');
      img.src = `/assets/P${num}.png`;
      img.onload = () => { if (gameState) updateGame(); };
      _avatarImgCache[avatarId] = img;
    }
    return _avatarImgCache[avatarId];
  }

  function buildAvatarMap(playerList) {
    const avatarMap = {}, dupSet = new Set(), cnt = {};
    playerList.forEach(p => { if (p.equippedAvatar) cnt[p.equippedAvatar] = (cnt[p.equippedAvatar] || 0) + 1; });
    playerList.forEach((p, i) => {
      if (p.equippedAvatar) {
        avatarMap[i] = loadAvatarImg(p.equippedAvatar);
        if (cnt[p.equippedAvatar] > 1) dupSet.add(i);
      }
    });
    return { avatarMap, dupSet };
  }

  // 상점 데이터 캐시
  let shopData = null;

  /* 사운드 */
  let audioCtx = null;
  function ensureAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }
  function playTone(freq, dur, vol) {
    try {
      ensureAudio();
      const osc = audioCtx.createOscillator(), g = audioCtx.createGain();
      osc.frequency.value = freq; g.gain.value = vol || 0.12;
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
      osc.connect(g); g.connect(audioCtx.destination);
      osc.start(); osc.stop(audioCtx.currentTime + dur);
    } catch (e) {}
  }
  const sfx = {
    throw: () => playTone(520, 0.12, 0.15),
    move:  () => playTone(660, 0.08, 0.10),
    capture: () => { playTone(330, 0.15, 0.2); setTimeout(() => playTone(220, 0.2, 0.15), 100); },
    extra: () => { playTone(784, 0.1, 0.12); setTimeout(() => playTone(988, 0.15, 0.12), 80); },
    win:   () => { [523,659,784,1047].forEach((f,i) => setTimeout(() => playTone(f, 0.25, 0.15), i*120)); },
    tick:  () => playTone(1000, 0.03, 0.08),
    noMove: () => { playTone(300, 0.15, 0.18); setTimeout(() => playTone(200, 0.25, 0.15), 120); },
  };

  /* ══════════════════════════════════════════ */

  window.addEventListener('DOMContentLoaded', async () => {
    board = new BoardRenderer($('canvas'));
    setupAuthUI();
    setupUI();

    // 저장된 토큰이 있으면 자동 로그인 시도
    const savedToken = localStorage.getItem('authToken');
    if (savedToken) {
      try {
        const res = await fetch('/api/auth/me', {
          headers: { 'Authorization': 'Bearer ' + savedToken },
        });
        const data = await res.json();
        if (data.success) {
          authToken = savedToken;
          currentUser = data.user;
          myNickname = currentUser.nickname;
          updateUserInfo();
          connectSocket();
          showScreen('lobby');
          return;
        }
      } catch (e) { /* 토큰 만료 또는 무효 */ }
      localStorage.removeItem('authToken');
    }

    showScreen('auth');
  });

  window.addEventListener('resize', () => {
    if ($('screen-game') && $('screen-game').style.display !== 'none') { board.resize(); redrawBoard(); }
  });

  function showScreen(name) {
    $('screen-auth').style.display = name === 'auth' ? '' : 'none';
    $('screen-lobby').style.display = name === 'lobby' ? '' : 'none';
    $('screen-game').style.display = name === 'game' ? '' : 'none';
    if (name === 'game') setTimeout(() => { board.resize(); redrawBoard(); }, 50);
    if (name === 'lobby') { if (socket) { socket.emit('room-list'); startRoomListPoll(); } } else stopRoomListPoll();
  }

  /* ══════════════════════════════════════════
     인증
     ══════════════════════════════════════════ */

  function connectSocket() {
    if (socket) socket.disconnect();
    socket = io({ auth: { token: authToken } });
    setupSocket();
  }

  function updateUserInfo() {
    if (!currentUser) return;
    const greet = $('greeting-name');
    if (greet) greet.textContent = currentUser.nickname;
    const elixirCount = $('lobby-elixir-count');
    if (elixirCount) elixirCount.textContent = currentUser.elixir;
  }

  async function doLogin(nickname, password) {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname, password }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    authToken = data.token;
    currentUser = data.user;
    myNickname = currentUser.nickname;
    localStorage.setItem('authToken', authToken);
    updateUserInfo();
    connectSocket();
    showScreen('lobby');
  }

  async function doSignup(nickname, password, passwordConfirm, ingameNickname) {
    const res = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname, password, passwordConfirm, ingameNickname }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    authToken = data.token;
    currentUser = data.user;
    myNickname = currentUser.nickname;
    localStorage.setItem('authToken', authToken);
    updateUserInfo();
    connectSocket();
    showScreen('lobby');
  }

  async function logout() {
    if (authToken) {
      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + authToken },
        });
      } catch (e) { /* best-effort */ }
    }
    authToken = null;
    currentUser = null;
    localStorage.removeItem('authToken');
    if (socket) socket.disconnect();
    room = null; gameState = null; allMovable = []; clearSelection(); players = [];
    stopTimerDisplay();
    showScreen('auth');
  }

  function setupAuthUI() {
    // 로그인/회원가입 전환
    $('btn-show-signup').onclick = () => {
      $('auth-login').style.display = 'none';
      $('auth-signup').style.display = '';
      $('login-error').textContent = '';
    };
    $('btn-show-login').onclick = () => {
      $('auth-signup').style.display = 'none';
      $('auth-login').style.display = '';
      $('signup-error').textContent = '';
    };

    // 로그인
    $('btn-login').onclick = async () => {
      $('login-error').textContent = '';
      try {
        await doLogin($('inp-login-nick').value.trim(), $('inp-login-pw').value);
      } catch (e) {
        $('login-error').textContent = e.message;
      }
    };
    $('inp-login-pw').onkeydown = (e) => { if (e.key === 'Enter') $('btn-login').click(); };
    $('inp-login-nick').onkeydown = (e) => { if (e.key === 'Enter') $('btn-login').click(); };

    // 회원가입
    $('btn-signup').onclick = async () => {
      $('signup-error').textContent = '';
      try {
        await doSignup(
          $('inp-signup-nick').value.trim(),
          $('inp-signup-pw').value,
          $('inp-signup-pw2').value,
          $('inp-signup-ingame').value.trim()
        );
      } catch (e) {
        $('signup-error').textContent = e.message;
      }
    };
    $('inp-signup-ingame').onkeydown = (e) => { if (e.key === 'Enter') $('btn-signup').click(); };

    // 로그아웃
    $('btn-logout').onclick = logout;
  }
  function startRoomListPoll() { stopRoomListPoll(); roomListTimer = setInterval(() => socket.emit('room-list'), 5000); }
  function stopRoomListPoll() { if (roomListTimer) { clearInterval(roomListTimer); roomListTimer = null; } }

  function redrawBoard() {
    board.draw(gameState, allMovable, selectedPiece, destinations);
  }

  function clearSelection() {
    selectedPiece = null;
    destinations = [];
  }

  function clearPieceGrids() {
    for (let i = 0; i < 4; i++) {
      const g = $('p' + i + '-pieces');
      if (g) g.innerHTML = '';
    }
  }

  /* ══════════════════════════════════════════
     Socket
     ══════════════════════════════════════════ */

  function setupSocket() {
    socket.on('connect', () => { myId = currentUser.id; });
    socket.on('connect_error', (err) => {
      if (err.message === 'Authentication required' || err.message === 'Invalid token') {
        logout();
      }
    });
    socket.on('session-replaced', (d) => {
      alert(d.message || '다른 곳에서 로그인되어 연결이 종료됩니다.');
      logout();
    });

    socket.on('session-resumed', (d) => {
      room = d.room;
      players = d.players || [];
      readySet = new Set(d.readyPlayers || []);

      if (d.room.status === 'playing' && d.state) {
        gameState = d.state;
        allMovable = gameState.phase === 'MOVING' && isMyTurn()
          ? YutGame.getAllMovablePieces(gameState) : [];
        clearSelection();
        const { avatarMap, dupSet } = buildAvatarMap(d.players || []);
        board.setPlayerAvatars(avatarMap, dupSet);
        // 플레이어 카드 이름 복원
        for (let i = 0; i < 4; i++) {
          const card = $('p' + i + '-card');
          if (!card) continue;
          card.style.display = '';
          const badge = $('p' + i + '-ready-badge');
          if (badge) badge.textContent = '';
          if (players[i]) {
            $('p' + i + '-name').textContent = players[i].nickname;
            card.classList.remove('empty-slot');
          } else {
            $('p' + i + '-name').textContent = '';
            card.classList.add('empty-slot');
          }
        }
        showScreen('game');
        updateGame();
        if (d.timerEnd) {
          timerEnd = d.timerEnd;
          const remaining = Math.ceil((d.timerEnd - Date.now()) / 1000);
          startTimerDisplay(Math.max(remaining, 1));
        }
        addSystemChat('게임에 재접속했습니다.');
      } else if (d.room.status === 'waiting') {
        gameState = null;
        allMovable = [];
        clearSelection();
        showScreen('game');
        updateWaiting();
        addSystemChat('대기실에 재접속했습니다.');
      } else {
        showScreen('lobby');
      }
    });

    socket.on('room-created', (d) => { room = d.room; showScreen('game'); updateWaiting(); addSystemChat('방이 생성되었습니다. 코드: ' + room.code); });
    socket.on('room-joined', (d) => { room = d.room; showScreen('game'); updateWaiting(); addSystemChat(room.code + ' 방에 참가했습니다.'); });
    socket.on('player-joined', (d) => {
      if (!room.players.find(p => p.id === d.player.id)) {
        room.players.push(d.player);
      }
      updateWaiting();
      addSystemChat(d.player.nickname + ' 님이 입장했습니다.');
    });

    socket.on('ready-update', (d) => {
      readySet = new Set(d.readyPlayers);
      if (room && room.status !== 'playing') updateWaiting();
    });
    socket.on('player-left', (d) => {
      room.players = room.players.filter(p => p.id !== d.playerId);
      if (gameState) return; // 게임 중: player-forfeited에서 이미 처리됨
      allMovable = []; clearSelection(); stopTimerDisplay();
      // ready 배지 초기화는 뒤따라오는 ready-update 이벤트에서 처리됨
      updateWaiting(); addSystemChat('플레이어가 퇴장했습니다.');
    });

    socket.on('player-forfeited', (d) => {
      gameState = d.state;
      clearSelection();
      const p = players.find(p => p.id === d.playerId);
      addSystemChat((p ? p.nickname : '플레이어') + ' 님이 기권했습니다.');
      allMovable = gameState.phase === 'MOVING' && isMyTurn()
        ? YutGame.getAllMovablePieces(gameState) : [];
      updateGame();
    });

    socket.on('game-started', (d) => {
      players = d.players;
      gameState = d.state;
      allMovable = []; clearSelection();
      readySet = new Set();
      const { avatarMap, dupSet } = buildAvatarMap(d.players);
      board.setPlayerAvatars(avatarMap, dupSet);
      // 말 그리드 초기화
      for (let i = 0; i < 4; i++) { const g = $('p' + i + '-pieces'); if (g) g.innerHTML = ''; }
      $('chat-log').innerHTML = '';
      // 항상 4개 카드 표시
      for (let i = 0; i < 4; i++) {
        const card = $('p' + i + '-card');
        if (!card) continue;
        card.style.display = '';
        card.classList.remove('is-ready');
        const badge = $('p' + i + '-ready-badge');
        if (badge) badge.textContent = '';
        if (players[i]) {
          $('p' + i + '-name').textContent = players[i].nickname;
          card.classList.remove('empty-slot');
        } else {
          $('p' + i + '-name').textContent = '';
          card.classList.add('empty-slot');
        }
      }
      addSystemChat('게임 시작!');
      updateGame();
    });

    socket.on('throw-result', (d) => {
      gameState = d.state;
      clearSelection();
      sfx.throw();
      showYutSticks(d.result, d.yutResult);
      addSystemChat(currentNick() + ' → ' + d.yutResult.name
        + (d.continueThrow ? ' (추가 던지기!)' : '')
        + (d.auto ? ' [자동]' : ''));
      if (d.continueThrow) sfx.extra();

      // MOVING 전환 시 이동 가능 말 계산
      if (!d.continueThrow && gameState.phase === 'MOVING') {
        allMovable = isMyTurn() ? YutGame.getAllMovablePieces(gameState) : [];
      } else {
        allMovable = [];
      }
      updateGame();
      autoSelectIfAllWaiting();
    });

    socket.on('move-result', (d) => {
      if (d.skipped) {
        // 스킵: 애니메이션 없이 즉시 처리
        gameState = d.state;
        clearSelection();
        if (d.noMovable) {
          sfx.noMove();
          addSystemChat('이동 가능한 말이 없습니다! 턴이 넘어갑니다.');
        } else {
          addSystemChat('이동 불가 — 건너뜁니다.');
        }
        allMovable = gameState.phase === 'MOVING' && isMyTurn()
          ? YutGame.getAllMovablePieces(gameState) : [];
        updateGame();
        autoSelectIfAllWaiting();
        return;
      }

      // 이동 애니메이션
      const oldPiece = gameState && d.pieceId ? gameState.pieces[d.pieceId] : null;
      if (oldPiece) {
        const nodePath  = getMovePath(oldPiece, d.throwKey);
        const playerIdx = gameState.players.indexOf(oldPiece.playerId);
        const col       = board.playerColor(playerIdx);
        const cnt       = (oldPiece.stackedWith ? oldPiece.stackedWith.length : 0) + 1;
        const animIds   = [d.pieceId, ...(oldPiece.stackedWith || [])];
        const animAvatarImg = board.playerAvatars[playerIdx] || null;
        const animIsDup = board.dupAvatarPlayers.has(playerIdx);

        // 출발 캔버스 좌표
        let fromCoord;
        if (oldPiece.position === -1) {
          fromCoord = board.positions[0];                      // 대기 말: 출발 노드에서 시작
        } else {
          fromCoord = board.positions[oldPiece.position] || board.positions[0];
        }

        // 상태 즉시 업데이트 (로직 기준), UI는 애니메이션 완료 후 갱신
        gameState = d.state;
        clearSelection();
        allMovable = [];
        sfx.move();
        if (d.auto) addSystemChat('⏰ 시간 초과 — 빽도 자동 이동!');
        if (d.captured) addSystemChat(d.extraThrow ? '잡기! 추가 던지기!' : '잡기!');

        board.startAnimation(animIds, fromCoord, nodePath, col, cnt, gameState, () => {
          if (d.captured) sfx.capture();
          allMovable = gameState.phase === 'MOVING' && isMyTurn()
            ? YutGame.getAllMovablePieces(gameState) : [];
          updateGame();
          autoSelectIfAllWaiting();
        }, animAvatarImg, animIsDup);
      } else {
        // pieceId 없는 경우 (예외)
        gameState = d.state;
        clearSelection();
        allMovable = gameState.phase === 'MOVING' && isMyTurn()
          ? YutGame.getAllMovablePieces(gameState) : [];
        updateGame();
        autoSelectIfAllWaiting();
      }
    });

    socket.on('player-ranked', (d) => {
      gameState = d.state;
      clearSelection();
      const p = players.find(p => p.id === d.playerId);
      addSystemChat(`${p ? p.nickname : '플레이어'}님이 ${d.rank}등으로 완주!`);
      allMovable = gameState.phase === 'MOVING' && isMyTurn()
        ? YutGame.getAllMovablePieces(gameState) : [];
      updateGame();
    });

    socket.on('game-over', (d) => {
      stopTimerDisplay(); gameState = null; allMovable = []; clearSelection();
      clearPieceGrids();
      const reasonText = d.reason === 'forfeit' ? ' (기권)' : d.reason === 'disconnect' ? ' (연결 끊김)' : '';
      const lines = d.rankings.map(r => `${r.rank}등: ${r.nickname}`).join('  ');
      addSystemChat('게임 종료!' + reasonText + '  ' + lines);
      $('timer-text').textContent = '--';
      $('yut-sticks').innerHTML = ''; $('throw-queue').innerHTML = '';
      const myRank = d.rankings.find(r => r.id === myId);
      if (myRank && myRank.rank === 1) sfx.win(); else playTone(220, 0.4, 0.1);
      // 대기실 인터페이스로 복귀
      if (d.room) room = d.room;
      readySet = new Set();
      updateWaiting();
    });

    socket.on('turn-passed', (d) => {
      gameState = d.state;
      clearSelection();
      allMovable = [];
      addSystemChat('⏰ 시간 초과! 턴이 넘어갑니다.');
      updateGame();
    });

    socket.on('timer-sync', (d) => { timerEnd = d.endsAt; startTimerDisplay(d.duration); });
    socket.on('chat-message', (d) => addChat(d.nickname, d.text));
    socket.on('room-list', (list) => renderRoomList(list));
    socket.on('error-message', (d) => addSystemChat('오류: ' + d.message));
  }

  /* ══════════════════════════════════════════
     타이머
     ══════════════════════════════════════════ */

  function startTimerDisplay(duration) {
    stopTimerDisplay();
    const totalMs = duration * 1000;
    timerInterval = setInterval(() => {
      if (!timerEnd) return;
      const remain = Math.max(0, timerEnd - Date.now());
      const sec = Math.ceil(remain / 1000);
      $('timer-text').textContent = String(sec).padStart(2, '0');
      const urgent = sec <= 5 && sec > 0;
      $('timer-text').classList.toggle('urgent', urgent);
      if (urgent) sfx.tick();
      if (remain <= 0) stopTimerDisplay();
    }, 250);
  }
  function stopTimerDisplay() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    $('timer-text').textContent = '--';
    $('timer-text').classList.remove('urgent');
  }

  /* ══════════════════════════════════════════
     UI 이벤트
     ══════════════════════════════════════════ */

  function setupUI() {
    $('btn-create').onclick = () => {
      socket.emit('create-room');
    };
    $('btn-join').onclick = () => {
      const code = $('inp-code').value.trim().toUpperCase();
      if (!code || code.length < 4) return alert('방 코드를 입력하세요.');
      socket.emit('join-room', code);
    };
    $('inp-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });
    $('inp-code').onkeydown = (e) => { if (e.key === 'Enter') $('btn-join').click(); };
    $('btn-refresh').onclick = () => socket.emit('room-list');

    $('btn-start').onclick = () => socket.emit('start-game');
    $('btn-ready').onclick = () => socket.emit('toggle-ready');
    $('btn-throw').onclick = () => { ensureAudio(); socket.emit('throw-yut'); };
    $('btn-forfeit').onclick = () => { if (confirm('정말 기권하시겠습니까?')) socket.emit('forfeit'); };
    $('btn-leave').onclick = () => {
      socket.emit('leave-room');
      room = null; gameState = null; allMovable = []; clearSelection(); players = [];
      stopTimerDisplay(); $('chat-log').innerHTML = ''; showScreen('lobby');
    };
    /* ── 캔버스 클릭 ── */
    $('canvas').onclick = (e) => {
      if (!isMyTurn() || !gameState || gameState.phase !== 'MOVING') return;
      ensureAudio();

      const rect = e.target.getBoundingClientRect();
      const sx = e.target.width / rect.width / (window.devicePixelRatio || 1);
      const sy = e.target.height / rect.height / (window.devicePixelRatio || 1);
      const cx = (e.clientX - rect.left) * sx;
      const cy = (e.clientY - rect.top) * sy;

      // 1) 도착지가 표시된 상태 → 도착지 클릭 확인
      if (selectedPiece && destinations.length > 0) {
        const dest = board.hitTestDestination(cx, cy, destinations);
        if (dest) {
          doMove(selectedPiece, dest.throwIndex);
          return;
        }
      }

      // 2) 말 클릭 확인
      const pid = board.hitTestPiece(cx, cy, gameState, allMovable);
      if (pid) {
        selectPiece(pid);
        return;
      }

    };

    /* 플레이어 카드 말 dot 클릭 → 대기 말 선택 */
    document.querySelectorAll('.pcard-piece-grid').forEach(grid => {
      grid.addEventListener('click', (e) => {
        if (!isMyTurn() || !gameState || gameState.phase !== 'MOVING') return;
        const dot = e.target.closest('.piece-dot');
        if (!dot || dot.classList.contains('gone')) return;
        const pieceId = dot.dataset.pieceId;
        if (pieceId && allMovable.includes(pieceId)) {
          ensureAudio();
          selectPiece(pieceId);
        }
      });
    });

    $('btn-inventory').onclick = openInventory;
    $('btn-shop').onclick = openShop;
    $('modal-inventory-close').onclick = () => { $('modal-inventory').style.display = 'none'; };
    $('modal-shop-close').onclick = () => { $('modal-shop').style.display = 'none'; };
    $('btn-unequip').onclick = () => equipAvatar(null);

    /* Space 키 → 윷 던지기 */
    window.addEventListener('keydown', (e) => {
      if (e.key !== ' ') return;
      if (document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
      const btn = $('btn-throw');
      if (btn && btn.style.display !== 'none') {
        e.preventDefault();
        btn.click();
      }
    });

    /* 채팅 */
    $('chat-input').onkeydown = (e) => {
      if (e.key === 'Enter') {
        const t = e.target.value.trim();
        if (t) { socket.emit('chat-message', t); e.target.value = ''; }
      }
    };
  }

  /* ══════════════════════════════════════════
     말 선택 → 도착지 표시
     ══════════════════════════════════════════ */

  /* ══════════════════════════════════════════
     말 이동 경로 계산 (애니메이션용)
     ══════════════════════════════════════════ */

  function getMovePath(piece, throwKey) {
    const steps = YutGame.YUT_RESULTS[throwKey].steps;
    const path = [];

    if (steps < 0) {
      // 빽도: 한 칸 후퇴 목적지만 포함
      if (piece.position === -1) return [];
      const ri = piece.routeIndex, rt = piece.route;
      if (rt === 'center' && ri === 0) {
        path.push(YutGame.ROUTES.shortcut5[YutGame.ROUTES.shortcut5.indexOf(22) - 1]);
      } else if (ri === 0) {
        path.push(0);
      } else if (ri === -1) {
        path.push(19);
      } else if (ri > 0) {
        path.push(YutGame.ROUTES[rt][ri - 1]);
      }
      return path;
    }

    // 출발지(노드 0)에 있는 말: 전진 시 즉시 골인 → 경로 없음
    if (piece.position === 0) return [];

    // 전진: 한 칸씩 시뮬레이션
    const isAtStart = false;
    let curRoute = piece.position === -1 ? 'outer' : piece.route;
    let curRI    = piece.position === -1 ? -1      : piece.routeIndex;

    // 대기 말은 노드 0(출발)부터 시각적으로 시작
    if (piece.position === -1) path.push(0);

    for (let i = 0; i < steps; i++) {
      curRI++;
      const route = YutGame.ROUTES[curRoute];
      if (curRI >= route.length) break;  // 완주
      const nodeId = route[curRI];
      path.push(nodeId);

      // 경로 전환은 최종 착지 노드에서만 적용 (moveForward와 동일)
      // 중간 경유 시 전환하면 잘못된 경로로 꺾임
      if (i === steps - 1) {
        if (curRoute === 'outer' && YutGame.SHORTCUT_CORNERS[nodeId]) {
          curRoute = YutGame.SHORTCUT_CORNERS[nodeId];
          curRI = YutGame.ROUTES[curRoute].indexOf(nodeId);
        }
        if (curRoute === 'shortcut5' && nodeId === 22) {
          curRoute = 'center';
          curRI = 0;
        }
      }
    }
    return path;
  }

  function selectPiece(pieceId) {
    selectedPiece = pieceId;
    destinations = YutGame.getDestinations(gameState, pieceId);
    redrawBoard();
    updateStatusText();
  }

  /** 이동 가능한 말이 모두 대기 중(판 위에 없음)이면 첫 번째 말을 자동 선택 */
  function autoSelectIfAllWaiting() {
    if (!isMyTurn() || gameState.phase !== 'MOVING' || allMovable.length === 0) return;
    const allWaiting = allMovable.every(id => gameState.pieces[id].position === -1);
    if (allWaiting) selectPiece(allMovable[0]);
  }

  function doMove(pieceId, throwIndex) {
    socket.emit('select-and-move', { throwIndex, pieceId });
    clearSelection();
    allMovable = [];
  }

  function updateStatusText() {
    if (!gameState || gameState.phase !== 'MOVING' || !isMyTurn()) return;
    if (selectedPiece) {
      $('status-text').textContent = destinations.length > 0
        ? '도착지를 선택하세요'
        : '이동할 수 없는 말입니다';
    } else {
      $('status-text').textContent = '이동할 말을 선택하세요';
    }
  }

  /* ══════════════════════════════════════════
     UI 업데이트
     ══════════════════════════════════════════ */

  function updateWaiting() {
    for (let i = 0; i < 4; i++) {
      const card = $('p' + i + '-card');
      if (card) card.classList.remove('active-turn');
    }
    const isHost = room.players[0]?.id === myId;
    const nonHostPlayers = room.players.slice(1);
    const allReady = nonHostPlayers.length > 0 && nonHostPlayers.every(p => readySet.has(p.id));
    const myReady = readySet.has(myId);

    // Player cards
    for (let i = 0; i < 4; i++) {
      const card    = $('p' + i + '-card');
      const nameEl  = $('p' + i + '-name');
      const piecesEl = $('p' + i + '-pieces');
      const badge   = $('p' + i + '-ready-badge');
      if (room.players[i]) {
        card.style.display = '';
        card.classList.remove('empty-slot');
        nameEl.textContent = room.players[i].nickname;
        if (i === 0) {
          card.classList.add('is-host');
          card.classList.remove('is-ready');
          if (badge) badge.textContent = '';
        } else {
          card.classList.remove('is-host');
          const ready = readySet.has(room.players[i].id);
          card.classList.toggle('is-ready', ready);
          if (badge) badge.textContent = ready ? 'READY' : '';
        }
      } else {
        // 빈 슬롯 — 항상 4개 카드 표시
        card.style.display = '';
        nameEl.textContent = '';
        piecesEl.textContent = '';
        card.classList.remove('is-ready', 'is-host');
        card.classList.add('empty-slot');
        if (badge) badge.textContent = '';
      }
    }

    clearPieceGrids();
    $('yut-result').textContent = '';
    $('yut-sticks').innerHTML = '';
    $('throw-queue').innerHTML = '';
    $('timer-text').textContent = '--';
    $('timer-text').textContent = '';

    if (isHost) {
      setActionArea('start');
      const hasGuest = room.players.length >= 2;
      const startEnabled = hasGuest && allReady;
      $('btn-start').disabled = !startEnabled;
      $('btn-start').querySelector('img').src = startEnabled ? '/assets/Game_START.png' : '/assets/Game_START_disabled.png';
      if (!hasGuest) {
        $('status-text').textContent = '상대를 기다리는 중...';
      } else if (allReady) {
        $('status-text').textContent = 'START를 눌러 시작하세요';
      } else {
        $('status-text').textContent = `준비 대기 중... (${nonHostPlayers.filter(p => readySet.has(p.id)).length}/${nonHostPlayers.length} 준비됨)`;
      }
    } else {
      setActionArea('ready');
      $('btn-ready').style.opacity = myReady ? '0.6' : '1';
      $('status-text').textContent = myReady ? '준비 완료! 방장을 기다리는 중...' : '준비 버튼을 눌러주세요';
    }

    board.draw(null, []);
  }

  function updateGame() {
    if (!gameState) return;
    const my = isMyTurn();


    if (gameState.phase === 'THROWING') {
      $('status-text').textContent = my ? '윷을 던져주세요!' : currentNick() + ' 님이 던지는 중...';
      setActionArea(my ? 'throw' : 'wait');
    } else if (gameState.phase === 'MOVING') {
      updateStatusText();
      if (!my) $('status-text').textContent = currentNick() + ' 님이 이동 중...';
      setActionArea(my ? 'move' : 'wait');
    }

    players.forEach((_, i) => {
      const card = $('p' + i + '-card');
      if (card) card.classList.toggle('active-turn', gameState.currentPlayer === i);
      updatePieceIndicators(i, 'p' + i + '-pieces');
    });
    renderThrowQueue();
    redrawBoard();
  }

  function updatePieceIndicators(pidx, elemId) {
    if (!gameState) return;
    const pid = gameState.players[pidx];
    const grid = $(elemId);
    if (!grid) return;

    const pieces = Object.values(gameState.pieces)
      .filter(p => p.playerId === pid)
      .sort((a, b) => a.id.localeCompare(b.id));

    // 점 초기 생성
    if (grid.children.length !== pieces.length) {
      grid.innerHTML = '';
      pieces.forEach(() => {
        const dot = document.createElement('div');
        dot.className = 'piece-dot';
        grid.appendChild(dot);
      });
    }

    const dots = grid.querySelectorAll('.piece-dot');
    const avatarImg = board.playerAvatars[pidx] || null;
    const isDup = board.dupAvatarPlayers.has(pidx);
    const col = board.playerColor(pidx);
    pieces.forEach((piece, i) => {
      if (!dots[i]) return;
      dots[i].dataset.pieceId = piece.id;
      const waiting = piece.position === -1;
      const isMovable = waiting && allMovable.includes(piece.id);
      dots[i].classList.toggle('gone', !waiting);
      dots[i].classList.toggle('movable-dot', isMovable);
      if (avatarImg && avatarImg.complete && avatarImg.naturalWidth > 0) {
        dots[i].style.backgroundImage = `url(${avatarImg.src})`;
        dots[i].style.backgroundSize = 'cover';
        dots[i].style.backgroundPosition = 'center';
        dots[i].style.borderRadius = isMovable ? '50%' : '0';
        dots[i].style.border = 'none';
        dots[i].style.filter = isDup ? `drop-shadow(0 0 1.3px ${col.f}) drop-shadow(0 0 1.3px ${col.f})` : '';
      } else {
        dots[i].style.backgroundImage = '';
        dots[i].style.backgroundSize = '';
        dots[i].style.backgroundPosition = '';
        dots[i].style.borderRadius = '';
        dots[i].style.border = '';
        dots[i].style.filter = '';
      }
    });
  }

  function setActionArea(mode) {
    const inGame = !!(gameState && gameState.phase !== 'GAME_OVER');
    $('btn-throw').style.display  = inGame ? '' : 'none';
    $('btn-throw').disabled       = mode !== 'throw';
    $('btn-start').style.display  = mode === 'start' ? '' : 'none';
    $('btn-ready').style.display  = mode === 'ready' ? '' : 'none';
    $('btn-forfeit').style.display = inGame ? '' : 'none';
  }

  /* ── 던진 결과 큐 (정보 표시용) ── */

  function renderThrowQueue() {
    const el = $('throw-queue');
    el.innerHTML = '';
    if (!gameState || !gameState.throwQueue || gameState.throwQueue.length === 0) return;
    gameState.throwQueue.forEach((key) => {
      const yr = YutGame.YUT_RESULTS[key];
      const span = document.createElement('span');
      span.className = 'throw-chip';
      span.textContent = yr.name;
      el.appendChild(span);
    });
  }

  /* ── 대기 말 출발 버튼 ── */

  /* ── 윷짝 시각화 ── */

  const STICK_PATTERNS = {
    BACKDO: [1,0,0,0], DO: [1,0,0,0], GAE: [1,1,0,0],
    GEOL: [1,1,1,0], YUT: [1,1,1,1], MO: [0,0,0,0],
  };

  function showYutSticks(resultKey, yr) {
    const pat = STICK_PATTERNS[resultKey] || [0,0,0,0];
    const sticks = $('yut-sticks');
    sticks.innerHTML = '';
    pat.forEach((flat, i) => {
      const s = document.createElement('div');
      s.className = 'stick ' + (flat ? 'flat' : 'round');
      s.style.animationDelay = (i * 60) + 'ms';
      sticks.appendChild(s);
    });
    if (resultKey === 'BACKDO') sticks.children[0].classList.add('backdo');
  }

  /* 채팅 */
  function addChat(nick, text) {
    const log = $('chat-log');
    const p = document.createElement('p'); p.textContent = nick + ' : ' + text;
    log.appendChild(p); log.scrollTop = log.scrollHeight;
  }
  function addSystemChat(text) {
    const log = $('chat-log');
    const p = document.createElement('p'); p.style.color = '#f0d060';
    p.textContent = text;
    log.appendChild(p); log.scrollTop = log.scrollHeight;
  }

  /* 방 목록 */
  function renderRoomList(list) {
    const el = $('room-list');
    if (!list.length) { el.innerHTML = '<p class="room-empty">대기 중인 방이 없습니다</p>'; return; }
    el.innerHTML = list.map(r =>
      `<div class="room-item" data-code="${r.code}"><span>${r.hostNickname}</span><span class="room-code-tag">${r.code}</span><span>${r.playerCount}/${r.maxPlayers}</span></div>`
    ).join('');
    el.querySelectorAll('.room-item').forEach(item => {
      item.onclick = () => { $('inp-code').value = item.dataset.code; };
    });
  }

  function isMyTurn() { return gameState && gameState.players[gameState.currentPlayer] === myId; }
  function currentNick() { return players[gameState?.currentPlayer]?.nickname || ''; }

  /* ══════════════════════════════════════════
     상점 / 인벤토리
     ══════════════════════════════════════════ */

  async function openShop() {
    const res = await fetch('/api/shop', { headers: { Authorization: 'Bearer ' + authToken } });
    shopData = await res.json();
    renderShopModal(shopData);
    $('modal-shop').style.display = '';
  }

  async function buyItem(itemId) {
    const res = await fetch('/api/shop/buy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + authToken },
      body: JSON.stringify({ itemId }),
    });
    const data = await res.json();
    if (data.error) { alert(data.error); return; }
    currentUser.elixir = data.elixir;
    shopData.ownedItems = data.ownedItems;
    shopData.elixir = data.elixir;
    updateUserInfo();
    renderShopModal(shopData);
  }

  async function openInventory() {
    const res = await fetch('/api/shop', { headers: { Authorization: 'Bearer ' + authToken } });
    shopData = await res.json();
    currentUser.equippedAvatar = shopData.equippedAvatar;
    renderInventoryModal(shopData);
    $('modal-inventory').style.display = '';
  }

  async function equipAvatar(avatarId) {
    const res = await fetch('/api/inventory/equip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + authToken },
      body: JSON.stringify({ avatarId: avatarId ?? null }),
    });
    const data = await res.json();
    if (data.error) { alert(data.error); return; }
    currentUser.equippedAvatar = data.equippedAvatar;
    if (socket) socket.emit('update-avatar', data.equippedAvatar);
    if (shopData) shopData.equippedAvatar = data.equippedAvatar;
    renderInventoryModal(shopData);
  }

  function renderShopModal(data) {
    const elixirEl = $('shop-elixir-display');
    if (elixirEl) elixirEl.textContent = '(엘릭서: ' + data.elixir + ')';
    const list = $('shop-list');
    list.innerHTML = '';
    data.items.forEach(item => {
      const owned = data.ownedItems.includes(item.id);
      const div = document.createElement('div');
      div.className = 'shop-item';
      const imgHtml = item.image ? `<img src="${item.image}" alt="${item.name}">` : `<div style="width:32px;height:32px;background:#dde;border:1px solid #aab;display:flex;align-items:center;justify-content:center;font-size:7pt">없음</div>`;
      const btnLabel = item.type === 'consumable' ? '구매' : (owned ? '보유 중' : '구매');
      const btnDisabled = (item.type === 'avatar' && owned) ? 'disabled' : '';
      div.innerHTML = `${imgHtml}<div class="shop-item-info"><div>${item.name}</div><div style="color:#666;font-size:8pt">${item.desc}</div></div><div class="shop-item-price">${item.price > 0 ? item.price + '엘' : '무료'}</div><button class="lobby-btn" style="height:22px;padding:0 6px" ${btnDisabled}>${btnLabel}</button>`;
      if (!btnDisabled) {
        div.querySelector('button').onclick = () => buyItem(item.id);
      }
      list.appendChild(div);
    });
  }

  function renderInventoryModal(data) {
    const grid = $('inventory-grid');
    grid.innerHTML = '';
    const avatarItems = data.items.filter(i => i.type === 'avatar');
    avatarItems.forEach(item => {
      const owned = data.ownedItems.includes(item.id);
      const equipped = data.equippedAvatar === item.id;
      const div = document.createElement('div');
      div.className = 'avatar-item' + (equipped ? ' equipped' : (owned ? ' owned' : ' locked'));
      div.innerHTML = `<img src="${item.image}" alt="${item.name}"><div style="font-size:7pt;margin-top:2px">${equipped ? '장착 중' : (owned ? '보유' : '미보유')}</div>`;
      if (owned) {
        div.onclick = () => equipAvatar(equipped ? null : item.id);
      }
      grid.appendChild(div);
    });
  }

})();
