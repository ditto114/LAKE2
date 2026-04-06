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

  // 이동 UI 상태
  let allMovable = [];        // 이동 가능한 모든 말 ID
  let selectedPiece = null;   // 선택된 말 ID
  let destinations = [];      // 선택된 말의 도착지 목록

  let board;
  let timerEnd = null, timerInterval = null;
  let roomListTimer = null;

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

  window.addEventListener('DOMContentLoaded', () => {
    socket = io();
    board = new BoardRenderer($('canvas'));
    setupSocket();
    setupUI();
    showScreen('lobby');
    window.addEventListener('resize', () => {
      if ($('screen-game').style.display !== 'none') { board.resize(); redrawBoard(); }
    });
  });

  function showScreen(name) {
    $('screen-lobby').style.display = name === 'lobby' ? '' : 'none';
    $('screen-game').style.display = name === 'game' ? '' : 'none';
    if (name === 'game') setTimeout(() => { board.resize(); redrawBoard(); }, 50);
    if (name === 'lobby') { socket.emit('room-list'); startRoomListPoll(); } else stopRoomListPoll();
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

  /* ══════════════════════════════════════════
     Socket
     ══════════════════════════════════════════ */

  function setupSocket() {
    socket.on('connect', () => { myId = socket.id; });

    socket.on('room-created', (d) => { room = d.room; showScreen('game'); updateWaiting(); addSystemChat('방이 생성되었습니다. 코드: ' + room.code); });
    socket.on('room-joined', (d) => { room = d.room; showScreen('game'); updateWaiting(); addSystemChat(room.code + ' 방에 참가했습니다.'); });
    socket.on('player-joined', (d) => { room.guest = d.guest; updateWaiting(); addSystemChat(d.guest.nickname + ' 님이 입장했습니다.'); });
    socket.on('player-left', (d) => {
      room.guest = null; if (d.promoted) room.host = d.promoted;
      gameState = null; allMovable = []; clearSelection(); stopTimerDisplay();
      updateWaiting(); addSystemChat('상대방이 퇴장했습니다.');
    });

    socket.on('game-started', (d) => {
      players = d.players; gameState = d.state;
      allMovable = []; clearSelection();
      $('chat-log').innerHTML = '';
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
    });

    socket.on('move-result', (d) => {
      gameState = d.state;
      clearSelection();
      if (d.skipped) {
        if (d.noMovable) {
          sfx.noMove();
          addSystemChat('이동 가능한 말이 없습니다! 턴이 넘어갑니다.');
        } else {
          addSystemChat('이동 불가 — 건너뜁니다.' + (d.auto ? ' [자동]' : ''));
        }
      } else {
        sfx.move();
        if (d.captured) { sfx.capture(); addSystemChat('잡기! 추가 던지기!'); }
        if (d.auto) addSystemChat('[자동 이동]');
      }
      // 다음 상태에 따라 이동 가능 말 갱신
      if (gameState.phase === 'MOVING' && isMyTurn()) {
        allMovable = YutGame.getAllMovablePieces(gameState);
      } else {
        allMovable = [];
      }
      updateGame();
    });

    socket.on('game-over', (d) => {
      stopTimerDisplay(); gameState = null; allMovable = []; clearSelection();
      const reason = d.reason === 'forfeit' ? ' (기권)' : d.reason === 'disconnect' ? ' (연결 끊김)' : '';
      addSystemChat('게임 종료! 승자: ' + d.winnerNickname + reason);
      $('status-text').textContent = '승자: ' + d.winnerNickname + reason;
      $('timer-bar').style.width = '0%';
      $('yut-sticks').innerHTML = ''; $('throw-queue').innerHTML = '';
      if (d.winner === myId) sfx.win(); else playTone(220, 0.4, 0.1);
      setActionArea('gameover');
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
      $('timer-text').textContent = sec + '초';
      $('timer-bar').style.width = (remain / totalMs * 100) + '%';
      const urgent = sec <= 5 && sec > 0;
      $('timer-text').classList.toggle('urgent', urgent);
      $('timer-bar').classList.toggle('urgent', urgent);
      if (urgent) sfx.tick();
      if (remain <= 0) stopTimerDisplay();
    }, 250);
  }
  function stopTimerDisplay() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    $('timer-text').textContent = '';
    $('timer-text').classList.remove('urgent');
    $('timer-bar').classList.remove('urgent');
  }

  /* ══════════════════════════════════════════
     UI 이벤트
     ══════════════════════════════════════════ */

  function setupUI() {
    $('btn-create').onclick = () => {
      const nick = $('inp-nick').value.trim();
      if (!nick) return alert('닉네임을 입력하세요.');
      myNickname = nick; socket.emit('set-nickname', nick);
      setTimeout(() => socket.emit('create-room'), 80);
    };
    $('btn-join').onclick = () => {
      const nick = $('inp-nick').value.trim();
      const code = $('inp-code').value.trim().toUpperCase();
      if (!nick) return alert('닉네임을 입력하세요.');
      if (!code || code.length < 4) return alert('방 코드를 입력하세요.');
      myNickname = nick; socket.emit('set-nickname', nick);
      setTimeout(() => socket.emit('join-room', code), 80);
    };
    $('inp-nick').onkeydown = (e) => { if (e.key === 'Enter') $('btn-create').click(); };
    $('inp-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });
    $('inp-code').onkeydown = (e) => { if (e.key === 'Enter') $('btn-join').click(); };
    $('btn-refresh').onclick = () => socket.emit('room-list');

    $('btn-start').onclick = () => socket.emit('start-game');
    $('btn-throw').onclick = () => { ensureAudio(); socket.emit('throw-yut'); };
    $('btn-forfeit').onclick = () => { if (confirm('정말 기권하시겠습니까?')) socket.emit('forfeit'); };
    $('btn-leave').onclick = () => {
      socket.emit('leave-room');
      room = null; gameState = null; allMovable = []; clearSelection(); players = [];
      stopTimerDisplay(); showScreen('lobby');
    };
    $('btn-again').onclick = () => socket.emit('play-again');

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

      // 3) 빈 곳 클릭 → 선택 해제
      clearSelection();
      redrawBoard();
      updateStatusText();
    };

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

  function selectPiece(pieceId) {
    selectedPiece = pieceId;
    destinations = YutGame.getDestinations(gameState, pieceId);
    redrawBoard();
    updateStatusText();
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
    $('room-code-label').textContent = '방: ' + room.code;
    $('host-name').textContent = room.host.nickname;
    $('guest-name').textContent = room.guest ? room.guest.nickname : '대기 중...';
    $('host-pieces').textContent = ''; $('guest-pieces').textContent = '';
    $('yut-result').textContent = ''; $('yut-sticks').innerHTML = '';
    $('throw-queue').innerHTML = '';
    $('timer-bar').style.width = '0%'; $('timer-text').textContent = '';
    const isHost = room.host.id === myId;
    $('status-text').textContent = room.guest
      ? (isHost ? 'START를 눌러 시작하세요' : '방장이 시작하길 기다리는 중...')
      : '상대를 기다리는 중...';
    setActionArea(room.guest && isHost ? 'start' : 'wait');
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

    $('host-card').classList.toggle('active-turn', gameState.currentPlayer === 0);
    $('guest-card').classList.toggle('active-turn', gameState.currentPlayer === 1);
    updatePieceIndicators(0, 'host-pieces');
    updatePieceIndicators(1, 'guest-pieces');
    renderThrowQueue();
    redrawBoard();
  }

  function updatePieceIndicators(pidx, elemId) {
    if (!gameState) return;
    const pid = gameState.players[pidx];
    const pieces = Object.values(gameState.pieces).filter(p => p.playerId === pid);
    $(elemId).textContent = '말: ' + pieces.map(p =>
      p.finished ? '✓' : p.position >= 0 ? '◎' : '●'
    ).join(' ');
  }

  function setActionArea(mode) {
    $('btn-start').style.display = mode === 'start' ? '' : 'none';
    $('btn-throw').style.display = mode === 'throw' ? '' : 'none';
    $('btn-again').style.display = mode === 'gameover' ? '' : 'none';
    $('btn-forfeit').style.display = (gameState && gameState.phase !== 'GAME_OVER') ? '' : 'none';
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
      span.textContent = yr.name + '(' + (yr.steps > 0 ? '+' : '') + yr.steps + ')';
      el.appendChild(span);
    });
  }

  /* ── 대기 말 출발 버튼 ── */

  /* ── 윷짝 시각화 ── */

  const STICK_PATTERNS = {
    BACKDO: [1,0,0,0], DO: [1,0,0,0], GAE: [1,1,0,0],
    GEOL: [1,1,1,0], YUT: [0,0,0,0], MO: [1,1,1,1],
  };

  function showYutSticks(resultKey, yr) {
    $('yut-result').textContent = yr.name;
    $('yut-result').className = 'yut-result yut-pop';
    setTimeout(() => $('yut-result').className = 'yut-result', 400);
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
    p.textContent = '▸ ' + text;
    log.appendChild(p); log.scrollTop = log.scrollHeight;
  }

  /* 방 목록 */
  function renderRoomList(list) {
    const el = $('room-list');
    if (!list.length) { el.innerHTML = '<p class="room-empty">대기 중인 방이 없습니다</p>'; return; }
    el.innerHTML = list.map(r =>
      `<div class="room-item" data-code="${r.code}"><span>${r.hostNickname}</span><span class="room-code-tag">${r.code}</span><span>${r.playerCount}/2</span></div>`
    ).join('');
    el.querySelectorAll('.room-item').forEach(item => {
      item.onclick = () => { $('inp-code').value = item.dataset.code; };
    });
  }

  function isMyTurn() { return gameState && gameState.players[gameState.currentPlayer] === myId; }
  function currentNick() { return players[gameState?.currentPlayer]?.nickname || ''; }

})();
