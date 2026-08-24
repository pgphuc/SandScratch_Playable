// Ghép 1 STEP sim — thứ tự chain lấy nguyên từ GrainFlowBackend (nguồn giữ ĐÚNG 1 Complete()/FixedUpdate):
//
//   [J-1 dilate · J0 buildOccNormals]  (chỉ khi occupancy ĐỔI — xem refreshOccupancy)
//   copyPos -> J1 integrate -> J2 buildNeighborGrid -> J2.5 ccd
//     -> [J3a accumulate -> J3b apply] × iterations
//     -> copyVel -> posFriction -> J4 finalize -> escapeGuard -> killBelowY
//
// File này KHÔNG có toán mới: nó chỉ nối các khối đã port và giữ THỨ TỰ + GATE của nguồn. Mọi chỗ "chỉ chạy khi
// knob>0" đều là gate của nguồn (tắt = mảng liên quan không bị đọc, và hành vi rút về bản trước feature đó).
//
// ⚠ THỨ TỰ LÀ MỘT PHẦN CỦA KẾT QUẢ, không phải chi tiết cài đặt:
// - lưới neighbor build SAU integrate (pos đã dịch) và dùng CHUNG cho ccd/contact/friction/sleep;
// - posPrev là snapshot ĐẦU step (trước integrate) — CCD lẫn posFriction đều đo từ mốc đó;
// - posPredicted ghi ở CUỐI integrate (sau SDF/belt/occ) — finalize suy corr từ đó, đổi mốc là đổi vật lý.

import { GrainParticlePool } from './pool';
import { GrainNeighborGridBuffers, buildNeighborGrid, type GrainCellGrid } from './neighborGrid';
import { integrate, escapeGuard, type IntegrateParams } from './integrate';
import { grainGrainCcd, type CcdParams } from './ccd';
import { buildOccNormals, dilateOccupancy, type GrainOccupancyField } from './occupancy';
import {
  contactAccumulate, contactApply, posFriction, finalize, copyPos, copyVel,
  type AccumulateParams, type ApplyParams, type FinalizeBuffers, type FinalizeParams, type PosFrictionParams,
} from './contact';

export interface SolverParams {
  iterations: number;   // K vòng contact/step
  subdiv: number;       // độ mịn lưới neighbor (cellSize = 2r/subdiv), 1..4
  cellSize: number;     // cellSize GỐC = 2r
  hasSdf: number;       // 1 = chạy escapeGuard sau finalize
  killBelowY: number;   // hạt rơi thấp hơn mức này bị loại -> pool bounded. -Infinity = tắt
  integrate: IntegrateParams;
  ccd: CcdParams;       // ccdGate = 0 -> KHÔNG chạy job (gate của nguồn)
  accumulate: AccumulateParams;
  apply: ApplyParams;
  posFriction: PosFrictionParams;   // frictionPosMu = 0 -> không chạy
  finalize: FinalizeParams;
}

/** Solver 1 pool + toàn bộ mảng phụ, cấp phát 1 LẦN. Vòng step KHÔNG cấp phát. */
export class SandSolver {
  readonly pool = new GrainParticlePool();
  private grid!: GrainNeighborGridBuffers;
  private posPredicted!: Float32Array;
  private posPrev!: Float32Array;
  private velSnap!: Float32Array;
  private frictionDelta!: Float32Array;
  private delta!: Float32Array;
  private finBuf!: FinalizeBuffers;

  /** Lưới neighbor của step VỪA chạy — renderer/diag đọc được, không phải build lại. */
  cellGrid!: GrainCellGrid;

  alloc(capacity: number): void {
    this.pool.alloc(capacity);
    this.grid = new GrainNeighborGridBuffers(capacity);
    this.posPredicted = new Float32Array(capacity * 2);
    this.posPrev = new Float32Array(capacity * 2);
    this.velSnap = new Float32Array(capacity * 2);
    this.frictionDelta = new Float32Array(capacity * 2);
    this.delta = new Float32Array(capacity * 2);
    this.finBuf = {
      posPredicted: this.posPredicted,
      velSnap: this.velSnap,
      frictionDelta: this.frictionDelta,
    };
  }

  /**
   * Chạy 1 step. Trả về số hạt bị escape-guard giật về miệng phễu (0 là bình thường; lớn = tường đang rò).
   * ⚠ Gọi refreshOccupancy() TRƯỚC khi step nếu snapshot tranh vừa đổi (swipe cào pixel).
   */
  step(p: SolverParams): number {
    const pool = this.pool;
    const n = pool.count;
    if (n === 0) return 0;

    const needPosPrev = p.ccd.ccdGate > 0 || p.posFriction.frictionPosMu > 0;
    if (needPosPrev) copyPos(pool.positions, this.posPrev, n);

    integrate(pool.positions, pool.velocities, this.posPredicted, pool.ghost, pool.ghostReleaseY,
              n, p.integrate);

    // Lưới build TRÊN pos SAU integrate — mọi consumer neighbor dưới đây dùng CHUNG nó.
    this.cellGrid = buildNeighborGrid(this.grid, pool.positions, n, p.cellSize, p.subdiv);

    if (p.ccd.ccdGate > 0) {
      grainGrainCcd(pool.positions, this.posPrev, pool.velocities, pool.radii, n,
                    this.cellGrid, this.grid.cellStart, this.grid.entryIdx, p.ccd);
    }

    for (let k = 0; k < p.iterations; k++) {
      contactAccumulate(pool.positions, pool.velocities, pool.radii, this.delta, n,
                        this.cellGrid, this.grid.cellStart, this.grid.entryIdx, p.accumulate);
      contactApply(pool.positions, this.delta, pool.ghost, n, p.apply);
    }

    if (p.finalize.frictionVelocity > 0) copyVel(pool.velocities, this.velSnap, n);
    if (p.posFriction.frictionPosMu > 0) {
      posFriction(pool.positions, this.posPrev, this.posPredicted, pool.radii, this.frictionDelta, n,
                  this.cellGrid, this.grid.cellStart, this.grid.entryIdx, p.posFriction);
    }

    finalize(pool.positions, pool.velocities, pool.radii, pool.ghost, n,
             this.cellGrid, this.grid.cellStart, this.grid.entryIdx, this.finBuf, p.finalize);

    // escapeGuard chạy TRƯỚC killBelowY -> hạt lọt đáy được tái tuần hoàn thay vì bị kill (đổi vai killBelowY:
    // giờ chỉ còn là backstop cho hạt SDF-off / runaway).
    let respawned = 0;
    if (p.hasSdf !== 0) {
      respawned = escapeGuard(pool.positions, pool.velocities, n, p.integrate.sdf);
    }
    if (Number.isFinite(p.killBelowY)) pool.killBelowY(p.killBelowY);
    return respawned;
  }
}

/**
 * Rebuild 2 dẫn xuất của occupancy khi tranh vừa đổi (swipe cào pixel): bản DILATE (bù bán kính hạt cho DDA điểm-tâm)
 * + NORMAL FIELD macro (thay 81 sample tại chỗ mỗi lần chạm).
 * `dilateCells = 0` -> `snapshot` dùng thẳng bản raw (caller truyền TRÙNG 1 mảng vào solver) = bit-identical.
 *
 * Nguồn rebuild MỖI STEP và CỐ Ý KHÔNG dirty-track (snapshot vốn đã full-copy mỗi step): rebuild-mỗi-step khử luôn 3
 * nguồn stale mà dirty-track sẽ phải bắt từng cái — (a) occupancy đổi khi convert, (b) smoothRadius đọc LIVE,
 * (c) colScrollPy chạy làm RevealOyMin đổi ⇒ normal quanh mép lộ đổi DÙ không carve.
 */
export function refreshOccupancy(occ: GrainOccupancyField, raw: Uint8Array, dilated: Uint8Array,
                                 normals: Float32Array): void {
  if (occ.dilateCells > 0) dilateOccupancy(raw, dilated, occ.occWidth, occ.occHeight, occ.dilateCells);
  buildOccNormals(occ, dilated, normals);
}
