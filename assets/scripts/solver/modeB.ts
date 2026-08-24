// MODE B — cellular automaton falling-sand. KHÔNG phải port: đây là bản viết mới engine-agnostic,
// căn cứ docs/ASSESSMENT.md §"Cát: 2 mode A/B".
//
// Chia tầng tuning theo đúng ASSESSMENT:
//   · tầng HÌNH HỌC level (rig SDF: funnel/chute/frame/belt) — DÙNG LẠI TRỌN, lấy thẳng từ buildSdfRig().
//   · tầng PACING (emit/belt speed/jar) — dùng lại schema + giá trị SAND_TUNING làm điểm xuất phát.
//   · tầng PHYSICS lõi (radius/substeps/restitution/compliance/CCD/friction) — MẤT, CA không có không gian
//     tham số đó. Thay bằng 4 núm CA ở MODE_B_TUNING dưới đây, phải tune LẠI BẰNG MẮT.
//
// ⚠ ĐÂY LÀ MODE PHỤ. Mode A (solver/step.ts) là bản chuẩn giữ trọn tuning nguồn; B tồn tại để đổi qua lại khi
//   A quá nặng trên máy thấp. Số liệu parity P6 luôn đọc theo A, KHÔNG đọc theo B.
//
// HỢP ĐỒNG TRÁO ĐƯỢC: cùng bề mặt với SandSolver mà AdRoot dùng — `pool` · `alloc(cap)` · `step(p): number`.
// Nhờ vậy renderer / JarColumns.harvest / countBeltGrains / ConversionFront.emit KHÔNG phải biết đang chạy mode nào.
//
// Ô lưới GIỮ hạt của pool chứ không thay pool: pool vẫn là nơi giữ danh tính hạt (colorId, carried) — lọ hút và
// renderer đọc y nguyên. CA chỉ quyết định hạt DI CHUYỂN đi đâu; positions luôn = tâm ô.

import { GrainParticlePool } from './pool';
import type { SolverParams } from './step';
import { clampWorld, xformPoint, v2, type GrainSdfField, type V2 } from './sdfWalls';

/**
 * 4 núm riêng của CA — thay cho cả tầng physics lõi của Mode A. Tune BẰNG MẮT theo 3 số tham chiếu mà
 * ASSESSMENT yêu cầu đo trước từ bản Unity: thời gian đầy jar · góc nghỉ đụn · thời lượng drain 1 swipe.
 */
export const MODE_B_TUNING = {
  /**
   * Cỡ 1 ô CA theo world. Cầu quy đổi ASSESSMENT: cellSize = 2·GrainParticleRadius / divisor.
   * divisor = 1 -> 1 ô đúng bằng 1 hạt Mode A (mật độ hiển thị khớp). Tăng divisor = cát mịn hơn nhưng
   * số ô tăng bình phương.
   */
  cellDivisor: 1,

  /**
   * Số ô TỐI ĐA 1 hạt được đi trong 1 step. >1 cho cát rơi nhanh mà không xuyên (CA đi từng ô một, có kiểm
   * ô trung gian) nhưng làm đụn "nhảy". 3 ~ hợp với dt 1/30 và belt 13 world/s.
   */
  maxCellsPerStep: 3,

  /**
   * 0 = chỉ rơi thẳng (đụn dựng đứng, góc nghỉ 90°) · 1 = luôn thử trượt chéo khi bị chặn (đụn phẳng).
   * Đây là núm THAY cho friction/góc nghỉ của Mode A — chỉnh nó là chỉnh góc nghỉ.
   */
  slideChance: 0.75,

  /**
   * Hệ số bám belt: 1 = hạt trong lòng vành đi ĐÚNG beltSpeed · <1 = trượt so với băng.
   * Thay cho grainBeltCoupling của Mode A.
   */
  beltGrip: 0.9,
} as const;

const EPS_SOLID = 1e-4;

/** Băm 2 int -> uint. CA cần "ngẫu nhiên" mà TÁI LẬP ĐƯỢC (replay/parity) nên băm chỉ số, KHÔNG Math.random. */
function hash2(a: number, b: number): number {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b)) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12; h = Math.imul(h, 0x297a2d39) >>> 0;
  h ^= h >>> 15;
  return h >>> 0;
}

/** hash2 -> [0,1). */
const hash01 = (a: number, b: number): number => hash2(a, b) / 4294967296;

const _p: V2 = v2();
const _pPrev: V2 = v2();
const _lp: V2 = v2();

export class SandCellSolver {
  readonly pool = new GrainParticlePool();

  // --- lưới ---
  private originX = 0;          // world x của mép trái ô (0,0)
  private originY = 0;          // world y của mép DƯỚI ô (0,0)
  private cell = 1;
  private nx = 0;
  private ny = 0;
  /** 1 = ô là TƯỜNG (bake 1 lần từ SDF rig). Hạt không bao giờ vào ô solid. */
  private solid!: Uint8Array;
  /** chỉ số hạt đang chiếm ô, -1 = trống. Dựng lại mỗi step. */
  private occ!: Int32Array;
  /** ô hiện tại của từng hạt (index phẳng), -1 = ngoài lưới. */
  private cellOfGrain!: Int32Array;
  /** phần lẻ số ô còn nợ của từng hạt (belt chạy 13 world/s không chia chẵn theo ô). */
  private phase!: Float32Array;
  /** thứ tự duyệt: hạt THẤP trước (bottom-up) -> ô vừa nhường được hạt trên dùng ngay trong CÙNG pass. */
  private order!: Int32Array;

  private baked = false;
  private stepCounter = 0;

  alloc(capacity: number): void {
    this.pool.alloc(capacity);
    this.cellOfGrain = new Int32Array(capacity).fill(-1);
    this.phase = new Float32Array(capacity);
    this.order = new Int32Array(capacity);
  }

  /**
   * Bake lưới + mặt nạ tường từ rig SDF. Chạy 1 lần ở step đầu (cần `p` mới biết sdf/segments).
   *
   * Mặt nạ tường lấy bằng cách CHẤM THỬ clampWorld ở tâm mỗi ô: điểm bị đẩy đi = điểm đó nằm trong dải tường.
   * Dùng lại đúng hàm hình học của Mode A -> KHÔNG có nguy cơ 2 mode hiểu tường khác nhau.
   */
  private bake(p: SolverParams): void {
    const sdf = p.integrate.sdf;
    const segs = p.integrate.segments;
    const g = 1 / (sdf.worldToLocal[0] || 1);   // local->world scale (ma trận là TRS × Scale đều)

    this.cell = (2 * p.accumulate.uniformRadius) / Math.max(1, MODE_B_TUNING.cellDivisor);

    // bbox phủ TRỌN rig: bề ngang theo bboxHalfX, bề dọc từ đáy vành tới nóc khung.
    const halfX = sdf.bboxHalfX * Math.abs(g);
    const topY = (sdf.wallTop > 0 ? sdf.wallTop : sdf.funnelTopY) * Math.abs(g);
    const botY = -sdf.beltTopY * Math.abs(g) - 4 * this.cell;   // chừa vài ô dưới đáy vành cho lọ hút
    const cx = sdf.localToWorld[12], cy = sdf.localToWorld[13];  // gốc rig trong world

    this.originX = cx - halfX - this.cell;
    this.originY = cy + botY;
    this.nx = Math.ceil((2 * halfX + 2 * this.cell) / this.cell);
    this.ny = Math.ceil((topY - botY) / this.cell);

    const n = this.nx * this.ny;
    this.solid = new Uint8Array(n);
    this.occ = new Int32Array(n).fill(-1);

    for (let gy = 0; gy < this.ny; gy++) {
      for (let gx = 0; gx < this.nx; gx++) {
        const wx = this.originX + (gx + 0.5) * this.cell;
        const wy = this.originY + (gy + 0.5) * this.cell;
        _p.x = wx; _p.y = wy;
        _pPrev.x = wx; _pPrev.y = wy;
        clampWorld(_p, _pPrev, sdf, segs, 0, p.integrate.door, 0);
        const moved = Math.abs(_p.x - wx) + Math.abs(_p.y - wy);
        if (moved > EPS_SOLID) this.solid[gy * this.nx + gx] = 1;
      }
    }
    this.baked = true;
  }

  private idx(gx: number, gy: number): number {
    if (gx < 0 || gy < 0 || gx >= this.nx || gy >= this.ny) return -1;
    return gy * this.nx + gx;
  }

  private free(gx: number, gy: number): boolean {
    const i = this.idx(gx, gy);
    return i >= 0 && this.solid[i] === 0 && this.occ[i] < 0;
  }

  /**
   * Hạt có nằm trong lòng vành (vùng belt) không, và nếu có thì hướng TIẾP TUYẾN vortex CCW là gì.
   * CÙNG công thức vùng + cùng quy ước chiều với integrate.ts (rãnh trên kéo -x, rãnh dưới kéo +x) —
   * lệch chiều ở đây là cát chạy ngược so với Mode A.
   */
  private beltTangent(wx: number, wy: number, sdf: GrainSdfField, out: V2): boolean {
    xformPoint(sdf.worldToLocal, wx, wy, _lp);
    if (Math.abs(_lp.x) > sdf.beltHalfX || Math.abs(_lp.y) > sdf.beltTopY) return false;
    const spineX = _lp.x < -sdf.halfBody ? -sdf.halfBody : (_lp.x > sdf.halfBody ? sdf.halfBody : _lp.x);
    let rx = _lp.x - spineX, ry = _lp.y;
    const len = Math.hypot(rx, ry);
    if (len < 1e-6) { out.x = _lp.y >= 0 ? -1 : 1; out.y = 0; return true; }
    rx /= len; ry /= len;
    // CCW khớp integrate.ts: rãnh TRÊN (r hướng +y) kéo -x, rãnh DƯỚI (r hướng -y) kéo +x -> t = (-ry, rx).
    out.x = -ry; out.y = rx;
    return true;
  }

  /**
   * 1 step CA. Trả về số hạt bị kéo về khi lọt ra ngoài lưới (vai trò escapeGuard của Mode A).
   *
   * Thứ tự: dựng occupancy -> duyệt bottom-up -> mỗi hạt đi tối đa maxCellsPerStep ô, TỪNG ô một
   * (không nhảy) -> ghi positions = tâm ô, velocities = (pos mới - pos cũ)/dt.
   * velocities được ghi THẬT để mọi thứ ngoài solver (gate belt, HUD, đo |v|) đọc được như Mode A.
   */
  step(p: SolverParams): number {
    const pool = this.pool;
    const n = pool.count;
    if (n === 0) return 0;
    if (!this.baked) this.bake(p);

    const sdf = p.integrate.sdf;
    const dt = p.integrate.dt;
    const cell = this.cell;
    const pos = pool.positions, vel = pool.velocities;
    let respawned = 0;

    // --- 1. gán ô + dựng occupancy. Ô đã có chủ -> tìm ô trống gần nhất (xoắn ốc ngắn) thay vì chồng hạt. ---
    this.occ.fill(-1);
    for (let i = 0; i < n; i++) {
      const i2 = i * 2;
      let gx = Math.floor((pos[i2] - this.originX) / cell);
      let gy = Math.floor((pos[i2 + 1] - this.originY) / cell);
      let k = this.idx(gx, gy);
      if (k < 0) {
        // lọt ngoài lưới: kéo về miệng phễu như escapeGuard của Mode A, KHÔNG xoá (xoá = cát bốc hơi).
        xformPoint(sdf.localToWorld, sdf.respawnLocalX, sdf.respawnLocalY, _p);
        pos[i2] = _p.x; pos[i2 + 1] = _p.y;
        vel[i2] = 0; vel[i2 + 1] = 0;
        gx = Math.floor((_p.x - this.originX) / cell);
        gy = Math.floor((_p.y - this.originY) / cell);
        k = this.idx(gx, gy);
        respawned++;
      }
      if (k >= 0 && (this.solid[k] !== 0 || this.occ[k] >= 0)) k = this.nearestFree(gx, gy);
      this.cellOfGrain[i] = k;
      if (k >= 0) this.occ[k] = i;
    }

    // --- 2. thứ tự duyệt bottom-up: hạt thấp đi trước -> ô nó nhường được hạt ngay trên dùng CÙNG pass. ---
    for (let i = 0; i < n; i++) this.order[i] = i;
    const ord = this.order.subarray(0, n);
    const cg = this.cellOfGrain, W = this.nx;
    Array.prototype.sort.call(ord, (a: number, b: number) => {
      const ca = cg[a], cb = cg[b];
      if (ca < 0) return 1;
      if (cb < 0) return -1;
      return (ca / W | 0) - (cb / W | 0);           // hàng thấp (gy nhỏ) trước
    });

    // --- 3. di chuyển ---
    const budget = MODE_B_TUNING.maxCellsPerStep;
    const gravDown = p.integrate.gravityY <= 0;      // gravityY âm = rơi xuống (đúng cấu hình ad)
    const dyFall = gravDown ? -1 : 1;
    this.stepCounter++;

    for (let oi = 0; oi < n; oi++) {
      const i = ord[oi];
      let k = this.cellOfGrain[i];
      if (k < 0) continue;
      const i2 = i * 2;
      const oldX = pos[i2], oldY = pos[i2 + 1];
      let gx = k % W, gy = (k / W) | 0;

      // 3a. trong lòng vành -> đi theo tiếp tuyến belt (đây là chỗ thay servo vortex của Mode A).
      const wx = this.originX + (gx + 0.5) * cell;
      const wy = this.originY + (gy + 0.5) * cell;
      let moved = 0;
      if (this.beltTangent(wx, wy, sdf, _p)) {
        const want = (p.integrate.beltSpeed * MODE_B_TUNING.beltGrip * dt) / cell + this.phase[i];
        let steps = Math.min(budget, Math.floor(want));
        this.phase[i] = want - Math.floor(want);
        const sx = _p.x > 0.3827 ? 1 : (_p.x < -0.3827 ? -1 : 0);   // ±22.5° -> ô kề theo trục
        const sy = _p.y > 0.3827 ? 1 : (_p.y < -0.3827 ? -1 : 0);
        while (steps-- > 0) {
          if (sx === 0 && sy === 0) break;
          if (this.free(gx + sx, gy + sy)) { gx += sx; gy += sy; moved++; continue; }
          if (sx !== 0 && this.free(gx + sx, gy)) { gx += sx; moved++; continue; }
          if (sy !== 0 && this.free(gx, gy + sy)) { gy += sy; moved++; continue; }
          // Tắc tiếp tuyến: vẫn phải RƠI, nếu không hạt treo lơ lửng ở mép kênh (đo 2026-08-24: hạt đứng
          // im tại lx 0.60 vĩnh viễn). Rơi 1 ô rồi thử lại tiếp tuyến vòng sau.
          if (this.free(gx, gy + dyFall)) { gy += dyFall; moved++; continue; }
          break;                                       // nghẽn thật — đúng hành vi cát chen trên băng
        }
      } else {
        // 3b. ngoài vành -> rơi tự do kiểu falling-sand kinh điển: thẳng xuống, kẹt thì trượt chéo.
        this.phase[i] = 0;
        let steps = budget;
        while (steps-- > 0) {
          if (this.free(gx, gy + dyFall)) { gy += dyFall; moved++; continue; }
          if (hash01(i, this.stepCounter) >= MODE_B_TUNING.slideChance) break;
          // thử 2 hướng chéo, thứ tự đảo theo băm -> đụn không lệch 1 phía
          const leftFirst = (hash2(i, this.stepCounter * 7919) & 1) === 0;
          const d1 = leftFirst ? -1 : 1, d2 = -d1;
          if (this.free(gx + d1, gy + dyFall)) { gx += d1; gy += dyFall; moved++; continue; }
          if (this.free(gx + d2, gy + dyFall)) { gx += d2; gy += dyFall; moved++; continue; }
          break;                                        // đứng yên = đã lắng
        }
      }

      if (moved > 0) {
        this.occ[k] = -1;
        k = this.idx(gx, gy);
        this.occ[k] = i;
        this.cellOfGrain[i] = k;
        pos[i2] = this.originX + (gx + 0.5) * cell;
        pos[i2 + 1] = this.originY + (gy + 0.5) * cell;
      }
      // velocities THẬT (kể cả khi đứng yên -> 0) để gate belt / HUD / đo |v| đọc đúng như Mode A.
      vel[i2] = (pos[i2] - oldX) / dt;
      vel[i2 + 1] = (pos[i2 + 1] - oldY) / dt;
    }

    if (Number.isFinite(p.killBelowY)) pool.killBelowY(p.killBelowY);
    return respawned;
  }

  /** Ô trống gần nhất quanh (gx,gy), quét vòng ra ≤3 ring. -1 = chịu (hạt tạm không có ô -> đứng yên step này). */
  private nearestFree(gx: number, gy: number): number {
    for (let r = 1; r <= 3; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;   // chỉ viền của ring
          if (this.free(gx + dx, gy + dy)) return this.idx(gx + dx, gy + dy);
        }
      }
    }
    return -1;
  }

  // --- chẩn đoán (harness belt-probe đọc) ---
  get gridSize(): { nx: number; ny: number; cell: number } {
    return { nx: this.nx, ny: this.ny, cell: this.cell };
  }
  get solidCount(): number {
    let c = 0;
    for (let i = 0; i < this.solid.length; i++) if (this.solid[i]) c++;
    return c;
  }
}
