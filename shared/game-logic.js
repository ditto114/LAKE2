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
  0:  [100, 100], 1:  [100, 80],  2:  [100, 60],  3:  [100, 40],  4:  [100, 20],
  5:  [100, 0],   6:  [80, 0],    7:  [60, 0],    8:  [40, 0],    9:  [20, 0],
  10: [0, 0],     11: [0, 20],    12: [0, 40],    13: [0, 60],    14: [0, 80],
  15: [0, 100],   16: [20, 100],  17: [40, 100],  18: [60, 100],  19: [80, 100],
  20: [83, 17],   21: [67, 33],
  22: [50, 50],
  23: [17, 17],   24: [33, 33],
  25: [33, 67],   26: [17, 83],
  27: [67, 67],   28: [83, 83],
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

function createGameState(playerIds) {
  const pieces = {};
  playerIds.forEach((pid, idx) => {
    for (let i = 0; i < PIECES_PER_PLAYER; i++) {
      const id = `p${idx}_${i}`;
      pieces[id] = createPiece(id, pid);
    }
  });
  return {
    players: playerIds,
    activePlayers: playerIds.map((_, i) => i),
    pieces,
    currentPlayer: 0,
    phase: 'THROWING',      // THROWING | MOVING | GAME_OVER
    throwQueue: [],          // 던진 결과 큐 (아직 이동에 사용 안 한 것들)
    activeThrow: null,       // 현재 이동에 선택된 결과 키
    winner: null,
    turnCount: 0,
    rankings: [],            // 완주/잔류 순 playerId 배열 (1등부터)
    forfeitOrder: [],        // 기권 순서 playerId 배열
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

  const throwKey = state.activeThrow;
  const steps = YUT_RESULTS[throwKey].steps;

  // throwQueue에서 사용한 결과 제거
  const idx = state.throwQueue.indexOf(throwKey);
  if (idx !== -1) state.throwQueue.splice(idx, 1);
  state.activeThrow = null;

  return steps < 0
    ? moveBackward(state, piece, throwKey)
    : moveForward(state, piece, steps, throwKey);
}

function moveForward(state, piece, steps, throwKey) {
  const route = ROUTES[piece.route];

  // 출발지(노드 0)에 있는 말은 어떤 전진이든 즉시 골인
  if (piece.position === 0) {
    const stacked = piece.stackedWith.slice();
    finishPiece(piece);
    stacked.forEach(id => finishPiece(state.pieces[id]));
    return endMove(state, false);
  }

  if (piece.position === -1) {
    piece.routeIndex = steps - 1;
  } else {
    piece.routeIndex += steps;
  }

  if (piece.routeIndex >= route.length) {
    const stacked = piece.stackedWith.slice();
    finishPiece(piece);
    stacked.forEach(id => finishPiece(state.pieces[id]));
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

  return endMove(state, captured, throwKey);
}

function moveBackward(state, piece, throwKey) {
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
      return endMove(state, captured, throwKey);
    }
    if (piece.routeIndex === -1) {
      // 경로 첫 번째 칸(routeIndex 0)에서 빽도 → 출발지(노드 0)에 착지
      piece.position = 0;
      piece.route = 'outer';
      // routeIndex는 -1 유지 (다음 전진 시 -1+steps 로 올바르게 계산됨)
      piece.stackedWith.forEach(id => {
        const sp = state.pieces[id];
        sp.position = 0; sp.route = 'outer'; sp.routeIndex = -1;
      });
      piece.stackedWith = [];
      syncStacked(state, piece);
      const captured = checkCapture(state, piece);
      checkStack(state, piece);
      return endMove(state, captured, throwKey);
    }
    if (piece.routeIndex === -2) {
      // 출발지(position=0, routeIndex=-1)에서 빽도 → 노드 19로 후퇴
      // routeIndex를 route.length로 설정해 다음 전진 시 즉시 골인되도록 함
      const outerLen = ROUTES.outer.length;
      piece.position = 19;
      piece.route = 'outer';
      piece.routeIndex = outerLen; // 다음 전진 시 outerLen+steps >= outerLen → 골인
      piece.stackedWith.forEach(id => {
        const sp = state.pieces[id];
        sp.position = 19; sp.route = 'outer'; sp.routeIndex = outerLen;
      });
      piece.stackedWith = [];
      syncStacked(state, piece);
      const captured = checkCapture(state, piece);
      checkStack(state, piece);
      return endMove(state, captured, throwKey);
    }
    return endMove(state, false, throwKey);
  }

  const route = ROUTES[piece.route];
  piece.position = route[piece.routeIndex];

  // 지름길에서 후퇴하여 분기점 이전 노드로 돌아온 경우 외곽 경로로 복귀
  if (piece.route === 'shortcut5' && piece.routeIndex < ROUTES.shortcut5.indexOf(20)) {
    piece.route = 'outer';
    piece.routeIndex = ROUTES.outer.indexOf(piece.position);
  } else if (piece.route === 'shortcut10' && piece.routeIndex < ROUTES.shortcut10.indexOf(23)) {
    piece.route = 'outer';
    piece.routeIndex = ROUTES.outer.indexOf(piece.position);
  }

  syncStacked(state, piece);

  const captured = checkCapture(state, piece);
  checkStack(state, piece);

  return endMove(state, captured, throwKey);
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
function endMove(state, captured, throwKey) {
  // 승리 판정
  const playerId = state.players[state.currentPlayer];
  const allFinished = Object.values(state.pieces)
    .filter(p => p.playerId === playerId)
    .every(p => p.finished);

  if (allFinished) {
    const playerIdx = state.currentPlayer;
    state.rankings.push(playerId);
    state.activePlayers = state.activePlayers.filter(i => i !== playerIdx);

    if (state.activePlayers.length === 0) {
      state.phase = 'GAME_OVER';
      return { ranked: playerId, rank: state.rankings.length, gameOver: true };
    }
    if (state.activePlayers.length === 1) {
      const lastId = state.players[state.activePlayers[0]];
      state.rankings.push(lastId);
      state.activePlayers = [];
      state.phase = 'GAME_OVER';
      return { ranked: playerId, rank: state.rankings.length - 1, gameOver: true };
    }
    // 게임 계속 — 다음 active 플레이어로 턴 이동
    const next = state.activePlayers.find(i => i > playerIdx) ?? state.activePlayers[0];
    state.currentPlayer = next;
    state.phase = 'THROWING';
    state.throwQueue = [];
    state.activeThrow = null;
    state.turnCount++;
    return { ranked: playerId, rank: state.rankings.length, gameOver: false };
  }

  // 잡기 → 추가 던지기 (단, 윷/모는 이미 추가 던지기가 부여되었으므로 제외)
  if (captured) {
    const isYutOrMo = throwKey === 'YUT' || throwKey === 'MO';
    if (!isYutOrMo) {
      state.phase = 'THROWING';
      state.activeThrow = null;
      return { captured: true, extraThrow: true, currentPlayer: state.currentPlayer };
    }
    // 윷/모 잡기: 추가 던지기 없이 남은 큐 처리
    return { captured: true, extraThrow: false, ...advanceTurn(state) };
  }

  return advanceTurn(state);
}

/** throwQueue가 남았으면 MOVING 유지, 없으면 턴 교대 */
function advanceTurn(state) {
  if (state.throwQueue.length > 0) {
    state.phase = 'MOVING';
    state.activeThrow = null;
    return { remainingThrows: state.throwQueue.length, currentPlayer: state.currentPlayer };
  }
  const active = state.activePlayers;
  const curIdx = active.indexOf(state.currentPlayer);
  state.currentPlayer = active[(curIdx + 1) % active.length];
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
      // 경로 첫 번째 칸(routeIndex=0)에서 빽도 → 출발지(노드 0)로 복귀
      if (piece.routeIndex === 0) return { position: 0 };
      // 출발지(position=0, routeIndex=-1)에서 빽도 → 노드 19로 후퇴 (다음 전진 시 골인)
      if (piece.routeIndex === -1) return { position: 19 };
      return null;
    }
    return { position: ROUTES[piece.route][piece.routeIndex - 1] };
  }

  // 출발지(노드 0)에 있는 말은 전진 시 무조건 골인
  if (piece.position === 0) return { position: -2, finished: true };

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
  const playerIdx = state.players.indexOf(playerId);
  if (playerIdx === -1) return { winner: null, gameOver: false };

  // 기권 플레이어의 말 모두 초기화
  for (const piece of Object.values(state.pieces)) {
    if (piece.playerId === playerId) {
      resetPiece(piece);
      piece.stackedWith = [];
    }
  }

  state.forfeitOrder.push(playerId);
  state.activePlayers = state.activePlayers.filter(i => i !== playerIdx);

  if (state.activePlayers.length === 0) {
    state.phase = 'GAME_OVER';
    return { gameOver: true };
  }
  if (state.activePlayers.length === 1) {
    const lastId = state.players[state.activePlayers[0]];
    state.rankings.push(lastId);
    state.activePlayers = [];
    state.phase = 'GAME_OVER';
    return { gameOver: true };
  }

  // 게임 계속 — 기권자 턴이었으면 다음 플레이어로 교대
  if (state.currentPlayer === playerIdx) {
    state.throwQueue = [];
    state.activeThrow = null;
    const active = state.activePlayers;
    const nextIdx = active.find(i => i > playerIdx) ?? active[0];
    state.currentPlayer = nextIdx;
    state.phase = 'THROWING';
  }
  return { gameOver: false };
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
  movePiece, skipThrow, skipAllThrows, advanceTurn, forfeit,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = GameLogic;
} else if (typeof window !== 'undefined') {
  window.YutGame = GameLogic;
}
