/**
 * 윷놀이 (Yut Nori) — Shared Game Logic
 * Server & Client 양쪽에서 사용하는 핵심 게임 로직
 *
 * ▸ 턴 흐름 (실제 윷놀이 규칙):
 *   THROWING → (윷/모면 계속 THROWING) → MOVING
 *   MOVING 중 결과 선택 → 말 이동 → 남은 결과 있으면 계속 MOVING
 *   잡기 발생 시 → 추가 던지기(THROWING)
 *   모든 결과 소비 → 턴 교대
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

const ROUTES = {
  outer:      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 0],
  shortcut5:  [1, 2, 3, 4, 5, 20, 21, 22, 25, 26, 15, 16, 17, 18, 19, 0],  // 직진: 5→중앙→15→외곽→출발
  shortcut10: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 23, 24, 22, 27, 28, 0],
  center:     [22, 27, 28, 0],  // 중앙 착지 → 출발점 방향
  // 노드 0(출발) = 경로 마지막. 딱 맞게 도착 시 0에 멈춤.
  // 0에서 1칸 이상 이동하면 routeIndex >= length → 완주.
};

const SHORTCUT_CORNERS = { 5: 'shortcut5', 10: 'shortcut10' };

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

const BOARD_EDGES = [
  [0,1],[1,2],[2,3],[3,4],[4,5],
  [5,6],[6,7],[7,8],[8,9],[9,10],
  [10,11],[11,12],[12,13],[13,14],[14,15],
  [15,16],[16,17],[17,18],[18,19],[19,0],
  [5,20],[20,21],[21,22],
  [10,23],[23,24],[24,22],
  [22,27],[27,28],[28,0],
  [15,26],[26,25],[25,22],
];

// ═══════════════════════════════════════════════════════
//  상태 생성
// ═══════════════════════════════════════════════════════

function createPiece(id, playerId) {
  return {
    id, playerId,
    position: -1,       // -1 대기, >=0 판 위, -2 완주
    route: 'outer',
    routeIndex: -1,
    finished: false,
    stackedWith: [],
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
    currentPlayer: 0,
    phase: 'THROWING',      // THROWING | MOVING | GAME_OVER
    throwQueue: [],          // 던진 결과 큐 (아직 이동에 사용 안 한 것들)
    activeThrow: null,       // 현재 이동에 선택된 결과 키
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

/**
 * 윷을 던진다.
 * 윷/모 → 다시 THROWING (연속 던지기)
 * 그 외 → MOVING (이동 단계로)
 */
function applyThrow(state) {
  if (state.phase !== 'THROWING') return { error: 'Not in throwing phase' };

  const result = throwYut();
  const yutResult = YUT_RESULTS[result];

  state.throwQueue.push(result);

  if (yutResult.extraTurn) {
    // 윷/모: 계속 던지기
    state.phase = 'THROWING';
  } else {
    // 일반 결과: 이동 단계로 전환
    state.phase = 'MOVING';
    state.activeThrow = null;
  }

  return { result, yutResult, continueThrow: yutResult.extraTurn };
}

// ═══════════════════════════════════════════════════════
//  이동할 결과 선택
// ═══════════════════════════════════════════════════════

/**
 * throwQueue에서 사용할 결과를 선택한다.
 * @param {number} index - throwQueue 인덱스
 */
function selectThrow(state, index) {
  if (state.phase !== 'MOVING') return { error: 'Not in moving phase' };
  if (index < 0 || index >= state.throwQueue.length) return { error: 'Invalid throw index' };

  state.activeThrow = state.throwQueue[index];
  return { activeThrow: state.activeThrow, steps: YUT_RESULTS[state.activeThrow].steps };
}

// ═══════════════════════════════════════════════════════
//  이동 가능한 말 조회
// ═══════════════════════════════════════════════════════

/**
 * 특정 결과에 대해 이동 가능한 말 목록
 */
function getMovablePiecesForThrow(state, throwKey) {
  const playerId = state.players[state.currentPlayer];
  const steps = YUT_RESULTS[throwKey].steps;

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
      if (piece.position >= 0) movable.push(piece.id);
    } else {
      movable.push(piece.id);
    }
  }
  return movable;
}

/**
 * 현재 activeThrow에 대한 이동 가능한 말
 */
function getMovablePieces(state) {
  if (state.phase !== 'MOVING' || !state.activeThrow) return [];
  return getMovablePiecesForThrow(state, state.activeThrow);
}

/**
 * throwQueue 중 이동 가능한 결과가 하나라도 있는지 확인
 */
function hasAnyMovable(state) {
  for (const key of state.throwQueue) {
    if (getMovablePiecesForThrow(state, key).length > 0) return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════
//  말 이동
// ═══════════════════════════════════════════════════════

function movePiece(state, pieceId) {
  if (state.phase !== 'MOVING') return { error: 'Not in moving phase' };
  if (!state.activeThrow) return { error: 'No throw selected' };

  const piece = state.pieces[pieceId];
  if (!piece) return { error: 'Invalid piece' };

  const playerId = state.players[state.currentPlayer];
  if (piece.playerId !== playerId) return { error: 'Not your piece' };
  if (piece.finished) return { error: 'Piece already finished' };

  const steps = YUT_RESULTS[state.activeThrow].steps;

  // throwQueue에서 사용한 결과 제거
  const idx = state.throwQueue.indexOf(state.activeThrow);
  if (idx !== -1) state.throwQueue.splice(idx, 1);
  state.activeThrow = null;

  return steps < 0
    ? moveBackward(state, piece)
    : moveForward(state, piece, steps);
}

function moveForward(state, piece, steps) {
  const route = ROUTES[piece.route];

  if (piece.position === -1) {
    piece.routeIndex = steps - 1;
  } else {
    piece.routeIndex += steps;
  }

  if (piece.routeIndex >= route.length) {
    finishPiece(piece);
    piece.stackedWith.forEach(id => finishPiece(state.pieces[id]));
    piece.stackedWith = [];
    return endMove(state, false);
  }

  piece.position = route[piece.routeIndex];

  // 외곽 → 모서리 착지 시 지름길 전환
  if (piece.route === 'outer' && SHORTCUT_CORNERS[piece.position]) {
    const newRoute = SHORTCUT_CORNERS[piece.position];
    piece.route = newRoute;
    piece.routeIndex = ROUTES[newRoute].indexOf(piece.position);
  }

  // 5 대각선에서 중앙(22) 착지 시 → center 경로 전환 (꺾어서 출발점 방향)
  // 지나치면 직진(25→26→15→외곽), 착지해야만 꺾음
  if (piece.route === 'shortcut5' && piece.position === 22) {
    piece.route = 'center';
    piece.routeIndex = 0;
  }

  syncStacked(state, piece);

  const captured = checkCapture(state, piece);
  checkStack(state, piece);

  return endMove(state, captured);
}

function moveBackward(state, piece) {
  if (piece.position === -1) return { error: 'Cannot move backward off-board piece' };

  piece.routeIndex -= 1;

  if (piece.routeIndex < 0) {
    // center 경로에서 빽도 → shortcut5의 21(중앙 직전)로 복귀
    if (piece.route === 'center') {
      piece.route = 'shortcut5';
      piece.routeIndex = ROUTES.shortcut5.indexOf(22) - 1;
      piece.position = ROUTES.shortcut5[piece.routeIndex];
      syncStacked(state, piece);
      const captured = checkCapture(state, piece);
      checkStack(state, piece);
      return endMove(state, captured);
    }
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

/**
 * 이동할 수 없는 결과를 건너뛴다.
 * throwQueue에서 throwKey를 제거하고 다음 단계로.
 */
function skipThrow(state, throwKey) {
  if (state.phase !== 'MOVING') return { error: 'Not in moving phase' };
  const idx = state.throwQueue.indexOf(throwKey);
  if (idx !== -1) state.throwQueue.splice(idx, 1);
  state.activeThrow = null;
  return advanceTurn(state);
}

/**
 * 남은 throwQueue 전체를 건너뛴다 (이동 불가할 때).
 */
function skipAllThrows(state) {
  if (state.phase !== 'MOVING') return { error: 'Not in moving phase' };
  state.throwQueue = [];
  state.activeThrow = null;
  return advanceTurn(state);
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

function checkCapture(state, movingPiece) {
  let captured = false;
  for (const piece of Object.values(state.pieces)) {
    if (piece.playerId === movingPiece.playerId) continue;
    if (piece.position !== movingPiece.position) continue;
    if (piece.position < 0 || piece.finished) continue;
    resetPiece(piece);
    piece.stackedWith.forEach(id => resetPiece(state.pieces[id]));
    piece.stackedWith = [];
    captured = true;
  }
  return captured;
}

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

  // 잡기 → 추가 던지기 (던진 결과 소비 전에 추가 턴 부여)
  if (captured) {
    state.phase = 'THROWING';
    state.activeThrow = null;
    return { captured: true, extraThrow: true, currentPlayer: state.currentPlayer };
  }

  return advanceTurn(state);
}

/** throwQueue가 남았으면 MOVING 유지, 없으면 턴 교대 */
function advanceTurn(state) {
  if (state.throwQueue.length > 0) {
    // 아직 사용할 결과가 남아있음
    state.phase = 'MOVING';
    state.activeThrow = null;
    return { remainingThrows: state.throwQueue.length, currentPlayer: state.currentPlayer };
  }

  // 모든 결과 소비 → 턴 교대
  state.currentPlayer = (state.currentPlayer + 1) % 2;
  state.phase = 'THROWING';
  state.activeThrow = null;
  state.turnCount++;
  return { nextPlayer: state.currentPlayer };
}

// ═══════════════════════════════════════════════════════
//  도착지 미리보기
// ═══════════════════════════════════════════════════════

/** 상태 변경 없이 말의 도착 위치를 계산 */
function previewMove(state, pieceId, throwKey) {
  const piece = state.pieces[pieceId];
  if (!piece || piece.finished) return null;

  const steps = YUT_RESULTS[throwKey].steps;

  // 빽도
  if (steps < 0) {
    if (piece.position === -1) return null;
    if (piece.routeIndex - 1 < 0) {
      // center 경로에서 빽도 → shortcut5의 21로 복귀
      if (piece.route === 'center') {
        return { position: ROUTES.shortcut5[ROUTES.shortcut5.indexOf(22) - 1] };
      }
      return { position: -1 };
    }
    return { position: ROUTES[piece.route][piece.routeIndex - 1] };
  }

  const routeKey = piece.position === -1 ? 'outer' : piece.route;
  const route = ROUTES[routeKey];
  const idx = piece.position === -1 ? steps - 1 : piece.routeIndex + steps;

  if (idx >= route.length) return { position: -2, finished: true };

  let pos = route[idx];

  // 지름길 착지 시에도 노드 자체는 같으므로 pos 그대로
  return { position: pos };
}

/** 특정 말에 대해 throwQueue의 모든 가능한 도착지 목록 반환 */
function getDestinations(state, pieceId) {
  const results = [];
  const seen = new Set();

  state.throwQueue.forEach((key, index) => {
    const movable = getMovablePiecesForThrow(state, key);
    if (!movable.includes(pieceId)) return;

    const preview = previewMove(state, pieceId, key);
    if (!preview) return;

    const posKey = String(preview.position);
    if (seen.has(posKey)) return;
    seen.add(posKey);

    results.push({
      position: preview.position,
      finished: !!preview.finished,
      throwKey: key,
      throwIndex: index,
      name: YUT_RESULTS[key].name,
      steps: YUT_RESULTS[key].steps,
    });
  });

  return results;
}

/** throwQueue 중 하나라도 이동 가능한 말이 있는 말 ID 목록 (중복 제거) */
function getAllMovablePieces(state) {
  const set = new Set();
  for (const key of state.throwQueue) {
    for (const id of getMovablePiecesForThrow(state, key)) {
      set.add(id);
    }
  }
  return [...set];
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
//  Export
// ═══════════════════════════════════════════════════════

const GameLogic = {
  YUT_RESULTS, YUT_WEIGHTS, PIECES_PER_PLAYER,
  ROUTES, SHORTCUT_CORNERS, NODE_COORDS, BOARD_EDGES,
  createGameState, throwYut, applyThrow,
  selectThrow, getMovablePieces, getMovablePiecesForThrow, hasAnyMovable,
  getAllMovablePieces, previewMove, getDestinations,
  movePiece, skipThrow, skipAllThrows, forfeit,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = GameLogic;
} else if (typeof window !== 'undefined') {
  window.YutGame = GameLogic;
}
