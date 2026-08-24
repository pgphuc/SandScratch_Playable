// PORT Mode A — nguồn: ir/code/!_Game_SDK/SandFlow/Flow/Grain/GrainSdfColliders.cs:1-360
// (GrainWallSegment · GrainSdfField · GrainWallGrid · static GrainSdfWalls).
//
// Toán tường POSITION-ONLY dùng CHUNG cho đường integrate (kèm phản xạ velocity qua normal trả về) và vòng contact
// (bỏ normal). Nguồn cố ý tách static vì copy 2 nơi thì CCD trôi lệch — port giữ nguyên tính chất đó: file này KHÔNG
// biết gì về job nào gọi nó.
//
// Mọi hàm nhận/trả GEOMETRY-LOCAL (trừ clampWorld* tự lo world<->local). Trả về = CÓ clamp hay không; `n` = pháp
// tuyến LOCAL để caller tự quyết phản xạ velocity.
//
// LỆCH SO VỚI NGUỒN (có chủ ý):
// - float2 -> object {x,y} TÁI DÙNG (out-param), KHÔNG cấp phát trong vòng update.
// - NativeArray<GrainWallSegment> -> Float32Array phẳng stride 4 (ax,ay,bx,by).
// - `ulong` bitmask của WallMaskForSweep -> cặp (lo,hi) Uint32: JS không có int64 nguyên gốc, BigInt quá đắt cho vòng
//   nóng. Ngữ nghĩa y hệt (bóc bit thấp nhất -> index segment TĂNG DẦN, mỗi segment đúng 1 lần).
// - float4x4 -> Float32Array(16) COLUMN-MAJOR khớp Unity float4x4 (index = col*4 + row).
// - double intermediates (xem README) -> không bit-identical; parity đo ở P6 bằng số liệu hành vi.

export interface V2 { x: number; y: number; }

export function v2(x = 0, y = 0): V2 { return { x, y }; }

/** float4x4 column-major (index = col*4 + row), khớp Unity.Mathematics.float4x4. */
export type Mat4 = Float32Array;

export function mat4Identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
  return m;
}

/** mul(m, float4(x,y,0,1)).xy — điểm. */
export function xformPoint(m: Mat4, x: number, y: number, out: V2): V2 {
  out.x = m[0] * x + m[4] * y + m[12];
  out.y = m[1] * x + m[5] * y + m[13];
  return out;
}

/** mul(m, float4(x,y,0,0)).xy — hướng (không tịnh tiến). */
export function xformDir(m: Mat4, x: number, y: number, out: V2): V2 {
  out.x = m[0] * x + m[4] * y;
  out.y = m[1] * x + m[5] * y;
  return out;
}

/** Unity normalizesafe: |v|² < FLT_MIN_NORMAL -> vector 0. */
export const FLT_MIN_NORMAL = 1.175494351e-38;

export function normalizeSafe(out: V2): V2 {
  const lsq = out.x * out.x + out.y * out.y;
  if (lsq < FLT_MIN_NORMAL) { out.x = 0; out.y = 0; return out; }
  const inv = 1 / Math.sqrt(lsq);
  out.x *= inv; out.y *= inv;
  return out;
}

/** 1 đoạn tường TĨNH (capsule 2 phía), GEOMETRY-LOCAL. Mảng phẳng stride 4: ax,ay,bx,by. */
export const SEG_STRIDE = 4;

/** SDF ANALYTIC containment — stadium ring (annulus) + segment rời (funnel/chute/khung/cửa). */
export interface GrainSdfField {
  worldToLocal: Mat4;
  localToWorld: Mat4;

  halfBody: number;    // nửa spine stadium (trục X, local)
  rIn: number;         // bán kính vành TRONG (hạt ở ngoài)
  rOut: number;        // bán kính vành NGOÀI (hạt ở trong)
  gapHalf: number;     // nửa cửa hở đỉnh vành ngoài
  edgeRadius: number;  // độ dày capsule tường (local)
  radiusLocal: number; // bán kính hạt ở local = particleRadius / geomScale
  doorThr: number;     // độ dày RIÊNG cửa trượt; <=0 -> fallback thrOf(sdf)

  beltHalfX: number;   // bbox belt: |lx| <= halfBody+rOut
  beltTopY: number;    // bbox belt: |ly| <= rOut

  segmentCount: number;

  // escape-guard (s1) — băng hành lang hợp lệ
  respawnLocalX: number;
  respawnLocalY: number;
  chuteInHalf: number;
  wallX: number;       // nửa bề ngang miệng phễu (FunnelMouthHalfWidth)
  chuteTopY: number;
  funnelTopY: number;
  wallTop: number;
  hasTopWall: number;
  bboxHalfX: number;
}

/** Broad-phase uniform-grid trên mảng segment (L5). enabled=0 -> quét trọn như cũ. */
export interface GrainWallGrid {
  originX: number;
  originY: number;
  cellSize: number;
  nx: number;
  ny: number;
  roam: number;      // A — bán kính "lang thang" quanh mốc c (build đã nở A + thr)
  enabled: number;
  maskValid: number; // 1 = cellMask hợp lệ (segmentCount <= 64)
}

/** Độ dày dải tường (local) = vỏ capsule + bán kính hạt. */
export function thrOf(sdf: GrainSdfField): number {
  return sdf.edgeRadius + sdf.radiusLocal;
}

/** Vành TRONG (1 phía, KHÔNG trần dải): hạt luôn NGOÀI lõi (d >= rIn). Chạm khi d < rIn+thr -> đẩy radial-out. */
export function clampInner(lp: V2, sdf: GrainSdfField, n: V2): boolean {
  n.x = 0; n.y = 0;
  const cx = lp.x < -sdf.halfBody ? -sdf.halfBody : (lp.x > sdf.halfBody ? sdf.halfBody : lp.x);
  const tox = lp.x - cx;
  const toy = lp.y;
  const d = Math.sqrt(tox * tox + toy * toy);
  const thr = thrOf(sdf);
  if (d >= sdf.rIn + thr) return false;
  if (d > 1e-5) { n.x = tox / d; n.y = toy / d; } else { n.x = 0; n.y = 1; }
  const push = sdf.rIn + thr - d;
  lp.x += n.x * push;
  lp.y += n.y * push;
  return true;
}

/**
 * Vành NGOÀI = TƯỜNG 2 PHÍA tại d=rOut (hộp RỖNG, KHÔNG phải đĩa đặc), TRỪ cửa hở đỉnh (ly>0 && |lx|<=gapHalf).
 * CCD theo lpPrev: hạt ĐANG TRONG ring (dPrev < rOut) -> containment VÔ ĐIỀU KIỆN (bỏ trần dải, chống tunneling khi
 * bước đi >> thr); hạt Ở NGOÀI -> GIỮ logic dải cũ để hạt trên tranh rơi tự do vào phễu.
 */
export function clampOuter(lp: V2, lpPrev: V2, sdf: GrainSdfField, n: V2): boolean {
  n.x = 0; n.y = 0;
  if (lp.y > 0 && Math.abs(lp.x) <= sdf.gapHalf) return false;   // cửa entry (gap đỉnh) -> không có tường
  const cx = lp.x < -sdf.halfBody ? -sdf.halfBody : (lp.x > sdf.halfBody ? sdf.halfBody : lp.x);
  const tox = lp.x - cx;
  const toy = lp.y;
  const d = Math.sqrt(tox * tox + toy * toy);
  if (d <= 1e-5) return false;
  const thr = thrOf(sdf);

  const cxPrev = lpPrev.x < -sdf.halfBody ? -sdf.halfBody : (lpPrev.x > sdf.halfBody ? sdf.halfBody : lpPrev.x);
  const pdx = lpPrev.x - cxPrev, pdy = lpPrev.y;
  const dPrev = Math.sqrt(pdx * pdx + pdy * pdy);

  if (dPrev < sdf.rOut) {              // ĐÃ Ở TRONG ring -> giam, không trần dải
    if (d <= sdf.rOut - thr) return false;
    n.x = -tox / d; n.y = -toy / d;    // pháp tuyến vào tâm
    const push = d - (sdf.rOut - thr);
    lp.x += n.x * push;
    lp.y += n.y * push;
    return true;                       // caller reflectVel: restitution 0 -> giết vận tốc hướng RA
  }
  // Ở NGOÀI ring -> chỉ chặn ở mặt NGOÀI trong dải vỏ (hành vi cũ).
  if (d <= sdf.rOut - thr || d >= sdf.rOut + thr) return false;
  n.x = tox / d; n.y = toy / d;
  const push = sdf.rOut + thr - d;
  lp.x += n.x * push;
  lp.y += n.y * push;
  return true;
}

const _hit: V2 = { x: 0, y: 0 };

/**
 * Giao đoạn-đoạn 2D (lpPrev->lp) x (a->b). Trả điểm cắt + pháp tuyến vuông góc tường HƯỚNG VỀ PHÍA lpPrev (phía hợp
 * lệ hạt vừa rời) để caller đẩy hạt lùi lại. Song song (denom~0) -> không cắt.
 */
function crossesSegment(ax: number, ay: number, bx: number, by: number,
                        lpPrev: V2, lp: V2, hit: V2, n: V2): boolean {
  hit.x = lpPrev.x; hit.y = lpPrev.y;
  n.x = 0; n.y = 0;
  const rx = lp.x - lpPrev.x, ry = lp.y - lpPrev.y;
  const sx = bx - ax, sy = by - ay;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-9) return false;
  const qpx = ax - lpPrev.x, qpy = ay - lpPrev.y;
  const t = (qpx * sy - qpy * sx) / denom;   // tham số dọc lpPrev->lp
  const u = (qpx * ry - qpy * rx) / denom;   // tham số dọc a->b
  if (t < 0 || t > 1 || u < 0 || u > 1) return false;
  hit.x = lpPrev.x + t * rx;
  hit.y = lpPrev.y + t * ry;
  n.x = sx; n.y = sy;
  normalizeSafe(n);
  const tmp = n.x;
  n.x = -n.y; n.y = tmp;                     // vuông góc
  if ((lpPrev.x - hit.x) * n.x + (lpPrev.y - hit.y) * n.y < 0) { n.x = -n.x; n.y = -n.y; }
  return true;
}

/**
 * Tường capsule 2 phía (funnel/chute/khung + cửa trượt): đẩy hạt ra phía GẦN NHẤT của đoạn, kèm CCD.
 * `thrOverride` < 0 -> dùng thrOf(sdf) chung; cửa trượt truyền sdf.doorThr để chỉnh độ dày RIÊNG.
 */
export function clampSegment(segs: Float32Array, s: number, lp: V2, lpPrev: V2, sdf: GrainSdfField, n: V2,
                             thrOverride = -1): boolean {
  const o = s * SEG_STRIDE;
  const ax = segs[o], ay = segs[o + 1], bx = segs[o + 2], by = segs[o + 3];
  const abx = bx - ax, aby = by - ay;
  const denom = abx * abx + aby * aby;
  let t = 0;
  if (denom > 1e-8) {
    t = ((lp.x - ax) * abx + (lp.y - ay) * aby) / denom;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
  }
  const cx = ax + t * abx, cy = ay + t * aby;
  const tox = lp.x - cx, toy = lp.y - cy;
  const d = Math.sqrt(tox * tox + toy * toy);
  const thr = thrOverride > 0 ? thrOverride : thrOf(sdf);
  if (d < thr) {
    if (d > 1e-5) { n.x = tox / d; n.y = toy / d; }
    else {                                   // trùng đoạn -> pháp tuyến vuông góc
      n.x = abx; n.y = aby;
      normalizeSafe(n);
      const tmp = n.x;
      n.x = -n.y; n.y = tmp;
    }
    const push = thr - d;
    lp.x += n.x * push;
    lp.y += n.y * push;
    return true;
  }
  // Xa tường ở điểm CUỐI nhưng đã băng qua trong bước này -> đặt lại ở mặt bên PHÍA CŨ.
  if (crossesSegment(ax, ay, bx, by, lpPrev, lp, _hit, n)) {
    lp.x = _hit.x + n.x * thr;
    lp.y = _hit.y + n.y * thr;
    return true;
  }
  n.x = 0; n.y = 0;
  return false;
}

// --- clampWorld: containment ĐẦY ĐỦ, POSITION-ONLY, nhận/trả WORLD (vòng contact) ---------------------------------

const _lp: V2 = { x: 0, y: 0 };
const _lpPrev: V2 = { x: 0, y: 0 };
const _n: V2 = { x: 0, y: 0 };

/**
 * Bản KHÔNG grid. `compliance` (0..1) = độ NHƯỢNG của tường TRONG VÒNG CONTACT; 0 = tường CỨNG = nhánh blend bị skip
 * hẳn (không sai số làm tròn thừa). Đường INTEGRATE không dùng hàm này — nó giữ clamp CỨNG + CCD.
 */
export function clampWorld(p: V2, pPrev: V2, sdf: GrainSdfField, segs: Float32Array,
                           hasDoor: number, door: Float32Array, compliance: number): void {
  xformPoint(sdf.worldToLocal, p.x, p.y, _lp);
  xformPoint(sdf.worldToLocal, pPrev.x, pPrev.y, _lpPrev);
  const lp0x = _lp.x, lp0y = _lp.y;   // mốc TRƯỚC clamp — để nhượng lại một phần correction
  clampInner(_lp, sdf, _n);
  clampOuter(_lp, _lpPrev, sdf, _n);
  for (let s = 0; s < sdf.segmentCount; s++) clampSegment(segs, s, _lp, _lpPrev, sdf, _n);
  if (hasDoor !== 0) clampSegment(door, 0, _lp, _lpPrev, sdf, _n, sdf.doorThr);
  if (compliance > 0) {               // 0 -> skip: giữ bit-identical bản cũ
    _lp.x = lp0x + (_lp.x - lp0x) * (1 - compliance);
    _lp.y = lp0y + (_lp.y - lp0y) * (1 - compliance);
  }
  xformPoint(sdf.localToWorld, _lp.x, _lp.y, p);
}

/** Ô chứa điểm local (x,y); -1 = ngoài bounds grid (= xa mọi segment > roam+thr -> skip TRỌN, KHÔNG fallback). */
export function cellOfWall(grid: GrainWallGrid, x: number, y: number): number {
  const gx = Math.floor((x - grid.originX) / grid.cellSize);
  const gy = Math.floor((y - grid.originY) / grid.cellSize);
  if (gx < 0 || gy < 0 || gx >= grid.nx || gy >= grid.ny) return -1;
  return gy * grid.nx + gx;
}

/**
 * Bản CÓ broad-phase grid (CSR cellStart/cellItems). Trả TRUE khi phải fallback quét trọn segmentCount (đếm để canh:
 * fallback thường xuyên = roam quá nhỏ, lever mất tác dụng chứ KHÔNG sai kết quả).
 */
export function clampWorldGrid(p: V2, pPrev: V2, sdf: GrainSdfField, segs: Float32Array,
                               hasDoor: number, door: Float32Array, compliance: number,
                               grid: GrainWallGrid, cellStart: Int32Array, cellItems: Int32Array): boolean {
  xformPoint(sdf.worldToLocal, p.x, p.y, _lp);
  xformPoint(sdf.worldToLocal, pPrev.x, pPrev.y, _lpPrev);
  const lp0x = _lp.x, lp0y = _lp.y;
  clampInner(_lp, sdf, _n);
  clampOuter(_lp, _lpPrev, sdf, _n);

  const cx = _lp.x, cy = _lp.y;       // mốc HỢP ĐỒNG: mọi điểm của vòng segment phải nằm trong ball(c, roam)
  const roamSq = grid.roam * grid.roam;
  const dpx = _lpPrev.x - cx, dpy = _lpPrev.y - cy;
  let fallback = grid.enabled === 0 || (dpx * dpx + dpy * dpy) > roamSq;
  if (!fallback) {
    const cell = cellOfWall(grid, cx, cy);
    if (cell >= 0) {
      const k1 = cellStart[cell + 1];
      for (let k = cellStart[cell]; k < k1; k++) {
        if (!clampSegment(segs, cellItems[k], _lp, _lpPrev, sdf, _n)) continue;
        const ex = _lp.x - cx, ey = _lp.y - cy;
        if (ex * ex + ey * ey > roamSq) { fallback = true; break; }   // ra khỏi vùng phủ -> làm lại cho chắc
      }
    }
    // cell < 0 = c ngoài bounds (đã nở roam+thr) -> không segment nào chạm nổi -> skip trọn.
  }
  if (fallback) {
    _lp.x = cx; _lp.y = cy;           // dựng lại trạng thái SAU clampInner/clampOuter rồi quét như cũ
    for (let s = 0; s < sdf.segmentCount; s++) clampSegment(segs, s, _lp, _lpPrev, sdf, _n);
  }

  if (hasDoor !== 0) clampSegment(door, 0, _lp, _lpPrev, sdf, _n, sdf.doorThr);  // cửa NGOÀI grid (động, O(1))
  if (compliance > 0) {
    _lp.x = lp0x + (_lp.x - lp0x) * (1 - compliance);
    _lp.y = lp0y + (_lp.y - lp0y) * (1 - compliance);
  }
  xformPoint(sdf.localToWorld, _lp.x, _lp.y, p);
  return fallback;
}

// --- wallMaskForSweep (đường INTEGRATE) ---------------------------------------------------------------------------

/** Trần số ô của 1 lượt query. Vượt = fallback quét trọn (chặn ca bệnh lý: bước khổng lồ / teleport escape-guard). */
export const SWEEP_MAX_CELLS = 32;

/**
 * Kết quả gom bitmask: mask (lo/hi 32-bit thay `ulong`) + hình chữ nhật phủ R = [rMin, rMax] CELL-ALIGNED, mở ra
 * ±Infinity ở cạnh chạm biên grid. Object TÁI DÙNG — không cấp phát trong vòng update.
 */
export interface SweepMask {
  lo: number; hi: number;
  rMinX: number; rMinY: number;
  rMaxX: number; rMaxY: number;
}

export function sweepMask(): SweepMask {
  return { lo: 0, hi: 0, rMinX: 0, rMinY: 0, rMaxX: 0, rMaxY: 0 };
}

/**
 * Gom BITMASK segment ứng viên cho MỘT BƯỚC QUÉT lpPrev->c của đường integrate.
 * Vùng phủ = AABB CỦA ĐOẠN (không phải ball quanh 1 điểm như vòng contact) nở thêm roam — vì ở integrate bước đi tới
 * ~4.4 bán kính/substep và clampSegment chạy CCD trên TRỌN đoạn.
 * Caller PHẢI kiểm sau mỗi lần clamp: lp ra khỏi R -> FALLBACK quét trọn (làm lại từ c). Không có ca lệch im lặng.
 * FALSE = phải fallback (grid tắt / mask không hợp lệ / dải ô vượt SWEEP_MAX_CELLS).
 * `cellMask` = Uint32Array stride 2 (lo, hi) — thay 1 ulong/ô của nguồn.
 */
export function wallMaskForSweep(grid: GrainWallGrid, cellMask: Uint32Array,
                                 lpPrev: V2, cx: number, cy: number, out: SweepMask): boolean {
  out.lo = 0; out.hi = 0;
  out.rMinX = 0; out.rMinY = 0; out.rMaxX = 0; out.rMaxY = 0;
  if (grid.enabled === 0 || grid.maskValid === 0) return false;

  const loX = Math.min(lpPrev.x, cx) - grid.roam;
  const loY = Math.min(lpPrev.y, cy) - grid.roam;
  const hiX = Math.max(lpPrev.x, cx) + grid.roam;
  const hiY = Math.max(lpPrev.y, cy) + grid.roam;
  const x0 = Math.floor((loX - grid.originX) / grid.cellSize);
  const x1 = Math.floor((hiX - grid.originX) / grid.cellSize);
  const y0 = Math.floor((loY - grid.originY) / grid.cellSize);
  const y1 = Math.floor((hiY - grid.originY) / grid.cellSize);
  // Kẹp vào grid: phần dải NGOÀI bounds không có segment nào (bounds đã nở roam+thr) -> bỏ vẫn ĐỦ ứng viên; bù lại R
  // phải mở ra ±inf đúng ở cạnh bị kẹp, để hạt đi ra vùng trống đó KHÔNG bị tính là "ra khỏi R".
  const cx0 = x0 < 0 ? 0 : (x0 > grid.nx - 1 ? grid.nx - 1 : x0);
  const cx1 = x1 < 0 ? 0 : (x1 > grid.nx - 1 ? grid.nx - 1 : x1);
  const cy0 = y0 < 0 ? 0 : (y0 > grid.ny - 1 ? grid.ny - 1 : y0);
  const cy1 = y1 < 0 ? 0 : (y1 > grid.ny - 1 ? grid.ny - 1 : y1);
  if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > SWEEP_MAX_CELLS) return false;

  let lo = 0, hi = 0;
  for (let gy = cy0; gy <= cy1; gy++) {
    const row = gy * grid.nx;
    for (let gx = cx0; gx <= cx1; gx++) {
      const b = (row + gx) * 2;
      lo |= cellMask[b];
      hi |= cellMask[b + 1];
    }
  }
  out.lo = lo >>> 0;
  out.hi = hi >>> 0;
  out.rMinX = cx0 === 0 ? -Infinity : grid.originX + cx0 * grid.cellSize;
  out.rMinY = cy0 === 0 ? -Infinity : grid.originY + cy0 * grid.cellSize;
  out.rMaxX = cx1 === grid.nx - 1 ? Infinity : grid.originX + (cx1 + 1) * grid.cellSize;
  out.rMaxY = cy1 === grid.ny - 1 ? Infinity : grid.originY + (cy1 + 1) * grid.cellSize;
  return true;
}

/** tzcnt cho nửa 32-bit (x != 0). */
function tzcnt32(x: number): number {
  return 31 - Math.clz32(x & -x);
}

/**
 * Bóc bit THẤP NHẤT của mask -> index segment, và xoá bit đó khỏi `out`. Trả -1 khi mask rỗng.
 * Index TĂNG DẦN, mỗi segment ĐÚNG 1 lần -> giữ nguyên THỨ TỰ + số lượt gọi clampSegment của đường quét trọn
 * (vòng tuần tự dịch lp giữa chừng nên thứ tự là một phần của kết quả).
 */
export function popLowestSegment(out: SweepMask): number {
  if (out.lo !== 0) {
    const s = tzcnt32(out.lo);
    out.lo = (out.lo & (out.lo - 1)) >>> 0;
    return s;
  }
  if (out.hi !== 0) {
    const s = tzcnt32(out.hi);
    out.hi = (out.hi & (out.hi - 1)) >>> 0;
    return s + 32;
  }
  return -1;
}
