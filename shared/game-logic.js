/**
 * 윷놀이 (Yut Nori) — Shared Game Logic
 * Server & Client 양쪽에서 사용하는 핵심 게임 로직
 */

// ═══════════════════════════════════════════════════════
//  상수
// ═══════════════════════════════════════════════════════

const YUT_RESULTS = {
  BACKDO: { name: '빽도', steps: -1, extraTurn: false },
  DO:     { name: '도',   steps: 1,  extraTurn: false },
  GAE:    { name: '개',   steps: 2,  extraTurn: false },
  GEOL:   { name: '걸',   steps: 3,  extraTurn: false },
  YUT:    { name: '윷',   steps: 4,  extraTurn: true },
  MO:     { name: '모',   steps: 5,  extraTurn: true },
};

// 윷 4개 기반 확률 (총 16)
// 빽도 1/16, 도 3/16, 개 6/16, 걸 4/16, 윷 1/16, 모 1/16
const YUT_WEIGHTS = [
  { result: 'BACKDO', weight: 1 },
  { result: 'DO',     weight: 3 },
  { result: 'GAE',    weight: 6 },
  { result: 'GEOL',   weight: 4 },
  { result: 'YUT',    weight: 1 },
  { result: 'MO',     weight: 1 },
];
const TOTAL_WEIGHT = 16;

const PIECES_PER_PLAYER = 4;

// ═══════════════════════════════════════════════════════
//  윷판 정의
// ═══════════════════════════════════════════════════════
//
//   5 ── 6 ── 7 ── 8 ── 9 ── 10
//   │╲                       ╱│
//   4  20                 23  11
//   │    ╲               ╱    │
//   3     21           24     12
//   │       ╲         ╱       │
//   2        22(중앙)         13
//   │       ╱         ╲       │
//   1     27           25     14
//   │    ╱               ╲    │
//   0  28                 26  15
//    ╲                       ╱
//     19 ─ 18 ─ 17 ─ 16 ──
//
//  노드 0 = 출발/도착 (START / FINISH)
//  말은 판 바깥(-1)에서 출발하여 경로를 따라 이동,
//  경로 끝을 넘으면 완주(-2).

/** 경로 배열 — 인덱스 0이 첫 발 */
const ROUTES = {
  outer:      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
  shortcut5:  [1, 2, 3, 4, 5, 20, 21, 22, 27, 28],
  shortcut10: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 23, 24, 22, 27, 28],
};

/** 모서리 착지 시 지름길 전환 (외곽 경로에서만 적용) */
const SHORTCUT_CORNERS = { 5: 'shortcut5', 10: 'shortcut10' };

/** 렌더링용 노드 좌표 (0-100 퍼센트 기준) */
const NODE_COORDS = {
  0:  [0, 100],   1:  [0, 80],    2:  [0, 60],    3:  [0, 40],    4:  [0, 20],
  5:  [0, 0],     6:  [20, 0],    7:  [40, 0],    8:  [60, 0],    9:  [80, 0],
  10: [100, 0],   11: [100, 20],  12: [100, 40],  13: [100, 60],  14: [100, 80],
  15: [100, 100], 16: [80, 100],  17: [60, 100],  18: [40, 100],  19: [20, 100],
  20: [17, 17],   21: [33, 33],
  22: [50, 50],
  23: [83, 17],   24: [67, 33],
  25: [67, 67],   26: [83, 83],
  27: [33, 67],   28: [17, 83],
};

/** 보드 선분 (렌더링용) */
const BOARD_EDGES = [
  // 외곽
  [0,1],[1,2],[2,3],[3,4],[4,5],
  [5,6],[6,7],[7,8],[8,9],[9,10],
  [10,11],[11,12],[12,13],[13,14],[14,15],
  [15,16],[16,17],[17,18],[18,19],[19,0],
  // 대각선 5→중앙
  [5,20],[20,21],[21,22],
  // 대각선 10→중앙
  [10,23],[23,24],[24,22],
  // 중앙→0
  [22,27],[27,28],[28,0],
  // 15→중앙 (장식용, 게임 경로 아님)
  [15,26],[26,25],[25,22],
];

// ═══════════════════════════════════════════════════════
//  상태 생성
// ═══════════════════════════════════════════════════════

function createPiece(id, playerId) {
  return {
    id,
    playerId,
    position: -1,       // -1 대기, >=0 판 위, -2 완주
    route: 'outer',
    routeIndex: -1,
    finished: false,
    stackedWith: [],    // 업힌 말 ID 배열
  };
}

function createGameState(player1Id, player2Id) {
  const pieces = {};
  [player1Id, player2Id].forEach((pid, idx) => {
    for (let i = 0; i < PIECES_PER_PLAYER; i++) {
      const id = `p${idx}_${i}`;
      pieces[id] = createPiece(id, pid);
    }
  });
  return {
    players: [player1Id, player2Id],
    pieces,
    currentPlayer: 0,       // players 배열 인덱스
    phase: 'THROWING',      // THROWING | MOVING | GAME_OVER
    lastThrow: null,        // 'DO' | 'GAE' | ... 또는 null
    pendingThrows: [],      // 추가 턴 큐
    winner: null,
    turnCount: 0,
  };
}

// ═══════════════════════════════════════════════════════
//  윷 던지기
// ═══════════════════════════════════════════════════════

function throwYut() {
  let rand = Math.random() * TOTAL_WEIGHT;
  for (const { result, weight } of YUT_WEIGHTS) {
    rand -= weight;
    if (rand <= 0) return result;
  }
  return 'DO';
}

function applyThrow(state) {
  if (state.phase !== 'THROWING') return { error: 'Not in throwing phase' };

  const result = throwYut();
  const yutResult = YUT_RESULTS[result];

  state.lastThrow = result;
  state.phase = 'MOVING';

  if (yutResult.extraTurn) {
    state.pendingThrows.push('EXTRA');
  }

  return { result, yutResult };
}

// ═══════════════════════════════════════════════════════
//  이동 가능한 말 조회
// ═══════════════════════════════════════════════════════

function getMovablePieces(state) {
  if (state.phase !== 'MOVING' || !state.lastThrow) return [];

  const playerId = state.players[state.currentPlayer];
  const steps = YUT_RESULTS[state.lastThrow].steps;

  // 다른 말에 업혀 있는 말은 선택 불가
  const stackedUnder = new Set();
  for (const p of Object.values(state.pieces)) {
    p.stackedWith.forEach(id => stackedUnder.add(id));
  }

  const movable = [];
  for (const piece of Object.values(state.pieces)) {
    if (piece.playerId !== playerId) continue;
    if (piece.finished) continue;
    if (stackedUnder.has(piece.id)) continue;

    if (steps < 0) {
      // 빽도: 판 위에 있는 말만
      if (piece.position >= 0) movable.push(piece.id);
    } else {
      movable.push(piece.id);
    }
  }
  return movable;
}

// ═══════════════════════════════════════════════════════
//  말 이동
// ═══════════════════════════════════════════════════════

function movePiece(state, pieceId) {
  if (state.phase !== 'MOVING') return { error: 'Not in moving phase' };

  const piece = state.pieces[pieceId];
  if (!piece) return { error: 'Invalid piece' };

  const playerId = state.players[state.currentPlayer];
  if (piece.playerId !== playerId) return { error: 'Not your piece' };
  if (piece.finished) return { error: 'Piece already finished' };

  const steps = YUT_RESULTS[state.lastThrow].steps;
  return steps < 0
    ? moveBackward(state, piece)
    : moveForward(state, piece, steps);
}

// ── 전진 ──

function moveForward(state, piece, steps) {
  const route = ROUTES[piece.route];

  // 판 바깥에서 진입
  if (piece.position === -1) {
    piece.routeIndex = steps - 1;
  } else {
    piece.routeIndex += steps;
  }

  // 완주 판정
  if (piece.routeIndex >= route.length) {
    finishPiece(piece);
    piece.stackedWith.forEach(id => finishPiece(state.pieces[id]));
    piece.stackedWith = [];
    return endMove(state, false);
  }

  piece.position = route[piece.routeIndex];

  // 지름길 전환 (외곽 경로 → 모서리 착지 시)
  if (piece.route === 'outer' && SHORTCUT_CORNERS[piece.position]) {
    const newRoute = SHORTCUT_CORNERS[piece.position];
    piece.route = newRoute;
    piece.routeIndex = ROUTES[newRoute].indexOf(piece.position);
  }

  // 업힌 말도 함께 이동
  syncStacked(state, piece);

  // 잡기 & 업기 판정
  const captured = checkCapture(state, piece);
  checkStack(state, piece);

  return endMove(state, captured);
}

// ── 후진 (빽도) ──

function moveBackward(state, piece) {
  if (piece.position === -1) return { error: 'Cannot move backward off-board piece' };

  piece.routeIndex -= 1;

  if (piece.routeIndex < 0) {
    // 판 바깥으로 돌아감
    resetPiece(piece);
    piece.stackedWith.forEach(id => resetPiece(state.pieces[id]));
    piece.stackedWith = [];
    return endMove(state, false);
  }

  const route = ROUTES[piece.route];
  piece.position = route[piece.routeIndex];

  syncStacked(state, piece);

  const captured = checkCapture(state, piece);
  checkStack(state, piece);

  return endMove(state, captured);
}

// ── 이동 불가 시 건너뛰기 ──

function skipMove(state) {
  if (state.phase !== 'MOVING') return { error: 'Not in moving phase' };
  return endMove(state, false);
}

// ═══════════════════════════════════════════════════════
//  내부 헬퍼
// ═══════════════════════════════════════════════════════

function finishPiece(piece) {
  piece.position = -2;
  piece.finished = true;
  piece.routeIndex = -2;
  piece.stackedWith = [];
}

function resetPiece(piece) {
  piece.position = -1;
  piece.route = 'outer';
  piece.routeIndex = -1;
  piece.finished = false;
  piece.stackedWith = [];
}

function syncStacked(state, leader) {
  leader.stackedWith.forEach(id => {
    const p = state.pieces[id];
    p.position = leader.position;
    p.route = leader.route;
    p.routeIndex = leader.routeIndex;
  });
}

/** 상대 말 잡기 — 잡았으면 true */
function checkCapture(state, movingPiece) {
  let captured = false;
  for (const piece of Object.values(state.pieces)) {
    if (piece.playerId === movingPiece.playerId) continue;
    if (piece.position !== movingPiece.position) continue;
    if (piece.position < 0 || piece.finished) continue;

    // 잡기! 상대 말(+업힌 말) 전부 원위치
    resetPiece(piece);
    piece.stackedWith.forEach(id => resetPiece(state.pieces[id]));
    piece.stackedWith = [];
    captured = true;
  }
  return captured;
}

/** 아군 말 업기 */
function checkStack(state, movingPiece) {
  const toAbsorb = [];

  for (const piece of Object.values(state.pieces)) {
    if (piece.id === movingPiece.id) continue;
    if (movingPiece.stackedWith.includes(piece.id)) continue;
    if (piece.playerId !== movingPiece.playerId) continue;
    if (piece.position !== movingPiece.position) continue;
    if (piece.position < 0 || piece.finished) continue;

    toAbsorb.push(piece.id, ...piece.stackedWith);
    piece.stackedWith = [];
  }

  for (const id of toAbsorb) {
    if (!movingPiece.stackedWith.includes(id)) {
      movingPiece.stackedWith.push(id);
    }
    const p = state.pieces[id];
    p.route = movingPiece.route;
    p.routeIndex = movingPiece.routeIndex;
  }
}

/** 이동 후 턴 처리 */
function endMove(state, captured) {
  // 승리 판정
  const playerId = state.players[state.currentPlayer];
  const allFinished = Object.values(state.pieces)
    .filter(p => p.playerId === playerId)
    .every(p => p.finished);

  if (allFinished) {
    state.phase = 'GAME_OVER';
    state.winner = playerId;
    return { winner: playerId };
  }

  // 잡기 → 추가 턴
  if (captured) {
    state.pendingThrows.push('CAPTURE');
  }

  // 추가 턴 소비
  if (state.pendingThrows.length > 0) {
    state.pendingThrows.shift();
    state.phase = 'THROWING';
    state.lastThrow = null;
    return { extraTurn: true, currentPlayer: state.currentPlayer };
  }

  // 다음 플레이어
  state.currentPlayer = (state.currentPlayer + 1) % 2;
  state.phase = 'THROWING';
  state.lastThrow = null;
  state.turnCount++;
  return { nextPlayer: state.currentPlayer };
}

// ═══════════════════════════════════════════════════════
//  기권
// ═══════════════════════════════════════════════════════

function forfeit(state, playerId) {
  const winner = state.players.find(id => id !== playerId);
  state.phase = 'GAME_OVER';
  state.winner = winner;
  return { winner, reason: 'forfeit' };
}

// ═══════════════════════════════════════════════════════
//  Export (Node.js & Browser 겸용)
// ═══════════════════════════════════════════════════════

const GameLogic = {
  // 상수
  YUT_RESULTS,
  YUT_WEIGHTS,
  PIECES_PER_PLAYER,
  ROUTES,
  SHORTCUT_CORNERS,
  NODE_COORDS,
  BOARD_EDGES,
  // 함수
  createGameState,
  throwYut,
  applyThrow,
  getMovablePieces,
  movePiece,
  skipMove,
  forfeit,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = GameLogic;
} else if (typeof window !== 'undefined') {
  window.YutGame = GameLogic;
}
