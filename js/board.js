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

    this.P0 = { f: '#2488d3', s: '#155f8a', h: '#7dc4ff' };
    this.P1 = { f: '#e04848', s: '#a03030', h: '#ff9898' };
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

  /* ══════════════════════════════════════════
     메인 그리기
     ══════════════════════════════════════════ */

  draw(state, movable, selectedPiece, destinations) {
    const ctx = this.ctx, s = this.size;
    ctx.clearRect(0, 0, s, s);
    ctx.fillStyle = '#fafcfe';
    ctx.fillRect(0, 0, s, s);

    this._drawEdges();
    this._drawNodes();

    if (state) {
      if (destinations && destinations.length > 0) this._drawDestinations(destinations);
      this._drawPieces(state, movable || [], selectedPiece);
      this._drawWaitingPieces(state, movable || [], selectedPiece);
    }
  }

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

  _drawPieces(state, movable, selectedPiece) {
    const ctx = this.ctx;
    const groups = {};
    for (const piece of Object.values(state.pieces)) {
      if (piece.position < 0) continue;
      if (!groups[piece.position]) groups[piece.position] = [];
      groups[piece.position].push(piece);
    }

    for (const [pos, pieces] of Object.entries(groups)) {
      const np = this.positions[pos];
      if (!np) continue;
      const byP = [[], []];
      for (const p of pieces) {
        const idx = state.players.indexOf(p.playerId);
        if (idx >= 0) byP[idx].push(p);
      }
      const draws = byP.filter(a => a.length > 0);
      draws.forEach((arr, gi) => {
        const pidx = state.players.indexOf(arr[0].playerId);
        const col = pidx === 0 ? this.P0 : this.P1;
        const off = draws.length > 1 ? (gi === 0 ? -10 : 10) : 0;
        const px = np.x + off, py = np.y, r = 11;
        const leader = arr.find(p => p.stackedWith && p.stackedWith.length > 0) || arr[0];
        const cnt = (leader.stackedWith ? leader.stackedWith.length : 0) + 1;
        const isSelected = arr.some(p => p.id === selectedPiece);
        const canMove = arr.some(p => movable.includes(p.id));
        this._drawOnePiece(ctx, px, py, r, col, isSelected, canMove, cnt);
      });
    }
  }

  /* ── 대기 말 (판 바깥) ── */

  _drawWaitingPieces(state, movable, selectedPiece) {
    const ctx = this.ctx;
    this._waitPos = {};

    const waiting = [[], []];
    for (const piece of Object.values(state.pieces)) {
      if (piece.position !== -1 || piece.finished) continue;
      const pidx = state.players.indexOf(piece.playerId);
      if (pidx >= 0) waiting[pidx].push(piece);
    }

    if (waiting[0].length === 0 && waiting[1].length === 0) return;

    // 대기 영역: 보드 하단 여백
    const cx = this.size / 2;
    const y = this.size - this.pad * 0.3;
    const sp = 18;
    const r = 8;

    // "대기" 라벨
    ctx.fillStyle = '#99a';
    ctx.font = `${Math.max(8, this.size * 0.02)}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText('대기', cx, y - 12);

    waiting.forEach((pieces, pidx) => {
      const col = pidx === 0 ? this.P0 : this.P1;
      const groupStartX = cx + (pidx === 0 ? -pieces.length * sp : sp * 0.5);

      pieces.forEach((piece, i) => {
        const px = groupStartX + i * sp;
        const py = y;
        this._waitPos[piece.id] = { x: px, y: py };

        const isSelected = piece.id === selectedPiece;
        const canMove = movable.includes(piece.id);
        this._drawOnePiece(ctx, px, py, r, col, isSelected, canMove, 0);
      });
    });
  }

  /* ── 말 한 개 렌더 (공통) ── */

  _drawOnePiece(ctx, px, py, r, col, isSelected, canMove, stackCount) {
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

    const grad = ctx.createRadialGradient(px - 2, py - 2, 1, px, py, r);
    grad.addColorStop(0, col.h); grad.addColorStop(1, col.f);
    ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = grad; ctx.fill();
    ctx.strokeStyle = col.s; ctx.lineWidth = 1.5; ctx.stroke();

    if (stackCount > 1) {
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(stackCount), px, py + 1);
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
      } else if (piece.position === -1) {
        // 대기 말
        const wp = this._waitPos[pid];
        if (!wp) continue;
        if (dist2(cx, cy, wp.x, wp.y) <= 12 * 12) return pid;
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
