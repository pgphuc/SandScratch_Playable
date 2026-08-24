// PORT Mode A — nguồn: ir/code/!_Game_SDK/SandFlow/Flow/Grain/GrainContactJobs.cs (876).
//
// Contact hạt-hạt: PBD/DEM Jacobi để cát XẾP ĐỐNG. Chuỗi 1 step (nguồn giữ ĐÚNG 1 Complete()/FixedUpdate):
//   copyPos -> integrate(J1) -> buildGrid(J2) -> ccd(J2.5) -> [accumulate(J3a) -> apply(J3b)]×K
//   -> copyAsleep/copyVel -> posFriction -> finalize(J4) -> escapeGuard
//
// Model HYBRID DEM: GIỮ velocity tường minh + SDF + belt của integrate. Contact = đẩy VỊ TRÍ (Jacobi), rồi finalize
// HÃM INELASTIC (giết phần vận tốc đâm vào đống) -> cát NẶNG, KHÔNG bật lại. Không cần Verlet/prevPos.
//
// LỆCH SO VỚI NGUỒN (có chủ ý):
// - CHỈ port đường LƯỚI ROW-MAJOR (useGrid=1); đường hashmap bỏ (nguồn ghi rõ hashmap ĐẾM ĐÔI — xem README).
// - BỎ toàn bộ giàn ĐO/PROBE: diagCand/diagContact/diagPen*/diagClamp/localityProbe/usePacked + 3 job pack
//   (GrainNeighborPack*). Chúng là công cụ đo hiệu năng của Burst (cache locality, gather ngẫu nhiên) — nguồn tự
//   chứng minh chúng BIT-IDENTICAL với đường sống, và bài toán chúng phục vụ không tồn tại trong JS. Kết quả sim
//   KHÔNG đổi. (Nếu sau này cần đo lại: chúng ở nhánh `usePacked`/`diagOn` của file nguồn.)
// - IJobParallelFor -> vòng `for`. Jacobi vẫn ĐÚNG vì mỗi Execute(i) chỉ ghi index i và đọc mảng KHÁC (delta ghi ở
//   J3a, positions ghi ở J3b) — thứ tự duyệt không đổi kết quả.
//
// ⛔ 4 LEVER ĐÃ BỊ NGUỒN BÁC — ĐỪNG DỰNG LẠI (mỗi cái đều tốn 1 vòng play-test):
//   · cap mẫu số relax (`relaxCap`): `dN` là TỔNG VECTOR từ ~18 hàng xóm ĐỐI NHAU nên tự khử (|dN| ~ 1/6 pen) =>
//     mọi núm VÔ HƯỚNG trên dN (mẫu số · stiffness · maxPush) KHÔNG đụng được mật độ;
//   · `maxFallSpeed` kẹp |v.y| khi rơi: hạ TỐC RƠI THẬT = đổi cảm giác gravity. Lever đúng là intruderBias (tầng
//     contact), không phải tầng vận tốc;
//   · friction tầng VỊ TRÍ mà KHÔNG ghi ngược vào v: kéo p mà v không biết = DÂY CHUN, càng khoẻ càng rung;
//   · proxy tải `corrN` (cộng dồn dN qua K vòng): cùng bẫy "cộng vector tự khử" — μ gấp 3 mà hành vi y nguyên.

import { clampWorld, clampWorldGrid, normalizeSafe, xformPoint,
         type GrainSdfField, type GrainWallGrid, type V2 } from './sdfWalls';
import { rowSpan, TALLY_SLACK, type GrainCellGrid, type Span } from './neighborGrid';
import { sweepBlocked, type GrainOccupancyField } from './occupancy';

const _span: Span = { begin: 0, end: 0 };
const _p: V2 = { x: 0, y: 0 };
const _v: V2 = { x: 0, y: 0 };
const _pPrev: V2 = { x: 0, y: 0 };
const _lp: V2 = { x: 0, y: 0 };
const _g: V2 = { x: 0, y: 0 };

/** 'ở cạnh' = distance < (ri+rj)·slack. CÙNG hằng với lưới (nó quyết ringSlack lúc build) — lệch = phủ THIẾU im lặng. */
const NEIGHBOR_SLACK = TALLY_SLACK;

/** Đủ neighbor ở cả 4 quadrant. */
const FULL_QUAD_MASK = 0xf;

/** Băm 2 int -> uint (Unity math.hash(int2)) — chỉ dùng cho hướng tách cặp TRÙNG TÂM, không dùng làm khoá ô. */
function hashInt2(a: number, b: number): number {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  return h >>> 0;
}

// --- J3a: accumulate ------------------------------------------------------------------------------------------------

export interface AccumulateParams {
  stiffness: number;      // < 1 = gỡ chồng lấn DẦN (mềm, ít bắn tung)
  softness: number;       // 0 = SUM (cứng, gỡ overlap mạnh) .. 1 = AVERAGE theo contact-count (mềm/ổn định)
  maxPush: number;        // clamp |Δpos|/iter — chống nổ + không đẩy qua tường trong 1 nhịp
  intruderBias: number;   // 0 = share 50/50; >0 = chia pen theo tốc độ 2 bên
  uniformRadius: number;  // radii[] là HẰNG -> scalar, bỏ gather ngẫu nhiên
}

/**
 * Jacobi accumulate: query các ô quanh hạt i, neighbor chồng lấn (d < ri+rj) -> cộng correction penetration-share vào
 * delta[i]. Hạt j cũng tự cộng nửa của nó ở lượt j -> đối xứng.
 * ⚠ Test chồng lấn Ở ĐÂY mỗi iter, KHÔNG cache theo cặp: tập chồng lấn đổi giữa các iter (pos dịch mỗi iter).
 */
export function contactAccumulate(positions: Float32Array, velocities: Float32Array, radii: Float32Array,
                                  asleep: Uint8Array, delta: Float32Array, count: number,
                                  grid: GrainCellGrid, cellStart: Int32Array, entryIdx: Int32Array,
                                  p: AccumulateParams): void {
  const ring = grid.ring;
  const cell = grid.cellSize;

  for (let i = 0; i < count; i++) {
    const i2 = i * 2;
    // Hạt ngủ: bỏ query neighbor (chi phí LỚN nhất pipeline) — delta=0 -> apply không dịch nó.
    if (asleep[i] !== 0) { delta[i2] = 0; delta[i2 + 1] = 0; continue; }

    const pix = positions[i2], piy = positions[i2 + 1];
    const ri = radii[i];
    let dNx = 0, dNy = 0;      // tổng đẩy PHÁP TUYẾN vòng này
    let nc = 0;                // số contact — để TRUNG BÌNH (under-relaxation), KHÔNG cộng dồn
    // (INTRUDER-BIAS) hoist — bias=0 thì không đụng velocities
    const spdI = p.intruderBias > 0 ? Math.hypot(velocities[i2], velocities[i2 + 1]) : 0;

    const cgx = Math.floor(pix / cell), cgy = Math.floor(piy / cell);
    for (let dy = -ring; dy <= ring; dy++) {
      // Các ô liền nhau của 1 hàng = 1 DẢI LIÊN TỤC -> (2·ring+1) dải thay probe ngẫu nhiên, 0 hash, 0 lọc.
      if (!rowSpan(grid, cellStart, cgy + dy, cgx - ring, cgx + ring, _span)) continue;
      for (let e = _span.begin; e < _span.end; e++) {
        const j = entryIdx[e];
        if (j === i) continue;
        const j2 = j * 2;
        const diffX = pix - positions[j2];
        const diffY = piy - positions[j2 + 1];
        const rsum = ri + p.uniformRadius;
        const dist2 = diffX * diffX + diffY * diffY;
        if (dist2 >= rsum * rsum) continue;          // không chồng -> bỏ qua
        let dirX: number, dirY: number, pen: number;
        if (dist2 > 1e-8) {
          const dist = Math.sqrt(dist2);
          dirX = diffX / dist; dirY = diffY / dist;
          pen = rsum - dist;
        } else {
          // TRÙNG tâm: guard cũ BỎ QUA -> cặp kẹt chồng CẢ HẠT vĩnh viễn (sinh từ emit cùng điểm). Đẩy tách theo
          // hướng XÁC ĐỊNH ĐỐI XỨNG: hash(min,max) -> góc cố định cho cặp; dấu theo i<j -> 2 lượt tách NGƯỢC chiều.
          const hp = hashInt2(Math.min(i, j), Math.max(i, j));
          const ang = (hp & 8191) * (6.2831853 / 8192);
          const dpx = Math.cos(ang), dpy = Math.sin(ang);
          dirX = i < j ? dpx : -dpx;
          dirY = i < j ? dpy : -dpy;
          pen = rsum;                                 // tách 1 đường kính (maxPush clamp overshoot)
        }
        // Neighbor j NGỦ = tường (nó KHÔNG tự đẩy nửa của mình vì đã early-out) -> i nhận FULL pen, không half.
        const sleepJ = asleep[j] !== 0;
        let share = sleepJ ? 1 : 0.5;
        // (INTRUDER-BIAS) j THỨC: chia pen theo AI ĐANG ĐỘNG thay vì 50/50 cứng. Hạt rơi đâm vào đụn thì 50/50 đẩy
        // ĐỤN ra đúng bằng lượng đẩy hạt lên => đụn NỞ SANG 2 BÊN, hạt chen vào giữa. TỔNG 2 bên = 1 LUÔN LUÔN
        // (lượt j tính đúng phần bù) => Jacobi vẫn đối xứng, KHÔNG bơm năng lượng — chỉ CHIA LẠI pen, không cộng xung.
        // Dòng chảy đều (belt, cột cát cùng rơi): spdI≈spdJ => 0.5 => hành vi y nguyên.
        if (p.intruderBias > 0 && !sleepJ) {
          const denom = spdI + Math.hypot(velocities[j2], velocities[j2 + 1]);
          const ratio = denom > 1e-6 ? spdI / denom : 0.5;   // cả 2 gần đứng yên -> giữ 50/50
          share = 0.5 + p.intruderBias * (ratio - 0.5);
        }
        const k = share * p.stiffness * pen;
        dNx += dirX * k;                              // penetration-share, đẩy i RA khỏi j
        dNy += dirY * k;
        nc++;
      }
    }

    // RELAXATION dial: denom = 1 + softness·(nc-1). softness=0 -> SUM (cứng, hết lún, dễ jitter -> settleDamping bù);
    // softness=1 -> AVERAGE (mềm/ổn định). ⚠ CHIA (không nhân nghịch đảo) — 1/denom rồi nhân cho kết quả float KHÁC.
    if (nc > 0) {
      const denom = 1 + p.softness * (nc - 1);
      dNx /= denom; dNy /= denom;
    }
    const dl = Math.sqrt(dNx * dNx + dNy * dNy);
    if (dl > p.maxPush) {                             // clamp bước đẩy — chống nổ + không vượt tường/nhịp
      const k = p.maxPush / dl;
      dNx *= k; dNy *= k;
    }
    delta[i2] = dNx;
    delta[i2 + 1] = dNy;
  }
}

// --- J3b: apply -----------------------------------------------------------------------------------------------------

export interface ApplyParams {
  dt: number;
  hasOcc: number;
  occ: GrainOccupancyField;
  occSnapshot: Uint8Array;
  occSnapshotRaw: Uint8Array;
  occNormals: Float32Array;      // slip=0 ở đây -> KHÔNG bị đọc; vẫn truyền cho khớp chữ ký
  hasSdf: number;
  sdf: GrainSdfField;
  segments: Float32Array;
  hasDoor: number;
  door: Float32Array;
  wallCompliance: number;        // độ NHƯỢNG tường trong vòng contact; 0 = cứng = hành vi cũ
  wallGrid: GrainWallGrid;
  wallCellStart: Int32Array;
  wallCellItems: Int32Array;
}

/**
 * Áp correction (Jacobi apply) + PREVENT-ENTRY sweep MỖI iter.
 *
 * VÌ SAO sweep TẠI ĐÂY chứ không chỉ ở finalize: finalize sweep MỘT đoạn thẳng posPredicted->pos SAU toàn bộ K iter
 * => tổng dịch chuyển K-iter có thể ROUTING QUA KHE tranh (đường thẳng net né được occupied-cell mà từng bước iter
 * thật sự đâm vào) => hụt, hạt lọt vào. Sweep incremental pPrev->pPrev+delta MỖI iter chặn TỪNG bước.
 * POSITION-ONLY: v scratch + slip=0 -> chỉ chặn vị trí, KHÔNG nhiễu velocity-feedback (finalize lo hãm inelastic 1
 * lần trên corr tổng).
 */
export function contactApply(positions: Float32Array, delta: Float32Array, asleep: Uint8Array, ghost: Uint8Array,
                             count: number, p: ApplyParams): void {
  for (let i = 0; i < count; i++) {
    if (asleep[i] !== 0) continue;                 // không dịch hạt ngủ
    const i2 = i * 2;
    _pPrev.x = positions[i2];                      // occupancy-clean (sweep iter trước / integrate per-substep)
    _pPrev.y = positions[i2 + 1];
    _p.x = _pPrev.x + delta[i2];
    _p.y = _pPrev.y + delta[i2 + 1];
    if (p.hasOcc !== 0 && ghost[i] === 0) {
      _v.x = 0; _v.y = 0;                          // discard: chỉ clamp vị trí, KHÔNG đụng velocities pool
      sweepBlocked(_p, _v, _pPrev, p.occ, p.occSnapshot, p.occSnapshotRaw, p.occNormals, p.dt, 0, 0, 0);
    }
    // TƯỜNG SDF trong vòng contact. Trước đây vòng này CHỈ sweep occupancy mà KHÔNG kiểm tường ⇒ maxPush×iters
    // (0.15×6 = 0.9 world) vượt hẳn dải tường thr≈0.62 ⇒ riêng contact-push tống hạt xuyên khung tranh trong 1 frame,
    // và CCD của integrate bắt hụt (mốc pPrev của nó = pos SAU contact frame trước = đã ở NGOÀI). Clamp ở ĐÂY thì
    // pPrev = pos TRƯỚC bước đẩy này = còn hợp lệ ⇒ CCD ăn.
    if (p.hasSdf !== 0) {
      if (p.wallGrid.enabled !== 0) {
        clampWorldGrid(_p, _pPrev, p.sdf, p.segments, p.hasDoor, p.door, p.wallCompliance,
                       p.wallGrid, p.wallCellStart, p.wallCellItems);
      } else {
        clampWorld(_p, _pPrev, p.sdf, p.segments, p.hasDoor, p.door, p.wallCompliance);
      }
    }
    positions[i2] = _p.x;
    positions[i2 + 1] = _p.y;
  }
}

// --- snapshot (chống race bên nguồn; ở đây là mốc ĐO, giữ vì semantics phụ thuộc nó) ---------------------------------

/** Snapshot positions ĐẦU step (TRƯỚC integrate) — mốc đo dịch chuyển tiếp tuyến cả frame cho posFriction. */
export function copyPos(positions: Float32Array, snapshot: Float32Array, count: number): void {
  for (let i = 0; i < count * 2; i++) snapshot[i] = positions[i];
}

/** Snapshot asleep TRƯỚC finalize — frictionPair đọc trạng thái ngủ ĐẦU frame (share ½ vs 1). */
export function copyAsleep(asleep: Uint8Array, snapshot: Uint8Array, count: number): void {
  for (let i = 0; i < count; i++) snapshot[i] = asleep[i];
}

/**
 * Snapshot velocities TRƯỚC finalize. Hạt NGỦ snapshot = 0: đống tĩnh — vật lý nó đứng yên, v lưu trong pool là dư âm
 * lúc thiếp đi => hạt thức tựa đống ngủ trượt so với ĐẤT => ma sát TĨNH ăn.
 */
export function copyVel(velocities: Float32Array, asleep: Uint8Array, snapshot: Float32Array, count: number): void {
  for (let i = 0; i < count; i++) {
    const i2 = i * 2;
    const z = asleep[i] !== 0;
    snapshot[i2] = z ? 0 : velocities[i2];
    snapshot[i2 + 1] = z ? 0 : velocities[i2 + 1];
  }
}

// --- posFriction (friction Coulomb per-pair tầng VỊ TRÍ) --------------------------------------------------------------

export interface PosFrictionParams {
  frictionPosMu: number;   // μₚ ≈ tan góc nghỉ; cap = μₚ·pen (đơn vị VỊ TRÍ, KHÔNG /dt)
  uniformRadius: number;
}

/**
 * Vế đóng khe hở "solver lai": contact giải bằng VỊ TRÍ nhưng dịch chuyển không ghi vào v ⇒ creep tiếp tuyến
 * g·dt²·sinθ trượt ở tầng vị trí THUẦN — friction VẬN TỐC mù với nó, còn friction VỊ TRÍ KHÔNG ghi-ngược = dây chun.
 * Ở đây đo TRỰC TIẾP dịch chuyển tiếp tuyến tương đối cả frame (positions - posPrev, per-pair) rồi kéo lùi kiểu
 * Coulomb; phần kéo lùi được finalize cộng vào v ⇒ cả hai tầng cùng về 0 ⇒ cân bằng tĩnh thật, sleep ăn được.
 * 1 PASS SAU vòng contact (creep là đại lượng per-frame ~1/16 bán kính/frame — 1 pass đủ triệt).
 * pen + n̂ đo tại posPredicted (SAU gravity TRƯỚC solver = tải THẬT per-contact; đo tại positions post-solver thì
 * pen≈0).
 */
export function posFriction(positions: Float32Array, posPrev: Float32Array, posPredicted: Float32Array,
                            radii: Float32Array, asleep: Uint8Array, frictionDelta: Float32Array, count: number,
                            grid: GrainCellGrid, cellStart: Int32Array, entryIdx: Int32Array,
                            p: PosFrictionParams): void {
  const ring = grid.ring;
  const cell = grid.cellSize;

  for (let i = 0; i < count; i++) {
    const i2 = i * 2;
    if (asleep[i] !== 0) {                     // hạt ngủ không tự kéo (vẫn là ĐẤT cho neighbor thức qua share)
      frictionDelta[i2] = 0; frictionDelta[i2 + 1] = 0;
      continue;
    }
    const pix = posPredicted[i2], piy = posPredicted[i2 + 1];
    const ri = radii[i];
    let impX = 0, impY = 0;
    let cnt = 0;
    const moveIx = positions[i2] - posPrev[i2];
    const moveIy = positions[i2 + 1] - posPrev[i2 + 1];

    const cgx = Math.floor(pix / cell), cgy = Math.floor(piy / cell);
    for (let dy = -ring; dy <= ring; dy++) {
      if (!rowSpan(grid, cellStart, cgy + dy, cgx - ring, cgx + ring, _span)) continue;
      for (let e = _span.begin; e < _span.end; e++) {
        const j = entryIdx[e];
        if (j === i) continue;
        const j2 = j * 2;
        const diffX = pix - posPredicted[j2];
        const diffY = piy - posPredicted[j2 + 1];
        const rsum = ri + p.uniformRadius;
        const dist2 = diffX * diffX + diffY * diffY;
        if (dist2 >= rsum * rsum || dist2 <= 1e-8) continue;   // không chồng lấn (hoặc trùng tâm) -> không contact
        const dist = Math.sqrt(dist2);
        const nx = diffX / dist, ny = diffY / dist;
        const pen = rsum - dist;
        // Δ = dịch chuyển tương đối frame này (j ngủ không dịch nên vế j tự = 0).
        const dxAll = moveIx - (positions[j2] - posPrev[j2]);
        const dyAll = moveIy - (positions[j2 + 1] - posPrev[j2 + 1]);
        const dn = dxAll * nx + dyAll * ny;
        const dTx = dxAll - dn * nx;            // phần TRƯỢT tiếp tuyến thực tế của cặp, frame này
        const dTy = dyAll - dn * ny;
        const lT = Math.sqrt(dTx * dTx + dTy * dTy);
        if (lT <= 1e-6) continue;               // không trượt tương đối -> ma sát 0
        // share: với ĐẤT (j ngủ) phải FULL, không thì v* = g_t·dt trượt vĩnh viễn.
        const share = asleep[j] !== 0 ? 1 : 0.5;
        // Hạt rơi SƯỢT: |Δt| lớn nhưng pen bé -> cap μₚ·pen bé -> gần như không đụng cú rơi (Coulomb tự bảo vệ).
        const mag = Math.min(share * lT, p.frictionPosMu * pen);
        impX += (dTx / lT) * mag;
        impY += (dTy / lT) * mag;
        cnt++;
      }
    }
    if (cnt > 0) {                              // dấu ÂM: kéo NGƯỢC chiều trượt; chia TB (Jacobi under-relaxation)
      frictionDelta[i2] = -impX / cnt;
      frictionDelta[i2 + 1] = -impY / cnt;
    } else {
      frictionDelta[i2] = 0; frictionDelta[i2 + 1] = 0;
    }
  }
}

// --- J4: finalize ------------------------------------------------------------------------------------------------------

export interface FinalizeParams {
  dt: number;
  damping: number;         // 1 = inelastic hẳn; 0 = không hãm (chồng tái diễn)
  /**
   * TRẦN cho damping theo quãng contact THỰC SỰ chặn được (|corr|/dt × mul). 0 = TẮT = bit-identical bản cũ.
   * Bản gốc giết damping×vn BẤT KỂ corr to hay bé => hạt đang RƠI chỉ SƯỢT hạt khác (corr ~0.005 world) cũng bị xoá
   * 90% TOÀN BỘ tốc rơi ⇒ KHỰNG 1 nhịp giữa không trung.
   */
  absorbCapMul: number;
  frictionVelocity: number;    // μᵥ ≈ tan(góc nghỉ); 0 = TẮT
  frictionSurfaceDrag: number; // SÀN cho cap friction, ĐỘC LẬP pen — chạm được LỚP MẶT (nơi pen≈0 nên μᵥ tự triệt)
  frictionPos: number;         // >0 = áp frictionDelta vào p VÀ ghi ngược v += fd/dt
  settleDamping: number;       // bleed vận tốc đẳng hướng/step -> dập jitter dư đáy đống
  gravityX: number;
  gravityY: number;

  hasOcc: number;
  occ: GrainOccupancyField;
  occSnapshot: Uint8Array;
  occSnapshotRaw: Uint8Array;
  occNormals: Float32Array;
  occSlip: number;

  hasSdf: number;
  sdf: GrainSdfField;
  gapBeltTopY: number;

  sleepEnabled: number;
  quadrantSleep: number;   // 0 = KHÔNG hạt nào ngủ MỚI (killswitch); hạt đang ngủ giữ nguyên
  sleepDelaySteps: number;
  uniformRadius: number;
}

/** Mảng phụ mà finalize cần (snapshot + delta friction). */
export interface FinalizeBuffers {
  posPredicted: Float32Array;
  velSnap: Float32Array;        // chỉ đọc khi frictionVelocity > 0
  asleepSnapshot: Uint8Array;   // chỉ đọc khi frictionVelocity > 0
  frictionDelta: Float32Array;  // chỉ đọc khi frictionPos > 0
  quadFrames: Int32Array;
}

/**
 * post-contact: occupancy clamp (contact có thể đẩy hạt VÀO tranh) + damp vận tốc INELASTIC + friction + quyết định
 * NGỦ. `corr` = tổng dịch chuyển kể từ posPredicted = hướng contact/occ đẩy hạt RA; GIẾT phần vận tốc ĐÂM VÀO đống
 * theo damping -> cát NẶNG, KHÔNG bật lại (khác cộng rebound corr/dt = nảy tung + văng xuyên tường).
 */
export function finalize(positions: Float32Array, velocities: Float32Array, radii: Float32Array,
                         asleep: Uint8Array, ghost: Uint8Array, count: number,
                         grid: GrainCellGrid, cellStart: Int32Array, entryIdx: Int32Array,
                         buf: FinalizeBuffers, p: FinalizeParams): void {
  const posPredicted = buf.posPredicted;

  for (let i = 0; i < count; i++) {
    const i2 = i * 2;

    if (asleep[i] !== 0) {
      // WAKE = HỤT QUADRANT: hạt ngủ re-check phủ 4 quadrant mỗi frame. Hạt dưới bị drain -> hạt trên hụt quadrant
      // DƯỚI -> thức -> dây chuyền dưới-lên. Thức từ frame SAU (integrate frame này đã skip nó rồi).
      if (p.quadrantSleep !== 0) {
        // (region-gate) lọt vùng belt (cửa mở nâng trần đổi vùng) -> thức vô điều kiện; ngoài belt -> re-check.
        if (inConveyor(positions[i2], positions[i2 + 1], p)) {
          asleep[i] = 0;
          buf.quadFrames[i] = 0;
        } else if (countNeighbors(i, posPredicted, radii, count, grid, cellStart, entryIdx, p) !== FULL_QUAD_MASK) {
          asleep[i] = 0;
          buf.quadFrames[i] = 0;
        }
      }
      continue;   // vẫn ngủ (hoặc vừa thức, đợi frame sau integrate): giữ nguyên pos/vel, không finalize
    }

    _p.x = positions[i2]; _p.y = positions[i2 + 1];
    _v.x = velocities[i2]; _v.y = velocities[i2 + 1];

    // Áp kéo lùi friction VÀO p TRƯỚC sweep -> prevent-entry chặn luôn nếu fd đẩy vào tranh. Gate frictionPos>0 để
    // KHÔNG cộng fd=(0,0) vào p (IEEE: -0 + +0 = +0 -> mất bit-identical trên component đúng -0.0).
    let fdx = 0, fdy = 0;
    if (p.frictionPos > 0) {
      fdx = buf.frictionDelta[i2]; fdy = buf.frictionDelta[i2 + 1];
      _p.x += fdx; _p.y += fdy;
    }

    // PREVENT-ENTRY sau contact: sweep posPredicted (pre-contact, đã picture-free) -> p (post-contact) để
    // contact-push KHÔNG đẩy hạt lọt vào tranh.
    if (p.hasOcc !== 0 && ghost[i] === 0) {
      _pPrev.x = posPredicted[i2]; _pPrev.y = posPredicted[i2 + 1];
      sweepBlocked(_p, _v, _pPrev, p.occ, p.occSnapshot, p.occSnapshotRaw, p.occNormals,
                   p.dt, p.gravityX, p.gravityY, p.occSlip);
    }

    // LOẠI fd khỏi corr để normal-damping thấy đúng phần solver (friction có kênh ghi-ngược riêng).
    const corrX = _p.x - posPredicted[i2] - fdx;
    const corrY = _p.y - posPredicted[i2 + 1] - fdy;
    const cl = Math.sqrt(corrX * corrX + corrY * corrY);
    if (cl > 1e-6) {
      const cnx = corrX / cl, cny = corrY / cl;
      const vn = _v.x * cnx + _v.y * cny;          // <0 = hạt đang ĐÂM ngược vào đống
      if (vn < 0) {
        // TRẦN theo phần contact THỰC SỰ hấp thụ. Contact chỉ chặn được đúng |corr|/dt ⇒ cap về đó: hạt trong đống
        // chịu áp lực (corr lớn) vẫn hãm FULL ⇒ overlap KHÔNG xấu đi; cú sượt lúc rơi gần như không bị đụng tới.
        // ⚠ ĐỪNG thay bằng hãm theo vận tốc TƯƠNG ĐỐI: đã play-test BÁC — vế absolute này CÒN là phép CHIẾU VẬN TỐC
        // của PBD (thứ DUY NHẤT báo cho hạt biết solver vừa chặn nó). Bỏ nó ⇒ cả đống cùng tích gravity (v tương đối
        // ~0 nên không ai hãm ai) ⇒ overlap NẶNG HƠN damping=0.
        let kill = -vn;
        if (p.absorbCapMul > 0) kill = Math.min(kill, p.absorbCapMul * cl / p.dt);
        _v.x += p.damping * kill * cnx;            // inelastic — KHÔNG cộng rebound
        _v.y += p.damping * kill * cny;
      }
    }

    // MA SÁT Coulomb PER-PAIR trên vận tốc TƯƠNG ĐỐI. 3 LỚP video ref TỰ SINH, không classifier: hạt-tường/tranh
    // KHÔNG phải cặp hạt-hạt => layer sát mặt trượt tự do · đỉnh đụn ít contact + pen bé => avalanche · lõi cột pen
    // lớn => trần lớn => khoá. μᵥ ≈ tan góc nghỉ.
    if (p.frictionVelocity > 0) {
      applyPairFriction(i, _v, posPredicted, radii, buf.velSnap, buf.asleepSnapshot, count,
                        grid, cellStart, entryIdx, p);
    }
    // GHI NGƯỢC phần friction vào v — chỉ Δp friction, KHÔNG đụng pháp tuyến (vế corr/dt pháp tuyến đã bác vì nảy
    // tung). Đây là cách canonical PBD: cả tầng vị trí lẫn vận tốc cùng thấy ma sát -> cân bằng tĩnh thật.
    if (p.frictionPos > 0) { _v.x += fdx / p.dt; _v.y += fdy / p.dt; }
    // SETTLE: bleed đẳng hướng -> tiêu tán dao động dư ở đáy đống + hạt kẹt khe. Belt/rơi được tái nạp mỗi step nên
    // ít ảnh hưởng; chủ yếu ăn dao động nhỏ của hạt gần đứng yên.
    if (p.settleDamping > 0) {
      const k = Math.max(0, Math.min(1, 1 - p.settleDamping * p.dt));
      _v.x *= k; _v.y *= k;
    }
    positions[i2] = _p.x; positions[i2 + 1] = _p.y;
    velocities[i2] = _v.x; velocities[i2 + 1] = _v.y;

    // QUYẾT ĐỊNH ngủ: (1) NGOÀI vùng conveyor (belt vortex kéo liên tục, ngủ trong đó = kẹt treo) + (2) phủ đủ 4
    // quadrant LIÊN TỤC sleepDelaySteps step (hysteresis chống ngủ nhầm hạt giữa dòng chảy dày bị vây TẠM).
    // Lớp MẶT hụt quadrant TRÊN -> không bao giờ ngủ (CỐ Ý: mặt thoáng phải thức để creep).
    if (p.sleepEnabled !== 0 && p.quadrantSleep !== 0) {
      if (inConveyor(_p.x, _p.y, p)) {
        buf.quadFrames[i] = 0;
      } else if (countNeighbors(i, posPredicted, radii, count, grid, cellStart, entryIdx, p) !== FULL_QUAD_MASK) {
        buf.quadFrames[i] = 0;
      } else {
        const qf = buf.quadFrames[i] + 1;
        buf.quadFrames[i] = qf;
        if (qf >= p.sleepDelaySteps) asleep[i] = 1;
      }
    }
  }
}

/**
 * Hạt world-pos có nằm trong vùng CONVEYOR không — CÙNG bbox belt local với vortex của integrate. Trần hạ xuống
 * gapBeltTopY trong dấu chân miệng phễu |lx|<=wallX khi cửa đóng -> crest lắng dưới cửa vẫn ngủ được.
 */
function inConveyor(px: number, py: number, p: FinalizeParams): boolean {
  if (p.hasSdf === 0) return false;
  xformPoint(p.sdf.worldToLocal, px, py, _lp);
  const beltTopHere = Math.abs(_lp.x) <= p.sdf.wallX ? p.gapBeltTopY : p.sdf.beltTopY;
  return Math.abs(_lp.x) <= p.sdf.beltHalfX && _lp.y <= beltTopHere && _lp.y >= -p.sdf.beltTopY;
}

/**
 * Quét hàng xóm quanh hạt i -> quadMask (bit theo quadrant có neighbor, khung GRAVITY). Đếm MỌI neighbor (thức LẪN
 * ngủ). Dùng posPredicted (== positions lúc build lưới) -> cùng ô + KHÔNG race với positions[i].
 * ⚠ Tally hỏi R = 2r·NEIGHBOR_SLACK chứ không phải 2r => dùng ringSlack, KHÔNG dùng ring.
 */
function countNeighbors(i: number, posPredicted: Float32Array, radii: Float32Array, count: number,
                        grid: GrainCellGrid, cellStart: Int32Array, entryIdx: Int32Array,
                        p: FinalizeParams): number {
  let quadMask = 0;
  const i2 = i * 2;
  const pix = posPredicted[i2], piy = posPredicted[i2 + 1];
  const ri = radii[i];
  _g.x = p.gravityX; _g.y = p.gravityY;
  normalizeSafe(_g);                                // gravity~0 -> gDir=0 -> mask không bao giờ đủ
  const gDirX = _g.x, gDirY = _g.y;
  const gPerpX = -gDirY, gPerpY = gDirX;            // trục vuông góc gravity — khung chia quadrant
  const rr = (ri + p.uniformRadius) * NEIGHBOR_SLACK;
  const rr2 = rr * rr;

  const ring = grid.ringSlack;
  const cell = grid.cellSize;
  const cgx = Math.floor(pix / cell), cgy = Math.floor(piy / cell);
  for (let dy = -ring; dy <= ring; dy++) {
    if (!rowSpan(grid, cellStart, cgy + dy, cgx - ring, cgx + ring, _span)) continue;
    for (let e = _span.begin; e < _span.end; e++) {
      const j = entryIdx[e];
      if (j === i) continue;
      const j2 = j * 2;
      const djx = posPredicted[j2] - pix;
      const djy = posPredicted[j2 + 1] - piy;
      if (djx * djx + djy * djy >= rr2) continue;   // ngoài tầm 'cạnh'
      // Tie đúng-trục (dot==0, measure-zero trong sim thật) rơi về phía 'không >0'.
      quadMask |= 1 << (((djx * gDirX + djy * gDirY) > 0 ? 1 : 0) | ((djx * gPerpX + djy * gPerpY) > 0 ? 2 : 0));
    }
  }
  return quadMask;
}

/**
 * Friction Coulomb per-PAIR tầng VẬN TỐC: mỗi neighbor CHỒNG LẤN tại posPredicted góp 1 impulse trượt tiếp tuyến
 * (cap Coulomb theo pen cặp đó), CỘNG DỒN rồi trừ TRUNG BÌNH 1 lần.
 *
 * ⛔ ĐỪNG trừ thẳng từng cặp vào v: lời hứa "tổng <= |vt_rel| không đảo chiều" chỉ đúng cho 1 CẶP; hạt tựa đống ngủ
 * có K~2-4 contact cùng thấy relV=vᵢ (velSnap[j]=0), tangent gần song song => tổng trừ K×½|vt| => ĐẢO CHIỀU v mỗi
 * step = máy bơm năng lượng (play-test: bật hạt lên trời + fluidize đụn phẳng bất kể μᵥ). Chia cnt = Jacobi
 * under-relaxation => tổng mỗi bên <= term cặp mạnh nhất <= ½|vt_rel|.
 */
function applyPairFriction(i: number, v: V2, posPredicted: Float32Array, radii: Float32Array,
                           velSnap: Float32Array, asleepSnapshot: Uint8Array, count: number,
                           grid: GrainCellGrid, cellStart: Int32Array, entryIdx: Int32Array,
                           p: FinalizeParams): void {
  const i2 = i * 2;
  const pix = posPredicted[i2], piy = posPredicted[i2 + 1];
  const ri = radii[i];
  const vix = velSnap[i2], viy = velSnap[i2 + 1];
  let impX = 0, impY = 0;
  let cnt = 0;

  const ring = grid.ring;              // R = 2r đúng nghĩa (contact chồng lấn) -> ring, KHÔNG ringSlack
  const cell = grid.cellSize;
  const cgx = Math.floor(pix / cell), cgy = Math.floor(piy / cell);
  for (let dy = -ring; dy <= ring; dy++) {
    if (!rowSpan(grid, cellStart, cgy + dy, cgx - ring, cgx + ring, _span)) continue;
    for (let e = _span.begin; e < _span.end; e++) {
      const j = entryIdx[e];
      if (j === i) continue;
      const j2 = j * 2;
      const diffX = pix - posPredicted[j2];
      const diffY = piy - posPredicted[j2 + 1];
      const rsum = ri + p.uniformRadius;
      const dist2 = diffX * diffX + diffY * diffY;
      if (dist2 >= rsum * rsum || dist2 <= 1e-8) continue;   // không chồng lấn (hoặc trùng tâm)
      const dist = Math.sqrt(dist2);
      const nx = diffX / dist, ny = diffY / dist;
      const pen = rsum - dist;
      const relX = vix - velSnap[j2];      // j ngủ -> velSnap[j]=0 -> trượt so với ĐẤT (ma sát tĩnh ăn)
      const relY = viy - velSnap[j2 + 1];
      const rn = relX * nx + relY * ny;
      const vtx = relX - rn * nx;          // thành phần TRƯỢT tiếp tuyến của cặp
      const vty = relY - rn * ny;
      const lvt = Math.sqrt(vtx * vtx + vty * vty);
      if (lvt <= 1e-6) continue;           // cụm cùng vận tốc (dòng chảy đều) -> ma sát 0, KHÔNG hãm belt/cú rơi
      // j THỨC -> ½ (lượt j tự góp nửa NGƯỢC chiều). j NGỦ -> FULL 1.0: lượt j early-out, nửa kia KHÔNG BAO GIỜ
      // được trừ. ⛔ Để ½ với ĐẤT = điểm cân bằng v* = g_t·dt ≠ 0: hạt mặt dốc trượt VĨNH VIỄN đúng mức
      // gravity/frame, μᵥ không tham gia (nhánh ½|vt| luôn thắng cap) — play-test: đụn dàn phẳng bất kể μᵥ.
      const share = asleepSnapshot[j] !== 0 ? 1 : 0.5;
      const mag = Math.min(share * lvt, p.frictionVelocity * pen / p.dt + p.frictionSurfaceDrag * lvt);
      impX += (vtx / lvt) * mag;
      impY += (vty / lvt) * mag;
      cnt++;
    }
  }
  if (cnt > 0) { v.x -= impX / cnt; v.y -= impY / cnt; }
}
