/**
 * 윷놀이 클라이언트 — Socket.IO + UI + Sound
 */
(function () {
  const $ = (id) => document.getElementById(id);

  /* ── 상태 ── */
  let socket, myId, myNickname;
  let room = null;
  let players = [];
  let gameState = null;
  let movablePieces = [];
  let board;

  /* 타이머 */
  let timerEnd = null;
  let timerInterval = null;

  /* 사운드 */
  let audioCtx = null;
  function ensureAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }
  function playTone(freq, dur, vol) {
    try {
      ensureAudio();
      const osc = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      osc.frequency.value = freq;
      g.gain.value = vol || 0.12;
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
      osc.connect(g); g.connect(audioCtx.destination);
      osc.start(); osc.stop(audioCtx.currentTime + dur);
    } catch (e) { /* 사운드 오류 무시 */ }
  }
  const sfx = {
    throw: () => playTone(520, 0.12, 0.15),
    move:  () => playTone(660, 0.08, 0.10),
    capture: () => { playTone(330, 0.15, 0.2); setTimeout(() => playTone(220, 0.2, 0.15), 100); },
    extra: () => { playTone(784, 0.1, 0.12); setTimeout(() => playTone(988, 0.15, 0.12), 80); },
    win:   () => { [523,659,784,1047].forEach((f,i) => setTimeout(() => playTone(f, 0.25, 0.15), i*120)); },
    tick:  () => playTone(1000, 0.03, 0.08),
  };

  /* 방 목록 폴링 */
  let roomListTimer = null;

  /* ══════════════════════════════════════════
     초기화
     ══════════════════════════════════════════ */

  window.addEventListener('DOMContentLoaded', () => {
    socket = io();
    board = new BoardRenderer($('canvas'));
    setupSocket();
    setupUI();
    showScreen('lobby');

    window.addEventListener('resize', () => {
      if ($('screen-game').style.display !== 'none') {
        board.resize();
        board.draw(gameState, movablePieces);
      }
    });
  });

  /* ══════════════════════════════════════════
     화면 전환
     ══════════════════════════════════════════ */

  function showScreen(name) {
    $('screen-lobby').style.display = name === 'lobby' ? '' : 'none';
    $('screen-game').style.display = name === 'game' ? '' : 'none';

    if (name === 'game') {
      setTimeout(() => { board.resize(); board.draw(gameState, movablePieces); }, 50);
      stopRoomListPoll();
    }
    if (name === 'lobby') {
      socket.emit('room-list');
      startRoomListPoll();
    }
  }

  function startRoomListPoll() {
    stopRoomListPoll();
    roomListTimer = setInterval(() => socket.emit('room-list'), 5000);
  }
  function stopRoomListPoll() {
    if (roomListTimer) { clearInterval(roomListTimer); roomListTimer = null; }
  }

  /* ══════════════════════════════════════════
     Socket 이벤트
     ══════════════════════════════════════════ */

  function setupSocket() {
    socket.on('connect', () => { myId = socket.id; });

    /* 방 */
    socket.on('room-created', (d) => {
      room = d.room; showScreen('game'); updateWaiting();
      addSystemChat('방이 생성되었습니다. 코드: ' + room.code);
    });
    socket.on('room-joined', (d) => {
      room = d.room; showScreen('game'); updateWaiting();
      addSystemChat(room.code + ' 방에 참가했습니다.');
    });
    socket.on('player-joined', (d) => {
      room.guest = d.guest; updateWaiting();
      addSystemChat(d.guest.nickname + ' 님이 입장했습니다.');
    });
    socket.on('player-left', (d) => {
      room.guest = null;
      if (d.promoted) room.host = d.promoted;
      gameState = null; movablePieces = []; stopTimerDisplay();
      updateWaiting();
      addSystemChat('상대방이 퇴장했습니다.');
    });

    /* 게임 */
    socket.on('game-started', (d) => {
      players = d.players; gameState = d.state; movablePieces = [];
      $('chat-log').innerHTML = '';
      addSystemChat('게임 시작!');
      updateGame();
    });

    socket.on('throw-result', (d) => {
      gameState = d.state; movablePieces = d.movablePieces;
      showYutResult(d.result, d.yutResult);
      sfx.throw();
      if (d.yutResult.extraTurn) setTimeout(sfx.extra, 300);
      addSystemChat(currentNick() + ' → ' + d.yutResult.name
        + (d.yutResult.extraTurn ? ' (추가턴!)' : '')
        + (d.auto ? ' [자동]' : ''));
      updateGame();
    });

    socket.on('move-result', (d) => {
      gameState = d.state; movablePieces = [];
      if (d.skipped) {
        addSystemChat('이동할 말이 없어 건너뜁니다.');
      } else {
        sfx.move();
        if (d.extraTurn) { addSystemChat('추가턴!'); sfx.extra(); }
      }
      updateGame();
    });

    socket.on('game-over', (d) => {
      stopTimerDisplay();
      gameState = null; movablePieces = [];
      const reason = d.reason === 'forfeit' ? ' (기권)' : d.reason === 'disconnect' ? ' (연결 끊김)' : '';
      addSystemChat('게임 종료! 승자: ' + d.winnerNickname + reason);
      $('status-text').textContent = '승자: ' + d.winnerNickname + reason;
      $('timer-bar').style.width = '0%';
      $('yut-sticks').innerHTML = '';
      if (d.winner === myId) sfx.win(); else playTone(220, 0.4, 0.1);
      setActionArea('gameover');
    });

    /* 타이머 */
    socket.on('timer-sync', (d) => {
      timerEnd = d.endsAt;
      startTimerDisplay(d.duration);
    });

    /* 채팅 & 에러 */
    socket.on('chat-message', (d) => addChat(d.nickname, d.text));
    socket.on('room-list', (list) => renderRoomList(list));
    socket.on('error-message', (d) => addSystemChat('오류: ' + d.message));
  }

  /* ══════════════════════════════════════════
     타이머 표시
     ══════════════════════════════════════════ */

  function startTimerDisplay(duration) {
    stopTimerDisplay();
    const totalMs = duration * 1000;
    timerInterval = setInterval(() => {
      if (!timerEnd) return;
      const remain = Math.max(0, timerEnd - Date.now());
      const sec = Math.ceil(remain / 1000);
      const pct = (remain / totalMs) * 100;

      $('timer-text').textContent = sec + '초';
      $('timer-bar').style.width = pct + '%';

      if (sec <= 5 && sec > 0) {
        $('timer-text').classList.add('urgent');
        $('timer-bar').classList.add('urgent');
        sfx.tick();
      } else {
        $('timer-text').classList.remove('urgent');
        $('timer-bar').classList.remove('urgent');
      }

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
    /* 로비 */
    $('btn-create').onclick = () => {
      const nick = $('inp-nick').value.trim();
      if (!nick) return alert('닉네임을 입력하세요.');
      myNickname = nick;
      socket.emit('set-nickname', nick);
      setTimeout(() => socket.emit('create-room'), 80);
    };
    $('btn-join').onclick = () => {
      const nick = $('inp-nick').value.trim();
      const code = $('inp-code').value.trim().toUpperCase();
      if (!nick) return alert('닉네임을 입력하세요.');
      if (!code || code.length < 4) return alert('방 코드를 입력하세요.');
      myNickname = nick;
      socket.emit('set-nickname', nick);
      setTimeout(() => socket.emit('join-room', code), 80);
    };
    $('inp-nick').onkeydown = (e) => { if (e.key === 'Enter') $('btn-create').click(); };
    $('inp-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });
    $('inp-code').onkeydown = (e) => { if (e.key === 'Enter') $('btn-join').click(); };
    $('btn-refresh').onclick = () => socket.emit('room-list');

    /* 게임 */
    $('btn-start').onclick = () => socket.emit('start-game');
    $('btn-throw').onclick = () => { ensureAudio(); socket.emit('throw-yut'); };
    $('btn-forfeit').onclick = () => { if (confirm('정말 기권하시겠습니까?')) socket.emit('forfeit'); };
    $('btn-leave').onclick = () => {
      socket.emit('leave-room');
      room = null; gameState = null; movablePieces = []; players = [];
      stopTimerDisplay();
      showScreen('lobby');
    };
    $('btn-again').onclick = () => socket.emit('play-again');

    /* 캔버스 클릭 */
    $('canvas').onclick = (e) => {
      if (!movablePieces.length || !isMyTurn()) return;
      ensureAudio();
      const rect = e.target.getBoundingClientRect();
      const scaleX = e.target.width / rect.width / (window.devicePixelRatio || 1);
      const scaleY = e.target.height / rect.height / (window.devicePixelRatio || 1);
      const x = (e.clientX - rect.left) * scaleX;
      const y = (e.clientY - rect.top) * scaleY;
      const pid = board.hitTest(x, y, gameState, movablePieces);
      if (pid) selectPiece(pid);
    };

    /* 채팅 */
    $('chat-input').onkeydown = (e) => {
      if (e.key === 'Enter') {
        const t = e.target.value.trim();
        if (t) { socket.emit('chat-message', t); e.target.value = ''; }
      }
    };
  }

  /* ══════════════════════════════════════════
     UI 업데이트
     ══════════════════════════════════════════ */

  function updateWaiting() {
    $('room-code-label').textContent = '방: ' + room.code;
    $('host-name').textContent = room.host.nickname;
    $('guest-name').textContent = room.guest ? room.guest.nickname : '대기 중...';
    $('host-pieces').textContent = '';
    $('guest-pieces').textContent = '';
    $('yut-result').textContent = '';
    $('yut-sticks').innerHTML = '';
    $('timer-bar').style.width = '0%';
    $('timer-text').textContent = '';

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
    const nick = currentNick();

    if (gameState.phase === 'THROWING') {
      $('status-text').textContent = my ? '윷을 던져주세요!' : nick + ' 님이 던지는 중...';
      setActionArea(my ? 'throw' : 'wait');
    } else if (gameState.phase === 'MOVING') {
      $('status-text').textContent = my ? '이동할 말을 선택하세요' : nick + ' 님이 이동 중...';
      setActionArea(my ? 'move' : 'wait');
    }

    // 턴 표시
    $('host-card').classList.toggle('active-turn', gameState.currentPlayer === 0);
    $('guest-card').classList.toggle('active-turn', gameState.currentPlayer === 1);

    updatePieceIndicators(0, 'host-pieces');
    updatePieceIndicators(1, 'guest-pieces');

    board.draw(gameState, movablePieces);
    renderOffBoardButtons();
  }

  function updatePieceIndicators(pidx, elemId) {
    if (!gameState) return;
    const pid = gameState.players[pidx];
    const pieces = Object.values(gameState.pieces).filter(p => p.playerId === pid);
    const icons = pieces.map(p => {
      if (p.finished) return '✓';
      if (p.position >= 0) return '◎';
      return '●';
    });
    $(elemId).textContent = '말: ' + icons.join(' ');
  }

  function setActionArea(mode) {
    $('btn-start').style.display = mode === 'start' ? '' : 'none';
    $('btn-throw').style.display = mode === 'throw' ? '' : 'none';
    $('btn-again').style.display = mode === 'gameover' ? '' : 'none';
    $('off-board-area').style.display = mode === 'move' ? '' : 'none';
    $('btn-forfeit').style.display = (gameState && gameState.phase !== 'GAME_OVER') ? '' : 'none';
  }

  /* ── 대기 말 출발 버튼 ── */
  function renderOffBoardButtons() {
    const area = $('off-board-area');
    area.innerHTML = '';
    if (!isMyTurn() || !movablePieces.length) return;

    const offBoard = movablePieces.filter(id => gameState.pieces[id]?.position === -1);
    if (offBoard.length > 0) {
      const btn = document.createElement('button');
      btn.className = 'game-btn primary';
      btn.textContent = '새 말 출발';
      btn.onclick = () => { ensureAudio(); selectPiece(offBoard[0]); };
      area.appendChild(btn);
    }
  }

  function selectPiece(pieceId) {
    socket.emit('move-piece', pieceId);
    movablePieces = [];
    renderOffBoardButtons();
  }

  /* ── 윷 결과 시각화 ── */

  const STICK_PATTERNS = {
    BACKDO: [1,0,0,0], DO: [1,0,0,0], GAE: [1,1,0,0],
    GEOL: [1,1,1,0], YUT: [0,0,0,0], MO: [1,1,1,1],
  };

  function showYutResult(resultKey, yr) {
    // 텍스트
    $('yut-result').textContent = yr.name;
    $('yut-result').className = 'yut-result yut-pop';
    setTimeout(() => $('yut-result').className = 'yut-result', 400);

    // 윷짝
    const pat = STICK_PATTERNS[resultKey] || [0,0,0,0];
    const sticks = $('yut-sticks');
    sticks.innerHTML = '';
    pat.forEach((flat, i) => {
      const s = document.createElement('div');
      s.className = 'stick ' + (flat ? 'flat' : 'round');
      s.style.animationDelay = (i * 60) + 'ms';
      sticks.appendChild(s);
    });
    // 빽도 표시
    if (resultKey === 'BACKDO') {
      sticks.children[0].classList.add('backdo');
    }
  }

  /* ══════════════════════════════════════════
     채팅
     ══════════════════════════════════════════ */

  function addChat(nick, text) {
    const log = $('chat-log');
    const p = document.createElement('p');
    p.textContent = nick + ' : ' + text;
    log.appendChild(p);
    log.scrollTop = log.scrollHeight;
  }
  function addSystemChat(text) {
    const log = $('chat-log');
    const p = document.createElement('p');
    p.style.color = '#f0d060';
    p.textContent = '▸ ' + text;
    log.appendChild(p);
    log.scrollTop = log.scrollHeight;
  }

  /* ══════════════════════════════════════════
     방 목록
     ══════════════════════════════════════════ */

  function renderRoomList(list) {
    const el = $('room-list');
    if (!list.length) {
      el.innerHTML = '<p class="room-empty">대기 중인 방이 없습니다</p>';
      return;
    }
    el.innerHTML = list.map(r =>
      `<div class="room-item" data-code="${r.code}">
        <span>${r.hostNickname}</span>
        <span class="room-code-tag">${r.code}</span>
        <span>${r.playerCount}/2</span>
      </div>`
    ).join('');
    el.querySelectorAll('.room-item').forEach(item => {
      item.onclick = () => { $('inp-code').value = item.dataset.code; };
    });
  }

  /* ══════════════════════════════════════════
     헬퍼
     ══════════════════════════════════════════ */

  function isMyTurn() {
    return gameState && gameState.players[gameState.currentPlayer] === myId;
  }
  function currentNick() {
    if (!gameState || !players.length) return '';
    return players[gameState.currentPlayer]?.nickname || '';
  }

})();
