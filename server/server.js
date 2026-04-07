/**
 * 윷놀이 서버 — Express + Socket.IO
 *
 * 흐름: THROWING(연속) → MOVING(결과 선택→말 이동, 반복) → 턴 교대
 */

require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const RoomManager = require('./room-manager');
const G = require('../shared/game-logic');
const auth = require('./auth');
const shop = require('./shop');
const avatarModule = require('./avatar');
const supabase = require('./supabase');

const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const roomManager = new RoomManager();

// 중복 세션 추적: userId → socketId
const activeConnections = new Map();

// 재접속 유예 기간
const RECONNECT_GRACE_MS = 10_000; // 10초
const pendingDisconnects = new Map(); // userId → { timeoutId, roomCode }

app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));

// ═══════════════════════════════════════════════════════
//  REST API — 인증
// ═══════════════════════════════════════════════════════

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: '로그인 시도가 너무 많습니다. 1분 후 다시 시도해주세요.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const signupLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  message: { error: '회원가입 시도가 너무 많습니다. 1분 후 다시 시도해주세요.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.post('/api/auth/signup', signupLimiter, async (req, res) => {
  const { nickname, password, passwordConfirm, ingameNickname } = req.body;
  if (!password || password !== passwordConfirm) {
    return res.json({ error: '비밀번호가 일치하지 않습니다.' });
  }
  const result = await auth.signup(nickname, password, ingameNickname);
  res.json(result);
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { nickname, password } = req.body;
  const result = await auth.login(nickname, password);
  res.json(result);
});

app.get('/api/auth/me', async (req, res) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.json({ error: '토큰이 없습니다.' });
  }
  const token = header.slice(7);
  const user = await auth.verifyToken(token);
  if (!user) return res.json({ error: '유효하지 않은 토큰입니다.' });
  res.json({ success: true, user });
});

app.post('/api/auth/logout', (req, res) => {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    auth.blacklistToken(header.slice(7));
  }
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════
//  REST API — 상점 / 인벤토리
// ═══════════════════════════════════════════════════════

async function requireAuth(req, res) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) { res.json({ error: '인증 필요' }); return null; }
  const user = await auth.verifyToken(header.slice(7));
  if (!user) { res.json({ error: '유효하지 않은 토큰' }); return null; }
  return user;
}

async function requireAdmin(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return null;
  if (!user.isAdmin) { res.status(403).json({ error: '관리자 권한이 필요합니다.' }); return null; }
  return user;
}

app.get('/api/shop', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const ownedItems = await shop.getInventory(user.id);
  res.json({ items: shop.SHOP_ITEMS, ownedItems, elixir: user.elixir, equippedAvatar: user.equippedAvatar });
});

app.post('/api/shop/buy', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const result = await shop.buyItem(user.id, req.body.itemId);
  res.json(result);
});

app.post('/api/inventory/equip', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const result = await shop.equipAvatar(user.id, req.body.avatarId ?? null);
  res.json(result);
});

app.post('/api/avatar/randomize', async (req, res) => {
  const user = await requireAuth(req, res); if (!user) return;
  const result = await avatarModule.randomizeAvatar(user.id);
  res.json(result);
});

// ═══════════════════════════════════════════════════════
//  REST API — 관리자
// ═══════════════════════════════════════════════════════

const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: '요청이 너무 많습니다.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.get('/api/admin/users', adminLimiter, async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  const { data, error } = await supabase
    .from('users')
    .select('id, nickname, ingame_nickname, elixir, elixir_spent')
    .order('nickname', { ascending: true });
  if (error) return res.json({ error: '유저 목록 조회 실패' });
  res.json({
    success: true,
    users: data.map(u => ({
      id: u.id,
      nickname: u.nickname,
      ingameNickname: u.ingame_nickname,
      elixir: u.elixir,
      elixirSpent: u.elixir_spent || 0,
    })),
  });
});

// ═══════════════════════════════════════════════════════
//  Socket.IO 인증 미들웨어
// ═══════════════════════════════════════════════════════

io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication required'));
  const user = await auth.verifyToken(token);
  if (!user) return next(new Error('Invalid token'));
  socket.user = user;
  socket.authToken = token;
  next();
});

const TURN_TIME = 15;

// ═══════════════════════════════════════════════════════
//  타이머
// ═══════════════════════════════════════════════════════

function startTimer(room) {
  clearTimer(room);
  room.timerEnd = Date.now() + TURN_TIME * 1000;
  io.to(room.code).emit('timer-sync', { endsAt: room.timerEnd, duration: TURN_TIME });
  room.timer = setTimeout(() => handleTimeout(room), TURN_TIME * 1000);
}

function clearTimer(room) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  room.timerEnd = null;
}

function handleTimeout(room) {
  const state = room.gameState;
  if (!state || state.phase === 'GAME_OVER') return;

  // MOVING 단계에서 빽도가 대기열에 있고 이동 가능한 말이 있으면 자동 실행
  if (state.phase === 'MOVING') {
    const backDoIdx = state.throwQueue.indexOf('BACKDO');
    if (backDoIdx !== -1) {
      const movable = G.getMovablePiecesForThrow(state, 'BACKDO');
      if (movable.length > 0) {
        autoPlayBackdo(room, backDoIdx, movable);
        return;
      }
    }
  }

  passTurn(room);
}

/** 타임아웃 시 빽도 자동 이동 */
function autoPlayBackdo(room, backDoIdx, movable) {
  const state = room.gameState;

  // 랜덤 말 선택
  const pieceId = movable[Math.floor(Math.random() * movable.length)];

  const selResult = G.selectThrow(state, backDoIdx);
  if (selResult.error) { passTurn(room); return; }

  const mr = G.movePiece(state, pieceId);
  if (mr.error) { passTurn(room); return; }

  io.to(room.code).emit('move-result', {
    pieceId, throwKey: 'BACKDO', ...mr,
    state: sanitizeState(state),
    auto: true,
  });

  if (mr.gameOver) { handleGameOver(room, 'complete'); return; }
  if (mr.ranked) {
    io.to(room.code).emit('player-ranked', {
      playerId: mr.ranked, rank: mr.rank, state: sanitizeState(state),
    });
  }

  // 남은 큐에 이동 가능한 말이 없으면 자동 스킵
  if (state.phase === 'MOVING' && state.throwQueue.length > 0 && !G.hasAnyMovable(state)) {
    const skip = G.skipAllThrows(state);
    io.to(room.code).emit('move-result', {
      skipped: true, noMovable: true, ...skip, state: sanitizeState(state),
    });
  }

  // 빽도로 잡기 성공 → 추가 기회 부여 (새 타이머)
  if (mr.captured && mr.extraThrow) {
    startTimer(room);
    return;
  }

  // 남은 MOVING 큐 있으면 강제 턴 패스
  if (state.phase === 'MOVING') {
    passTurn(room);
    return;
  }

  // 자연스럽게 다음 플레이어 턴으로 전환됨
  startTimer(room);
}

/** 시간 초과 — 현재 턴을 포기하고 상대 턴으로 넘긴다 */
function passTurn(room) {
  const state = room.gameState;
  state.throwQueue = [];
  state.activeThrow = null;
  const active = state.activePlayers;
  const curIdx = active.indexOf(state.currentPlayer);
  state.currentPlayer = active[(curIdx + 1) % active.length];
  state.phase = 'THROWING';
  state.turnCount++;
  io.to(room.code).emit('turn-passed', { state: sanitizeState(state) });
  startTimer(room);
}

// ═══════════════════════════════════════════════════════
//  유틸
// ═══════════════════════════════════════════════════════

function sanitizeState(state) {
  return {
    players: state.players,
    activePlayers: state.activePlayers,
    pieces: state.pieces,
    currentPlayer: state.currentPlayer,
    phase: state.phase,
    throwQueue: state.throwQueue,
    activeThrow: state.activeThrow,
    winner: state.winner,
    turnCount: state.turnCount,
    rankings: state.rankings,
    forfeitOrder: state.forfeitOrder,
  };
}

function roomInfo(room) {
  return {
    code: room.code,
    players: room.players.map(p => ({ id: p.id, nickname: p.nickname, equippedAvatar: p.equippedAvatar || null, characterAvatar: p.characterAvatar || null })),
    maxPlayers: room.maxPlayers,
    status: room.status,
  };
}

// ═══════════════════════════════════════════════════════
//  Socket.IO 이벤트
// ═══════════════════════════════════════════════════════

io.on('connection', (socket) => {
  const nickname = socket.user.nickname;
  const userId = socket.user.id;
  console.log(`[접속] ${socket.id} (${nickname})`);
  let currentRoomCode = null;

  // ── 중복 세션 제거: 같은 계정의 기존 소켓 강제 종료 ──
  const prevSocketId = activeConnections.get(userId);
  if (prevSocketId) {
    const prevSocket = io.sockets.sockets.get(prevSocketId);
    if (prevSocket) {
      prevSocket.emit('session-replaced', { message: '다른 곳에서 로그인되어 연결이 종료됩니다.' });
      prevSocket.disconnect(true);
    }
  }
  activeConnections.set(userId, socket.id);

  // ── 유예 기간 내 재접속 감지 ──
  const pending = pendingDisconnects.get(userId);
  if (pending) {
    clearTimeout(pending.timeoutId);
    pendingDisconnects.delete(userId);
    currentRoomCode = pending.roomCode;

    const room = currentRoomCode ? roomManager.getRoom(currentRoomCode) : null;
    if (room) {
      socket.join(currentRoomCode);
      socket.emit('session-resumed', {
        room: roomInfo(room),
        players: room.players.map(p => ({ id: p.id, nickname: p.nickname, equippedAvatar: p.equippedAvatar || null, characterAvatar: p.characterAvatar || null })),
        state: room.gameState ? sanitizeState(room.gameState) : null,
        timerEnd: room.timerEnd ?? null,
        readyPlayers: [...room.readyPlayers],
      });
      console.log(`[재접속] ${nickname} → 방 ${currentRoomCode}`);
    } else {
      currentRoomCode = null;
    }
  }

  socket.on('create-room', (_, ack) => {
    if (currentRoomCode) return emitError(socket, ack, '이미 방에 참가 중입니다.');
    const room = roomManager.createRoom(userId, nickname, socket.user.equippedAvatar, socket.user.characterAvatar);
    currentRoomCode = room.code;
    socket.join(room.code);
    const r = { room: roomInfo(room) };
    if (typeof ack === 'function') ack(r); else socket.emit('room-created', r);
    console.log(`[방 생성] ${room.code} by ${nickname}`);
  });

  socket.on('join-room', (code, ack) => {
    if (currentRoomCode) return emitError(socket, ack, '이미 방에 참가 중입니다.');
    const result = roomManager.joinRoom(String(code).toUpperCase(), userId, nickname, socket.user.equippedAvatar, socket.user.characterAvatar);
    if (result.error) return emitError(socket, ack, result.error);
    const room = result.room;
    currentRoomCode = room.code;
    socket.join(room.code);
    const r = { room: roomInfo(room) };
    if (typeof ack === 'function') ack(r); else socket.emit('room-joined', r);
    socket.to(room.code).emit('player-joined', { player: { id: userId, nickname, equippedAvatar: socket.user.equippedAvatar || null, characterAvatar: socket.user.characterAvatar || null } });
    io.to(room.code).emit('ready-update', { readyPlayers: [...room.readyPlayers] });
    console.log(`[방 참가] ${room.code} ← ${nickname}`);
  });

  socket.on('room-list', (_, ack) => {
    const list = roomManager.getPublicList();
    if (typeof ack === 'function') ack(list); else socket.emit('room-list', list);
  });

  // ── 준비 토글 ──
  socket.on('toggle-ready', () => {
    const room = roomManager.getRoom(currentRoomCode);
    if (!room || room.status !== 'waiting') return;
    if (room.players[0].id === userId) return; // 방장은 ready 불필요
    if (room.readyPlayers.has(userId)) {
      room.readyPlayers.delete(userId);
    } else {
      room.readyPlayers.add(userId);
    }
    io.to(room.code).emit('ready-update', { readyPlayers: [...room.readyPlayers] });
  });

  // ── 게임 시작 ──
  socket.on('start-game', (_, ack) => {
    const room = roomManager.getRoom(currentRoomCode);
    if (!room) return emitError(socket, ack, '방을 찾을 수 없습니다.');
    if (room.players[0].id !== userId) return emitError(socket, ack, '방장만 시작할 수 있습니다.');
    if (room.players.length < 2) return emitError(socket, ack, '상대방이 필요합니다.');
    const nonHost = room.players.slice(1);
    if (!nonHost.every(p => room.readyPlayers.has(p.id)))
      return emitError(socket, ack, '모든 플레이어가 준비해야 합니다.');
    room.readyPlayers.clear();
    room.status = 'playing';
    room.gameState = G.createGameState(room.players.map(p => p.id));
    room.playerNicknameMap = new Map(room.players.map(p => [p.id, p.nickname]));
    io.to(room.code).emit('game-started', {
      players: room.players.map(p => ({ id: p.id, nickname: p.nickname, equippedAvatar: p.equippedAvatar || null, characterAvatar: p.characterAvatar || null })),
      state: sanitizeState(room.gameState),
    });
    startTimer(room);
    console.log(`[게임 시작] ${room.code}`);
  });

  // ── 윷 던지기 ──
  socket.on('throw-yut', (_, ack) => {
    const room = roomManager.getRoom(currentRoomCode);
    if (!room || !room.gameState) return emitError(socket, ack, '게임이 진행 중이 아닙니다.');
    const state = room.gameState;
    if (state.players[state.currentPlayer] !== userId) return emitError(socket, ack, '당신의 차례가 아닙니다.');
    if (state.phase !== 'THROWING') return emitError(socket, ack, '던지기 단계가 아닙니다.');

    const tr = G.applyThrow(state);
    if (tr.error) return emitError(socket, ack, tr.error);

    io.to(room.code).emit('throw-result', {
      result: tr.result, yutResult: tr.yutResult,
      continueThrow: tr.continueThrow,
      throwQueue: state.throwQueue.slice(),
      state: sanitizeState(state),
    });

    // MOVING인데 이동 가능한 말이 없으면 자동 스킵
    if (state.phase === 'MOVING' && !G.hasAnyMovable(state)) {
      const skip = G.skipAllThrows(state);
      io.to(room.code).emit('move-result', {
        skipped: true, noMovable: true, ...skip, state: sanitizeState(state),
      });
    }

    startTimer(room);
  });

  // ── 결과 선택 + 말 이동 (한 번에) ──
  socket.on('select-and-move', ({ throwIndex, pieceId }, ack) => {
    const room = roomManager.getRoom(currentRoomCode);
    if (!room || !room.gameState) return emitError(socket, ack, '게임이 진행 중이 아닙니다.');
    const state = room.gameState;
    if (state.players[state.currentPlayer] !== userId) return emitError(socket, ack, '당신의 차례가 아닙니다.');
    if (state.phase !== 'MOVING') return emitError(socket, ack, '이동 단계가 아닙니다.');

    const selResult = G.selectThrow(state, throwIndex);
    if (selResult.error) return emitError(socket, ack, selResult.error);

    const throwKey = state.activeThrow;
    const mr = G.movePiece(state, pieceId);
    if (mr.error) {
      // 롤백: activeThrow 해제 (throwQueue에서 이미 제거 안 됨 — movePiece에서 제거)
      // movePiece가 에러면 throwQueue는 건드리지 않았으므로 activeThrow만 초기화
      state.activeThrow = null;
      return emitError(socket, ack, mr.error);
    }

    io.to(room.code).emit('move-result', {
      pieceId, throwKey, ...mr, state: sanitizeState(state),
    });

    if (mr.gameOver) { handleGameOver(room, 'complete'); return; }
    if (mr.ranked) {
      io.to(room.code).emit('player-ranked', {
        playerId: mr.ranked, rank: mr.rank, state: sanitizeState(state),
      });
    }

    // 남은 큐에 이동 가능한 말이 없으면 자동 스킵
    if (state.phase === 'MOVING' && state.throwQueue.length > 0 && !G.hasAnyMovable(state)) {
      const skip = G.skipAllThrows(state);
      io.to(room.code).emit('move-result', {
        skipped: true, noMovable: true, ...skip, state: sanitizeState(state),
      });
    }

    startTimer(room);
  });

  // ── 기권 ──
  socket.on('forfeit', () => {
    const room = roomManager.getRoom(currentRoomCode);
    if (!room || !room.gameState) return;
    const result = G.forfeit(room.gameState, userId);
    if (result.gameOver) {
      handleGameOver(room, 'forfeit');
    } else {
      io.to(room.code).emit('player-forfeited', { playerId: userId, state: sanitizeState(room.gameState) });
      startTimer(room);
    }
  });

  // ── 말 아바타 갱신 (P1-P8) ──
  socket.on('update-avatar', (avatarId) => {
    socket.user.equippedAvatar = avatarId || null;
    const room = currentRoomCode ? roomManager.getRoom(currentRoomCode) : null;
    if (room) {
      const p = room.players.find(p => p.id === userId);
      if (p) p.equippedAvatar = avatarId || null;
    }
  });

  // ── 캐릭터 아바타 갱신 (MapleStory 초상화) ──
  socket.on('update-char-avatar', (avatarUrl) => {
    socket.user.characterAvatar = avatarUrl || null;
    const room = currentRoomCode ? roomManager.getRoom(currentRoomCode) : null;
    if (room) {
      const p = room.players.find(p => p.id === userId);
      if (p) p.characterAvatar = avatarUrl || null;
    }
  });

  // ── 채팅 ──
  socket.on('chat-message', (message) => {
    if (!currentRoomCode) return;
    const text = String(message).trim().slice(0, 200);
    if (!text) return;
    io.to(currentRoomCode).emit('chat-message', { nickname, text, timestamp: Date.now() });
  });

  // ── 퇴장 ──
  socket.on('leave-room', () => handleLeave());
  socket.on('disconnect', () => {
    console.log(`[퇴장] ${socket.id}`);
    if (activeConnections.get(userId) === socket.id) {
      activeConnections.delete(userId);
    }

    if (currentRoomCode) {
      // 즉시 퇴장 대신 유예 타이머 설정
      const roomCode = currentRoomCode;
      const timeoutId = setTimeout(() => {
        pendingDisconnects.delete(userId);
        handleLeave();
      }, RECONNECT_GRACE_MS);
      pendingDisconnects.set(userId, { timeoutId, roomCode });
    }
  });

  function handleLeave() {
    if (!currentRoomCode) return;
    const room = roomManager.getRoom(currentRoomCode);
    const wasPlaying = !!(room && room.gameState && room.status === 'playing');
    let gameEnded = false;
    if (wasPlaying) {
      const result = G.forfeit(room.gameState, userId);
      if (result.gameOver) {
        handleGameOver(room, 'disconnect');
        gameEnded = true;
      } else {
        io.to(room.code).emit('player-forfeited', { playerId: userId, state: sanitizeState(room.gameState) });
        startTimer(room);
      }
    }
    if (room) {
      const lr = roomManager.leaveRoom(currentRoomCode, userId);
      // 대기실 퇴장 또는 게임 종료로 인한 퇴장 시 player-left 전송
      // 게임 진행 중 기권(player-forfeited)은 전송 안 함
      if (lr && !lr.disbanded && (!wasPlaying || gameEnded)) {
        socket.to(currentRoomCode).emit('player-left', { playerId: userId });
        socket.to(currentRoomCode).emit('ready-update', { readyPlayers: [...room.readyPlayers] });
      }
    }
    socket.leave(currentRoomCode);
    currentRoomCode = null;
  }
});

function handleGameOver(room, reason) {
  clearTimer(room);
  const rankings = buildFinalRankings(room.gameState, room.playerNicknameMap);
  // 게임 상태 초기화 — 대기실로 복귀
  room.gameState = null;
  room.status = 'waiting';
  room.readyPlayers.clear();
  io.to(room.code).emit('game-over', { rankings, reason, room: roomInfo(room) });
  console.log(`[게임 종료] ${room.code} (${reason}) — ${rankings.map(r => r.rank + '등:' + r.nickname).join(', ')}`);
}

function buildFinalRankings(state, nicknameMap) {
  const lookup = (id) => nicknameMap.get(id) ?? '?';
  const ranked = state.rankings.map((id, i) => ({ rank: i + 1, id, nickname: lookup(id) }));
  const forfeited = [...state.forfeitOrder].reverse()
    .map((id, i) => ({ rank: state.rankings.length + i + 1, id, nickname: lookup(id) }));
  return [...ranked, ...forfeited];
}

function emitError(socket, ack, message) {
  if (typeof ack === 'function') ack({ error: message });
  else socket.emit('error-message', { message });
}

setInterval(() => roomManager.cleanup(), 5 * 60 * 1000);

const PORT = process.env.PORT || 47984;
server.listen(PORT, () => console.log(`윷놀이 서버 시작: http://localhost:${PORT}`));
