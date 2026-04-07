/**
 * 윷판 캔버스 렌더러
 */
class BoardRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.size = 0;
    this.pad = 0;
    this.positions = {};
    this._waitPos = {};   // pieceId → {x,y} 대기 말 캔버스 좌표

    this.COLORS = [
      { f: '#e03030', s: '#a02020', h: '#ff9090' },  // P0 red
      { f: '#28a428', s: '#1a6b1a', h: '#7de07d' },  // P1 green
      { f: '#d4b800', s: '#9a8400', h: '#ffe050' },  // P2 yellow
      { f: '#8844cc', s: '#5a2a99', h: '#cc99ff' },  // P3 purple
    ];
    // Keep P0 and P1 as aliases for backward compatibility
    this.P0 = this.COLORS[0];
    this.P1 = this.COLORS[1];

    this._anim = null;       // 현재 진행 중인 애니메이션 상태
    this._lastRender = null; // 최근 draw() 호출 인자 (애니메이션 틱에서 재사용)

    this.playerAvatars = {};     // pidx → HTMLImageElement
    this.dupAvatarPlayers = new Set(); // 동일 아바타 착용 플레이어 pidx Set
  }

  setPlayerAvatars(map, dupSet) {
    this.playerAvatars = map || {};
    this.dupAvatarPlayers = dupSet || new Set();
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const s = Math.floor(Math.min(rect.width, rect.height));
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = s * dpr;
    this.canvas.height = s * dpr;
    this.canvas.style.width = s + 'px';
    this.canvas.style.height = s + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.size = s;
    this.pad = s * 0.08;
    this._cache();
  }

  _cache() {
    const inner = this.size - this.pad * 2;
    this.positions = {};
    for (const [id, [px, py]] of Object.entries(YutGame.NODE_COORDS)) {
      this.positions[id] = {
        x: this.pad + (px / 100) * inner,
        y: this.pad + (py / 100) * inner,
      };
    }
  }

  playerColor(idx) { return this.COLORS[idx % this.COLORS.length]; }

  /* ══════════════════════════════════════════
     메인 그리기
     ══════════════════════════════════════════ */

  draw(state, movable, selectedPiece, destinations) {
    this._lastRender = {
      state, movable: movable || [],
      selectedPiece: selectedPiece || null,
      destinations: destinations || [],
    };

    const ctx = this.ctx, s = this.size;
    ctx.clearRect(0, 0, s, s);
    ctx.fillStyle = '#fafcfe';
    ctx.fillRect(0, 0, s, s);

    this._drawEdges();
    this._drawNodes();

    if (state) {
      // 애니메이션 중인 말은 일반 그리기에서 제외
      const excl = this._anim ? this._anim.ids : null;
      if (destinations && destinations.length > 0) this._drawDestinations(destinations);
      this._drawPieces(state, movable || [], selectedPiece, excl);

      // 애니메이션 말을 보간 위치에 그림
      if (this._anim) {
        this._drawOnePiece(ctx,
          this._anim.curX, this._anim.curY, 11,
          this._anim.col, false, false, this._anim.cnt,
          this._anim.avatarImg || null, this._anim.isDup || false);
      }
    }
  }

  /* ══════════════════════════════════════════
     말 이동 애니메이션
     ══════════════════════════════════════════ */

  /**
   * @param {string[]} animIds   애니메이션 말 ID 배열 (리더 + 업힌 말)
   * @param {{x,y}}   fromCoord  출발 캔버스 좌표
   * @param {number[]} nodePath  경유/도착 노드 ID 배열 (출발 제외)
   * @param {object}  col        색상 객체 (P0 / P1)
   * @param {number}  cnt        스택 개수
   * @param {object}  state      애니메이션 중 사용할 gameState
   * @param {Function} onComplete 완료 콜백
   */
  startAnimation(animIds, fromCoord, nodePath, col, cnt, state, onComplete, avatarImg, isDup) {
    // 진행 중인 애니메이션이 있으면 즉시 완료 처리
    if (this._anim) {
      const cb = this._anim.onComplete;
      this._anim = null;
      if (cb) cb();
    }

    if (!nodePath || nodePath.length === 0 || !fromCoord) {
      if (onComplete) onComplete();
      return;
    }

    // 출발 좌표 + 경유 노드 캔버스 좌표 배열
    const coordPath = [{ x: fromCoord.x, y: fromCoord.y }];
    for (const nodeId of nodePath) {
      const p = this.positions[nodeId];
      if (p) coordPath.push({ x: p.x, y: p.y });
    }

    if (coordPath.length < 2) {
      if (onComplete) onComplete();
      return;
    }

    this._anim = {
      ids: new Set(animIds.map(String)),
      path: coordPath,
      stepMs: 150,          // 노드 간 이동 시간 (ms)
      startTime: null,
      curX: coordPath[0].x,
      curY: coordPath[0].y,
      col, cnt,
      onComplete,
      avatarImg: avatarImg || null,
      isDup: isDup || false,
    };
    // 애니메이션 중 렌더 파라미터 설정 (말 클릭 등 비활성화)
    this._lastRender = { state, movable: [], selectedPiece: null, destinations: [] };

    requestAnimationFrame(ts => this._animTick(ts));
  }

  _animTick(ts) {
    if (!this._anim) return;
    if (!this._anim.startTime) this._anim.startTime = ts;

    const segs = this._anim.path.length - 1;
    const totalMs = segs * this._anim.stepMs;
    const t = Math.min(1, (ts - this._anim.startTime) / totalMs);

    // 현재 세그먼트 계산
    const rawSeg = t * segs;
    const segIdx = Math.min(Math.floor(rawSeg), segs - 1);
    const segT   = rawSeg - segIdx;
    // ease-in-out (quadratic)
    const ease   = segT < 0.5 ? 2 * segT * segT : -1 + (4 - 2 * segT) * segT;

    const from = this._anim.path[segIdx];
    const to   = this._anim.path[segIdx + 1];
    this._anim.curX = from.x + (to.x - from.x) * ease;
    this._anim.curY = from.y + (to.y - from.y) * ease;

    // 마지막 노드에 도달했을 때 살짝 튀는 효과 (scale은 draw에서 하기 복잡하므로 생략)
    const { state, movable, selectedPiece, destinations } = this._lastRender;
    this.draw(state, movable, selectedPiece, destinations);

    if (t < 1) {
      requestAnimationFrame(ts => this._animTick(ts));
    } else {
      const cb = this._anim.onComplete;
      this._anim = null;
      if (cb) cb();
    }
  }

  isAnimating() { return !!this._anim; }

  /* ── 선분 ── */

  _drawEdges() {
    const ctx = this.ctx;
    ctx.strokeStyle = '#c0cad4'; ctx.lineWidth = 2; ctx.lineCap = 'round';
    for (const [a, b] of YutGame.BOARD_EDGES) {
      const pa = this.positions[a], pb = this.positions[b];
      if (!pa || !pb) continue;
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    }
  }

  /* ── 노드 ── */

  _drawNodes() {
    const ctx = this.ctx;
    const big = new Set([0, 5, 10, 15, 22]);
    for (const [id, pos] of Object.entries(this.positions)) {
      const n = Number(id), isBig = big.has(n), r = isBig ? 10 : 5;
      ctx.beginPath(); ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx.fillStyle = n === 0 ? '#f0e4c0' : isBig ? '#e4ecf4' : '#eef2f6';
      ctx.strokeStyle = n === 0 ? '#b0a070' : '#98aab8';
      ctx.fill(); ctx.lineWidth = 1.5; ctx.stroke();
    }
    const p0 = this.positions[0];
    if (p0) {
      this.ctx.fillStyle = '#8a7a50';
      this.ctx.font = `bold ${Math.max(9, this.size * 0.025)}px sans-serif`;
      this.ctx.textAlign = 'center';
      this.ctx.fillText('출발', p0.x, p0.y + 18);
    }
  }

  /* ── 도착지 마커 ── */

  _drawDestinations(destinations) {
    const ctx = this.ctx;
    const fontSize = Math.max(11, this.size * 0.03);
    for (const dest of destinations) {
      let px, py;
      if (dest.finished) {
        const p0 = this.positions[0];
        if (!p0) continue;
        px = p0.x + 22; py = p0.y - 16;
      } else {
        const np = this.positions[dest.position];
        if (!np) continue;
        px = np.x; py = np.y;
      }
      ctx.beginPath(); ctx.arc(px, py, 15, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 210, 50, 0.35)'; ctx.fill();
      ctx.strokeStyle = '#cca000'; ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#7a5a00';
      ctx.font = `bold ${fontSize}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(dest.finished ? '⬇완주' : '⬇' + dest.name, px, py - 16);
    }
  }

  /* ── 보드 위 말 ── */

  _drawPieces(state, movable, selectedPiece, excludeIds) {
    const ctx = this.ctx;
    const groups = {};
    for (const piece of Object.values(state.pieces)) {
      if (piece.position < 0) continue;
      if (excludeIds && excludeIds.has(String(piece.id))) continue;
      if (!groups[piece.position]) groups[piece.position] = [];
      groups[piece.position].push(piece);
    }

    for (const [pos, pieces] of Object.entries(groups)) {
      const np = this.positions[pos];
      if (!np) continue;
      const playerCount = state.players.length;
      const byP = Array.from({ length: playerCount }, () => []);
      for (const p of pieces) {
        const idx = state.players.indexOf(p.playerId);
        if (idx >= 0) byP[idx].push(p);
      }
      const draws = byP.map((arr, pidx) => ({ arr, pidx })).filter(g => g.arr.length > 0);
      const OFFSETS = [[0,0],[-9,0],[9,0],[0,-9],[0,9],[-9,-9],[9,-9],[-9,9],[9,9]];
      draws.forEach((g, gi) => {
        const col = this.playerColor(g.pidx);
        const [dx, dy] = draws.length > 1 ? (OFFSETS[gi] || [0, 0]) : [0, 0];
        const px = np.x + dx, py = np.y + dy, r = 11;
        const leader = g.arr.find(p => p.stackedWith && p.stackedWith.length > 0) || g.arr[0];
        const cnt = (leader.stackedWith ? leader.stackedWith.length : 0) + 1;
        const isSelected = g.arr.some(p => p.id === selectedPiece);
        const canMove = g.arr.some(p => movable.includes(p.id));
        const avatarImg = this.playerAvatars[g.pidx] || null;
        const isDup = this.dupAvatarPlayers.has(g.pidx);
        this._drawOnePiece(ctx, px, py, r, col, isSelected, canMove, cnt, avatarImg, isDup);
      });
    }
  }

  /* ── 대기 말 (판 바깥) ── */

  _drawWaitingPieces(state, movable, selectedPiece, excludeIds) {
    const ctx = this.ctx;
    this._waitPos = {};

    const playerCount = state.players.length;
    const waiting = Array.from({ length: playerCount }, () => []);
    for (const piece of Object.values(state.pieces)) {
      if (piece.position !== -1 || piece.finished) continue;
      if (excludeIds && excludeIds.has(String(piece.id))) continue;
      const pidx = state.players.indexOf(piece.playerId);
      if (pidx >= 0) waiting[pidx].push(piece);
    }

    if (waiting.every(arr => arr.length === 0)) return;

    // 대기 영역: 보드 하단 여백
    const cx = this.size / 2;
    const y = this.size - this.pad * 0.3;
    const sp = 18;
    const r = 8;
    const groupSp = 6;

    // "대기" 라벨
    ctx.fillStyle = '#99a';
    ctx.font = `${Math.max(8, this.size * 0.02)}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText('대기', cx, y - 12);

    waiting.forEach((pieces, pidx) => {
      if (pieces.length === 0) return;
      const col = this.playerColor(pidx);
      const totalW = playerCount * (sp * 4 + groupSp) - groupSp;
      const startX = (this.size - totalW) / 2 + pidx * (sp * 4 + groupSp);
      pieces.forEach((piece, i) => {
        const px = startX + i * sp;
        const py = y;
        this._waitPos[piece.id] = { x: px, y: py };
        const isSelected = piece.id === selectedPiece;
        const canMove = movable.includes(piece.id);
        const avatarImg = this.playerAvatars[pidx] || null;
        const isDup = this.dupAvatarPlayers.has(pidx);
        this._drawOnePiece(ctx, px, py, r, col, isSelected, canMove, 0, avatarImg, isDup);
      });
    });
  }

  /* ── 말 한 개 렌더 (공통) ── */

  _drawOnePiece(ctx, px, py, r, col, isSelected, canMove, stackCount, avatarImg, isDuplicate) {
    if (isSelected) {
      ctx.beginPath(); ctx.arc(px, py, r + 5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(100, 220, 255, 0.35)'; ctx.fill();
      ctx.strokeStyle = '#00aaff'; ctx.lineWidth = 2.5; ctx.stroke();
    } else if (canMove) {
      ctx.beginPath(); ctx.arc(px, py, r + 4, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 220, 60, 0.3)'; ctx.fill();
      ctx.strokeStyle = '#ddaa00'; ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
    }

    if (avatarImg && avatarImg.complete && avatarImg.naturalWidth > 0) {
      // 아바타: 이미지 그대로 표시, 중복 착용 시 팀컬러 외곽선 광선 효과
      if (isDuplicate) {
        ctx.filter = `drop-shadow(0 0 1.3px ${col.f}) drop-shadow(0 0 1.3px ${col.f})`;
      }
      ctx.drawImage(avatarImg, px - r, py - r, r * 2, r * 2);
      ctx.filter = 'none';
    } else {
      // 기본: 팀 컬러 그라디언트 원
      const grad = ctx.createRadialGradient(px - 2, py - 2, 1, px, py, r);
      grad.addColorStop(0, col.h); grad.addColorStop(1, col.f);
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fillStyle = grad; ctx.fill();
      ctx.strokeStyle = col.s; ctx.lineWidth = 1.5; ctx.stroke();
    }

    if (stackCount > 1) {
      ctx.fillStyle = '#000';
      ctx.font = 'bold 10pt "Dotum","Gulim","Tahoma",sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(String(stackCount), px, py - r - 1);
    }
  }

  /* ── 클릭: 말 (보드 위 + 대기) ── */

  hitTestPiece(cx, cy, state, movable) {
    if (!state || !movable || !movable.length) return null;

    // 보드 위 말
    for (const pid of movable) {
      const piece = state.pieces[pid];
      if (!piece) continue;

      if (piece.position >= 0) {
        const np = this.positions[piece.position];
        if (!np) continue;
        if (dist2(cx, cy, np.x, np.y) <= 16 * 16) return pid;
      }
    }
    return null;
  }

  /* ── 클릭: 도착지 ── */

  hitTestDestination(cx, cy, destinations) {
    if (!destinations || !destinations.length) return null;
    for (const dest of destinations) {
      let px, py;
      if (dest.finished) {
        const p0 = this.positions[0];
        if (!p0) continue;
        px = p0.x + 22; py = p0.y - 16;
      } else {
        const np = this.positions[dest.position];
        if (!np) continue;
        px = np.x; py = np.y;
      }
      if (dist2(cx, cy, px, py) <= 18 * 18) return dest;
    }
    return null;
  }
}

function dist2(ax, ay, bx, by) {
  return (ax - bx) * (ax - bx) + (ay - by) * (ay - by);
}
