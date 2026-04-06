/**
 * 윷판 캔버스 렌더러
 */
class BoardRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.size = 0;
    this.pad = 0;
    this.positions = {};       // nodeId → {x, y} (canvas px)
    this.animFrame = null;
    this.pulseT = 0;

    this.P0 = { f: '#2488d3', s: '#155f8a', h: '#7dc4ff' };
    this.P1 = { f: '#e04848', s: '#a03030', h: '#ff9898' };
  }

  /* ── 크기 맞춤 ── */

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

  /* ── 메인 그리기 ── */

  draw(state, movable) {
    const ctx = this.ctx;
    const s = this.size;
    ctx.clearRect(0, 0, s, s);

    // 배경
    ctx.fillStyle = '#fafcfe';
    ctx.fillRect(0, 0, s, s);

    this._drawEdges();
    this._drawNodes();
    if (state) this._drawPieces(state, movable || []);
  }

  /* ── 선분 ── */

  _drawEdges() {
    const ctx = this.ctx;
    ctx.strokeStyle = '#c0cad4';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';

    for (const [a, b] of YutGame.BOARD_EDGES) {
      const pa = this.positions[a], pb = this.positions[b];
      if (!pa || !pb) continue;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }
  }

  /* ── 노드 ── */

  _drawNodes() {
    const ctx = this.ctx;
    const big = new Set([0, 5, 10, 15, 22]);

    for (const [id, pos] of Object.entries(this.positions)) {
      const n = Number(id);
      const isBig = big.has(n);
      const r = isBig ? 10 : 5;

      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);

      if (n === 0) {
        ctx.fillStyle = '#f0e4c0';
        ctx.strokeStyle = '#b0a070';
      } else if (isBig) {
        ctx.fillStyle = '#e4ecf4';
        ctx.strokeStyle = '#8098ac';
      } else {
        ctx.fillStyle = '#eef2f6';
        ctx.strokeStyle = '#98aab8';
      }

      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // 출발 라벨
    const p0 = this.positions[0];
    if (p0) {
      const ctx2 = this.ctx;
      ctx2.fillStyle = '#8a7a50';
      ctx2.font = `bold ${Math.max(9, this.size * 0.025)}px sans-serif`;
      ctx2.textAlign = 'center';
      ctx2.fillText('출발', p0.x, p0.y + 18);
    }
  }

  /* ── 말 그리기 ── */

  _drawPieces(state, movable) {
    const ctx = this.ctx;

    // 위치별 그룹핑
    const groups = {};
    for (const piece of Object.values(state.pieces)) {
      if (piece.position < 0) continue;
      const k = piece.position;
      if (!groups[k]) groups[k] = [];
      groups[k].push(piece);
    }

    for (const [pos, pieces] of Object.entries(groups)) {
      const np = this.positions[pos];
      if (!np) continue;

      // 플레이어별 분류
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
        const px = np.x + off, py = np.y;
        const r = 11;

        // 업힌 수
        const leader = arr.find(p => p.stackedWith && p.stackedWith.length > 0) || arr[0];
        const cnt = (leader.stackedWith ? leader.stackedWith.length : 0) + 1;

        // 이동 가능 하이라이트
        const canMove = arr.some(p => movable.includes(p.id));
        if (canMove) {
          ctx.beginPath();
          ctx.arc(px, py, r + 5, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,220,60,0.35)';
          ctx.fill();
          ctx.strokeStyle = '#ffcc00';
          ctx.lineWidth = 2;
          ctx.setLineDash([3, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        // 말 원
        const grad = ctx.createRadialGradient(px - 3, py - 3, 1, px, py, r);
        grad.addColorStop(0, col.h);
        grad.addColorStop(1, col.f);
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.strokeStyle = col.s;
        ctx.lineWidth = 2;
        ctx.stroke();

        // 업힌 수 표시
        if (cnt > 1) {
          ctx.fillStyle = '#fff';
          ctx.font = 'bold 11px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(cnt), px, py + 1);
        }
      });
    }
  }

  /* ── 클릭 판정 ── */

  hitTest(cx, cy, state, movable) {
    if (!state || !movable || !movable.length) return null;

    for (const pid of movable) {
      const piece = state.pieces[pid];
      if (!piece || piece.position < 0) continue;
      const np = this.positions[piece.position];
      if (!np) continue;
      const dx = cx - np.x, dy = cy - np.y;
      if (dx * dx + dy * dy <= 16 * 16) return pid;
    }
    return null;
  }
}
