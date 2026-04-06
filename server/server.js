/**
 * 윷놀이 서버 — Express + Socket.IO
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const RoomManager = require('./room-manager');
const GameLogic = require('../shared/game-logic');

// ═══════════════════════════════════════════════════════
//  서버 초기화
// ═══════════════════════════════════════════════════════

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const roomManager = new RoomManager();

app.use(express.static(path.join(__dirname, '..')));

const TURN_TIME = 30; // 초

// ═══════════════════════════════════════════════════════
//  타이머 관리
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

  if (state.phase === 'THROWING') {
    // 자동 던지기
    const throwResult = GameLogic.applyThrow(state);
    const movable = GameLogic.getMovablePieces(state);

    io.to(room.code).emit('throw-result', {
      result: throwResult.result,
      yutResult: throwResult.yutResult,
      movablePieces: movable,
      state: sanitizeState(state),
      auto: true,
    });

    if (movable.length === 0) {
      const skipResult = GameLogic.skipMove(state);
      io.to(room.code).emit('move-result', {
        skipped: true, ...skipResult, state: sanitizeState(state),
      });
      startTimer(room);
    } else {
      // 이동 대기
      startTimer(room);
    }
  } else if (state.phase === 'MOVING') {
    // 자동 이동 (첫 번째 말)
    const movable = GameLogic.getMovablePieces(state);
    if (movable.length > 0) {
      const moveResult = GameLogic.movePiece(state, movable[0]);
      io.to(room.code).emit('move-result', {
        pieceId: movable[0], ...moveResult, state: sanitizeState(state), auto: true,
      });

      if (moveResult.winner) {
        handleGameOver(room, moveResult.winner, 'complete');
        return;
      }
    }
    startTimer(room);
  }
}

// ═══════════════════════════════════════════════════════
//  유틸
// ═══════════════════════════════════════════════════════

function sanitizeState(state) {
  return {
    players: state.players,
    pieces: state.pieces,
    currentPlayer: state.currentPlayer,
    phase: state.phase,
    lastThrow: state.lastThrow,
    winner: state.winner,
    turnCount: state.turnCount,
  };
}

function roomInfo(room) {
  return {
    code: room.code,
    host: { id: room.host.id, nickname: room.host.nickname },
    guest: room.guest ? { id: room.guest.id, nickname: room.guest.nickname } : null,
    status: room.status,
  };
}

// ═══════════════════════════════════════════════════════
//  Socket.IO 이벤트
// ═══════════════════════════════════════════════════════

io.on('connection', (socket) => {
  console.log(`[접속] ${socket.id}`);

  let nickname = null;
  let currentRoomCode = null;

  // ── 닉네임 ──
  socket.on('set-nickname', (name, ack) => {
    nickname = String(name).trim().slice(0, 12) || '익명';
    const resp = { nickname };
    if (typeof ack === 'function') ack(resp); else socket.emit('nickname-set', resp);
  });

  // ── 방 생성 ──
  socket.on('create-room', (_, ack) => {
    if (!nickname) return emitError(socket, ack, '닉네임을 먼저 설정하세요.');
    if (currentRoomCode) return emitError(socket, ack, '이미 방에 참가 중입니다.');
    const room = roomManager.createRoom(socket.id, nickname);
    currentRoomCode = room.code;
    socket.join(room.code);
    const resp = { room: roomInfo(room) };
    if (typeof ack === 'function') ack(resp); else socket.emit('room-created', resp);
    console.log(`[방 생성] ${room.code} by ${nickname}`);
  });

  // ── 방 참가 ──
  socket.on('join-room', (code, ack) => {
    if (!nickname) return emitError(socket, ack, '닉네임을 먼저 설정하세요.');
    if (currentRoomCode) return emitError(socket, ack, '이미 방에 참가 중입니다.');
    const result = roomManager.joinRoom(String(code).toUpperCase(), socket.id, nickname);
    if (result.error) return emitError(socket, ack, result.error);
    const room = result.room;
    currentRoomCode = room.code;
    socket.join(room.code);
    const resp = { room: roomInfo(room) };
    if (typeof ack === 'function') ack(resp); else socket.emit('room-joined', resp);
    socket.to(room.code).emit('player-joined', { guest: { id: socket.id, nickname } });
    console.log(`[방 참가] ${room.code} ← ${nickname}`);
  });

  // ── 방 목록 ──
  socket.on('room-list', (_, ack) => {
    const list = roomManager.getPublicList();
    if (typeof ack === 'function') ack(list); else socket.emit('room-list', list);
  });

  // ── 게임 시작 ──
  socket.on('start-game', (_, ack) => {
    const room = roomManager.getRoom(currentRoomCode);
    if (!room) return emitError(socket, ack, '방을 찾을 수 없습니다.');
    if (room.host.id !== socket.id) return emitError(socket, ack, '방장만 시작할 수 있습니다.');
    if (!room.guest) return emitError(socket, ack, '상대방이 필요합니다.');

    room.status = 'playing';
    room.gameState = GameLogic.createGameState(room.host.id, room.guest.id);

    io.to(room.code).emit('game-started', {
      players: [
        { id: room.host.id, nickname: room.host.nickname },
        { id: room.guest.id, nickname: room.guest.nickname },
      ],
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
    if (state.players[state.currentPlayer] !== socket.id) return emitError(socket, ack, '당신의 차례가 아닙니다.');

    const throwResult = GameLogic.applyThrow(state);
    if (throwResult.error) return emitError(socket, ack, throwResult.error);
    const movable = GameLogic.getMovablePieces(state);

    io.to(room.code).emit('throw-result', {
      result: throwResult.result,
      yutResult: throwResult.yutResult,
      movablePieces: movable,
      state: sanitizeState(state),
    });

    if (movable.length === 0) {
      const skipResult = GameLogic.skipMove(state);
      io.to(room.code).emit('move-result', {
        skipped: true, ...skipResult, state: sanitizeState(state),
      });
    }
    startTimer(room);
  });

  // ── 말 이동 ──
  socket.on('move-piece', (pieceId, ack) => {
    const room = roomManager.getRoom(currentRoomCode);
    if (!room || !room.gameState) return emitError(socket, ack, '게임이 진행 중이 아닙니다.');
    const state = room.gameState;
    if (state.players[state.currentPlayer] !== socket.id) return emitError(socket, ack, '당신의 차례가 아닙니다.');

    const moveResult = GameLogic.movePiece(state, pieceId);
    if (moveResult.error) return emitError(socket, ack, moveResult.error);

    io.to(room.code).emit('move-result', {
      pieceId, ...moveResult, state: sanitizeState(state),
    });

    if (moveResult.winner) {
      handleGameOver(room, moveResult.winner, 'complete');
      return;
    }
    startTimer(room);
  });

  // ── 기권 ──
  socket.on('forfeit', () => {
    const room = roomManager.getRoom(currentRoomCode);
    if (!room || !room.gameState) return;
    const result = GameLogic.forfeit(room.gameState, socket.id);
    handleGameOver(room, result.winner, 'forfeit');
  });

  // ── 채팅 ──
  socket.on('chat-message', (message) => {
    if (!currentRoomCode || !nickname) return;
    const text = String(message).trim().slice(0, 200);
    if (!text) return;
    io.to(currentRoomCode).emit('chat-message', { nickname, text, timestamp: Date.now() });
  });

  // ── 재시작 ──
  socket.on('play-again', () => {
    const room = roomManager.getRoom(currentRoomCode);
    if (!room) return;
    if (room.host.id !== socket.id) return emitError(socket, null, '방장만 재시작할 수 있습니다.');
    if (!room.guest) return emitError(socket, null, '상대방이 필요합니다.');

    room.status = 'playing';
    room.gameState = GameLogic.createGameState(room.host.id, room.guest.id);
    io.to(room.code).emit('game-started', {
      players: [
        { id: room.host.id, nickname: room.host.nickname },
        { id: room.guest.id, nickname: room.guest.nickname },
      ],
      state: sanitizeState(room.gameState),
    });
    startTimer(room);
  });

  // ── 퇴장 / 해제 ──
  socket.on('leave-room', () => handleLeave());
  socket.on('disconnect', () => { console.log(`[퇴장] ${socket.id}`); handleLeave(); });

  function handleLeave() {
    if (!currentRoomCode) return;
    const room = roomManager.getRoom(currentRoomCode);
    if (room && room.gameState && room.status === 'playing') {
      const result = GameLogic.forfeit(room.gameState, socket.id);
      handleGameOver(room, result.winner, 'disconnect');
    }
    if (room) {
      const lr = roomManager.leaveRoom(currentRoomCode, socket.id);
      if (lr && !lr.disbanded) {
        socket.to(currentRoomCode).emit('player-left', {
          promoted: lr.promoted ? { id: lr.promoted.id, nickname: lr.promoted.nickname } : null,
        });
      }
    }
    socket.leave(currentRoomCode);
    currentRoomCode = null;
  }

  function handleGameOver(room, winnerId, reason) {
    clearTimer(room);
    const winnerNickname = room.host.id === winnerId ? room.host.nickname : room.guest.nickname;
    io.to(room.code).emit('game-over', { winner: winnerId, winnerNickname, reason });
    room.status = 'finished';
    console.log(`[게임 종료] ${room.code} — ${winnerNickname} 승리 (${reason})`);
  }
});

function emitError(socket, ack, message) {
  if (typeof ack === 'function') ack({ error: message });
  else socket.emit('error-message', { message });
}

// ═══════════════════════════════════════════════════════
//  서버 시작
// ═══════════════════════════════════════════════════════

setInterval(() => roomManager.cleanup(), 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`윷놀이 서버 시작: http://localhost:${PORT}`);
});
