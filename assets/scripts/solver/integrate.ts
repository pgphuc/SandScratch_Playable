// PORT Mode A — nguồn: ir/code/!_Game_SDK/SandFlow/Flow/Grain/GrainIntegrateJob.cs (289)
//                     + GrainSdfColliders.cs:1038-1137 (GrainEscapeBand · GrainEscapeGuardJob).
//
// 1 bước integrate: gravity + semi-implicit Euler + SDF containment + belt force, TẤT CẢ trong 1 vòng (nguồn cố ý
// KHÔNG schedule job phụ nối tiếp để giữ 1 Complete()/FixedUpdate). Velocity GIỮ world suốt (phản xạ qua world-normal)
// -> không rối scale khi geomScale != 1.
//
// LỆCH SO VỚI NGUỒN (có chủ ý):
// - IJobParallelFor -> vòng `for` tuần tự. MẤT đa luồng (đã ghi rủi ro trong conversion-manifest). Kết quả KHÔNG đổi:
//   mỗi Execute(i) của nguồn chỉ ghi index i, không có phụ thuộc chéo trong job này.
// - float2 -> object {x,y} TÁI DÙNG ở scope module; SoA vẫn là Float32Array (positions/velocities stride 2).
// - Unity.Mathematics.Random của escape-guard: xorshift32 tái dựng theo ngữ nghĩa `Random(uint seed)` — file
//   Unity.Mathematics KHÔNG có trong IR nên đây là GIẢ ĐỊNH, đánh dấu để P6 kiểm. Chỉ ảnh hưởng JITTER x chống chồng
//   chất khi respawn (không ảnh hưởng hành vi tổng: mọi hạt escape đều về miệng phễu + zero-vel, counter-neutral).

import {
  clampInner, clampOuter, clampSegment, normalizeSafe, thrOf, xformDir, xformPoint,
  wallMaskForSweep, popLowestSegment, sweepMask, type SweepMask,
  type GrainSdfField, type GrainWallGrid, type V2,
} from './sdfWalls';
import { sweepBlocked, creepDownhill, type GrainOccupancyField } from './occupancy';

// --- helper toán (Unity.Mathematics) --------------------------------------------------------------------------------

const saturate = (x: number): number => (x < 0 ? 0 : (x > 1 ? 1 : x));
const lerp = (a: number, b: number, t: number): number => a + t * (b - a);

function smoothstep(a: number, b: number, x: number): number {
  const t = saturate((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** Độ rộng chuyển tiếp blend 2 bộ servo qua crest, theo tanWorld.y ∈ [-1,1]. */
const BELT_UP_BLEND_BAND = 0.35;

// --- tham số ---------------------------------------------------------------------------------------------------------

/** Knob của 1 step integrate. Tên giữ NGUYÊN theo field nguồn để tra `ir/tuning.json` không phải dịch. */
export interface IntegrateParams {
  gravityX: number;
  gravityY: number;
  dt: number;
  substeps: number;          // chia dt thành N bước tích phân/resolve (chống tunneling)

  // --- containment + belt (hasSdf=0 -> bỏ qua, hành vi s1) ---
  hasSdf: number;
  sdf: GrainSdfField;
  segments: Float32Array;    // stride 4 (ax,ay,bx,by)
  restitution: number;       // nảy pháp tuyến (0 = cát không nảy)
  frictionKeep: number;      // phần vận tốc TIẾP TUYẾN giữ lại mỗi lần chạm tường — ĐÃ quy đổi = pow(1-f, 1/substeps)

  beltSpeed: number;          // servo: tốc độ TIẾP TUYẾN mục tiêu của belt CCW (world/s)
  beltCoupling: number;       // servo stiffness (1/s). Servo CHỈ làm SÀN tốc độ, KHÔNG phanh khi hạt nhanh hơn
  beltRadialDamping: number;  // hãm RADIAL trong belt (1/s); 0 = tắt
  beltTopRelease: number;     // 0..1: "vùng thả đỉnh" — fade servo+radial ở rãnh trên; 0 = tắt
  beltTopReleaseStart: number;// 0..1: hạ MỐC bắt đầu vùng thả xuống dưới rIn
  beltTopTangentDamp: number; // >=0 (1/s): hãm TIẾP TUYẾN trong vùng thả -> hạt rơi THẲNG
  beltSpeedUp: number;          // bộ *Up = nửa ĐANG GÁNH hạt LÊN (tanWorld.y>0)
  beltCouplingUp: number;
  beltRadialDampingUp: number;
  beltTopReleaseUp: number;
  beltTopReleaseStartUp: number;
  beltTopTangentDampUp: number;
  enforceOneWay: number;      // 1 = clamp hạt in-belt phọt ngược ra cửa entry

  // --- cửa SDF trượt chặn khe entry khi belt-full ---
  hasDoor: number;
  door: Float32Array;        // 1 segment NGANG tại y=rOut (geometry-local), stride 4
  gapBeltTopY: number;       // TRẦN belt trong dấu chân MIỆNG PHỄU khi cửa ĐÓNG (backend tính sẵn)

  // --- occupancy tranh (hasOcc=0 -> hạt rơi xuyên vùng tranh như s2) ---
  hasOcc: number;
  occ: GrainOccupancyField;
  occSnapshot: Uint8Array;       // bản CHẶN-VÀO (đã dilate)
  occSnapshotRaw: Uint8Array;    // bản TRANH THẬT; dilate=0 -> truyền TRÙNG occSnapshot = bit-identical
  occNormals: Float32Array;      // stride 2, build bởi buildOccNormals mỗi step
  occSlip: number;               // surface-slide; 0 = tắt

  // --- broad-phase tường cho ĐƯỜNG INTEGRATE ---
  wgiEnabled: number;
  wallGrid: GrainWallGrid;
  wallCellMask: Uint32Array;     // stride 2 (lo,hi) mỗi ô
}

// --- state tái dùng (0 alloc trong vòng update) ------------------------------------------------------------------------

const _p: V2 = { x: 0, y: 0 };
const _v: V2 = { x: 0, y: 0 };
const _pPrev: V2 = { x: 0, y: 0 };
const _lp: V2 = { x: 0, y: 0 };
const _lpPrev: V2 = { x: 0, y: 0 };
const _n: V2 = { x: 0, y: 0 };
const _tmp: V2 = { x: 0, y: 0 };
const _mask: SweepMask = sweepMask();

/**
 * Phản xạ velocity (world) qua pháp tuyến LOCAL `nLocal`: bounce pháp tuyến theo restitution (cát ~0 = triệt), giữ
 * `frictionKeep` tiếp tuyến.
 *
 * ⚠ VÌ SAO dùng frictionKeep (quy đổi ở backend) chứ KHÔNG dùng thẳng (1-frictionKnob): hàm này chạy MỖI SUBSTEP (hạt
 * bị đống ép vào tường thì substep nào cũng d<thr). Nhân thẳng (1-f) mỗi lần gọi ⇒ ma sát THỰC = (1-f)^substeps ⇒ đổi
 * substeps (tham số SỐ HỌC chống tunneling) lại đổi luôn MA SÁT TƯỜNG (tính chất VẬT LÝ). Vấp thật: nâng substeps 2->8
 * làm friction 0.05 nhảy từ 10%/frame lên 34%/frame ⇒ hạt DÍNH mép khung tranh thành hàng thẳng.
 */
function reflectVel(v: V2, nLocalX: number, nLocalY: number, p: IntegrateParams): void {
  xformDir(p.sdf.localToWorld, nLocalX, nLocalY, _tmp);
  normalizeSafe(_tmp);
  let vn = v.x * _tmp.x + v.y * _tmp.y;
  const vtx = v.x - vn * _tmp.x;                 // thành phần tiếp tuyến
  const vty = v.y - vn * _tmp.y;
  if (vn < 0) vn = -p.restitution * vn;          // đi VÀO tường -> nảy ra (restitution 0 => triệt)
  v.x = vtx * p.frictionKeep + vn * _tmp.x;
  v.y = vty * p.frictionKeep + vn * _tmp.y;
}

/**
 * Đưa hạt về geometry-local, giải va chạm tường (inner/outer stadium + segments funnel/chute/khung) + belt
 * (servo/one-way), rồi đưa pos về world. Velocity GIỮ world suốt.
 * `pPrev` = pos ĐẦU substep (world) = mốc CCD: tường chỉ test điểm CUỐI thì hạt nhanh (v·sdt > độ dày dải tường) nhảy
 * TRỌN dải trong 1 nhịp -> bắt hụt -> thoát vĩnh viễn (Bug 2).
 */
function resolveContainment(pos: V2, vel: V2, sdt: number, pPrev: V2, p: IntegrateParams): void {
  const sdf = p.sdf;
  xformPoint(sdf.worldToLocal, pos.x, pos.y, _lp);
  xformPoint(sdf.worldToLocal, pPrev.x, pPrev.y, _lpPrev);

  // Toán tường = sdfWalls (DÙNG CHUNG với vòng contact — 1 bản CCD duy nhất, không trôi lệch). Ở ĐÂY có velocity nên
  // clamp xong thì phản xạ qua normal trả về; vòng contact thì bỏ normal (position-only).
  if (clampInner(_lp, sdf, _n)) reflectVel(vel, _n.x, _n.y, p);
  if (clampOuter(_lp, _lpPrev, sdf, _n)) reflectVel(vel, _n.x, _n.y, p);

  // VÒNG SEGMENT — 2 đường. Grid TẮT = quét trọn nguyên si. Grid BẬT: gom ứng viên theo AABB CỦA ĐOẠN QUÉT
  // lpPrev->lp (KHÔNG phải ball quanh 1 điểm như vòng contact — bước ở đây tới ~4.4 bán kính và clampSegment chạy CCD
  // trên trọn đoạn).
  const useGrid = p.wgiEnabled !== 0 && p.wallGrid.enabled !== 0 && p.wallGrid.maskValid !== 0;
  if (!useGrid) {
    for (let s = 0; s < sdf.segmentCount; s++) {
      if (clampSegment(p.segments, s, _lp, _lpPrev, sdf, _n)) reflectVel(vel, _n.x, _n.y, p);
    }
  } else {
    const lpInX = _lp.x, lpInY = _lp.y;          // mốc TRƯỚC vòng segment — để dựng lại nguyên trạng khi fallback
    const vInX = vel.x, vInY = vel.y;
    let done = false;
    if (wallMaskForSweep(p.wallGrid, p.wallCellMask, _lpPrev, _lp.x, _lp.y, _mask)) {
      let ok = true;
      let s: number;
      while ((s = popLowestSegment(_mask)) >= 0) {   // bóc bit thấp nhất -> index TĂNG DẦN, mỗi segment 1 lần
        if (!clampSegment(p.segments, s, _lp, _lpPrev, sdf, _n)) continue;
        reflectVel(vel, _n.x, _n.y, p);
        if (_lp.x < _mask.rMinX || _lp.y < _mask.rMinY || _lp.x > _mask.rMaxX || _lp.y > _mask.rMaxY) {
          ok = false; break;                          // ra khỏi vùng phủ -> làm lại cho chắc
        }
      }
      if (ok) done = true;
    }
    if (!done) {                                      // FALLBACK: dựng lại trạng thái vào vòng rồi quét trọn
      _lp.x = lpInX; _lp.y = lpInY;
      vel.x = vInX; vel.y = vInY;
      for (let s = 0; s < sdf.segmentCount; s++) {
        if (clampSegment(p.segments, s, _lp, _lpPrev, sdf, _n)) reflectVel(vel, _n.x, _n.y, p);
      }
    }
  }

  // Cửa SDF trượt chặn khe entry khi belt-full.
  if (p.hasDoor !== 0 && clampSegment(p.door, 0, _lp, _lpPrev, sdf, _n, sdf.doorThr)) reflectVel(vel, _n.x, _n.y, p);

  // Belt vortex CCW: chỉ hạt đã trong bbox ring stadium.
  // TRẦN theo DẤU CHÂN MIỆNG PHỄU: trong |lp.x|<=wallX khi cửa ĐÓNG, trần hạ xuống doorY (gapBeltTopY) -> lớp crest
  // DƯỚI miệng phễu KHÔNG nhận vortex nữa -> đứng yên -> ngủ được. Cửa VẬT LÝ vẫn chỉ rộng gapHalf; đây là vùng
  // HẠ-TRẦN vortex, phải rộng bằng đống nên dùng wallX (gapHalf hụt bề ngang -> vai đống vẫn vortex -> churn).
  const beltTopHere = Math.abs(_lp.x) <= sdf.wallX ? p.gapBeltTopY : sdf.beltTopY;
  if (Math.abs(_lp.x) <= sdf.beltHalfX && _lp.y <= beltTopHere && _lp.y >= -sdf.beltTopY) {
    const spineX = _lp.x < -sdf.halfBody ? -sdf.halfBody : (_lp.x > sdf.halfBody ? sdf.halfBody : _lp.x);
    const radialX = _lp.x - spineX;
    const radialY = _lp.y;
    const rl = Math.sqrt(radialX * radialX + radialY * radialY);
    if (rl > 1e-5) {
      // Tangent CCW: cross(+Z, radial) = (-ry, rx) (khớp ForceZone.Vortex dương = CCW của Obi).
      const tanLocalX = -radialY / rl, tanLocalY = radialX / rl;
      xformDir(sdf.localToWorld, tanLocalX, tanLocalY, _tmp);
      normalizeSafe(_tmp);
      const tanWorldX = _tmp.x, tanWorldY = _tmp.y;

      // 2-BỘ SERVO: discriminator = tanWorld.y. Nửa ĐANG GÁNH hạt LÊN dùng bộ *Up (servo mạnh + target CAO -> launch
      // qua crest ballistic); nửa cua XUỐNG dùng bộ thường (trọng lực + top-release). Blend mượt qua crest.
      const upW = smoothstep(-BELT_UP_BLEND_BAND, BELT_UP_BLEND_BAND, tanWorldY);
      const beltSpeedE = lerp(p.beltSpeed, p.beltSpeedUp, upW);
      const beltCouplingE = lerp(p.beltCoupling, p.beltCouplingUp, upW);
      const beltRadialDampingE = lerp(p.beltRadialDamping, p.beltRadialDampingUp, upW);
      const beltTopReleaseE = lerp(p.beltTopRelease, p.beltTopReleaseUp, upW);
      const beltTopReleaseStartE = lerp(p.beltTopReleaseStart, p.beltTopReleaseStartUp, upW);
      const beltTopTangentDampE = lerp(p.beltTopTangentDamp, p.beltTopTangentDampUp, upW);

      // VÙNG THẢ ĐỈNH: "thả" belt dần theo ĐỘ CAO trong rãnh trên để trọng lực hắt hạt rơi (projectile) như băng
      // chuyền thật, thay vì servo tiếp tuyến lùa hạt NGANG qua đỉnh. beltTopRelease=0 = bit-identical hành vi cũ.
      const yStart = lerp(sdf.rIn, 0, beltTopReleaseStartE);
      const tTop = saturate((_lp.y - yStart) / Math.max(sdf.rOut - yStart, 1e-5));
      const driveScale = 1 - beltTopReleaseE * tTop;

      // BELT SERVO 1-CHIỀU: kéo THÀNH PHẦN TIẾP TUYẾN của vận tốc VỀ beltSpeed, CHỈ khi hạt CHẬM hơn belt
      // (deficit>0) -> không ứ đọng khúc lên. Khi hạt NHANH hơn belt (đang rơi ở cua xuống) -> k=0 THÔI PHANH, để
      // trọng lực + quán tính chi phối cú rơi TỰ NHIÊN. ×sdt: bất biến substeps.
      const vTan = vel.x * tanWorldX + vel.y * tanWorldY;
      const deficit = beltSpeedE - vTan;
      const k = deficit > 0 ? beltCouplingE : 0;
      vel.x += tanWorldX * deficit * k * driveScale * sdt;
      vel.y += tanWorldY * deficit * k * driveScale * sdt;

      // (B) DAMPING TIẾP TUYẾN VÙNG ĐỈNH: bào dần tốc độ DỌC belt trong vùng thả để hạt TRÚT phương NGANG và rơi
      // THẲNG đứng. Ngược hẳn radial damping (cái triệt hướng-tâm ⇒ ép vận tốc thành tiếp tuyến = ôm tường CONG).
      if (beltTopTangentDampE > 0 && tTop > 0) {
        const vTanNow = vel.x * tanWorldX + vel.y * tanWorldY;
        const f = saturate(beltTopTangentDampE * tTop * sdt);
        vel.x -= vTanNow * f * tanWorldX;
        vel.y -= vTanNow * f * tanWorldY;
      }

      // HÃM RADIAL — dập jitter 'nảy liên tục' trong belt. Vortex cấp lực THUẦN TIẾP TUYẾN, KHÔNG có lực hướng tâm ⇒
      // hạt bay THẲNG theo quán tính, văng ra tường ngoài, clampOuter snap về, vortex lại đẩy ra = BUZZ radial.
      //
      // ⚠ LOẠI TRỪ CỘT CỬA ENTRY (cùng test với clampOuter). Bbox belt trùm cả cửa vào đỉnh ring, mà TẠI ĐÓ
      // spine=(lx,0) và hạt ở ly≈rOut ⇒ 'radial' trỏ THẲNG LÊN ⇒ hãm radial = HÃM TRỌNG LỰC: hạt không rơi vào belt
      // được, đứng lại xếp thành HÀNG dọc mép ring.
      const inEntryGap = _lp.y > 0 && Math.abs(_lp.x) <= sdf.gapHalf;
      if (beltRadialDampingE > 0 && !inEntryGap) {
        xformDir(sdf.localToWorld, radialX / rl, radialY / rl, _tmp);
        normalizeSafe(_tmp);
        const vr = vel.x * _tmp.x + vel.y * _tmp.y;
        const f = saturate(beltRadialDampingE * sdt) * driveScale;
        vel.x -= vr * f * _tmp.x;
        vel.y -= vr * f * _tmp.y;
      }
    }
  }

  // One-way: chặn hạt trong ring PHỌT NGƯỢC ra cửa entry (gap đỉnh). Hạt ở cột gap, quanh mép entry, đang đi LÊN ->
  // giết vận tốc lên (rơi VÀO được, trồi RA không).
  if (p.enforceOneWay !== 0 && Math.abs(_lp.x) <= sdf.gapHalf && _lp.y > 0 && _lp.y < sdf.rOut + 3 * sdf.radiusLocal) {
    xformDir(sdf.localToWorld, 0, 1, _tmp);
    normalizeSafe(_tmp);
    const vu = vel.x * _tmp.x + vel.y * _tmp.y;
    if (vu > 0) { vel.x -= vu * _tmp.x; vel.y -= vu * _tmp.y; }
  }

  xformPoint(sdf.localToWorld, _lp.x, _lp.y, pos);
}

/**
 * 1 step integrate cho [0..count). SoA: positions/velocities/posPredicted stride 2; asleep/ghost là Uint8Array.
 *
 * Hạt NGỦ: KHÔNG integrate, nhưng PHẢI ghi posPredicted=pos để finalize suy corr=0 (không thì corr = pos -
 * posPredicted_cũ = rác). Vẫn vào lưới neighbor làm VẬT CẢN cho hạt thức.
 */
export function integrate(positions: Float32Array, velocities: Float32Array, posPredicted: Float32Array,
                          asleep: Uint8Array, ghost: Uint8Array, ghostReleaseY: Float32Array,
                          count: number, p: IntegrateParams): void {
  const steps = Math.max(1, p.substeps);
  const sdt = p.dt / steps;

  for (let i = 0; i < count; i++) {
    const i2 = i * 2;
    if (asleep[i] !== 0) {
      posPredicted[i2] = positions[i2];
      posPredicted[i2 + 1] = positions[i2 + 1];
      continue;
    }
    _p.x = positions[i2]; _p.y = positions[i2 + 1];
    _v.x = velocities[i2]; _v.y = velocities[i2 + 1];
    let ghosting = ghost[i] !== 0;        // (Booster blast) đang xuyên tranh -> bỏ occupancy trong vòng substep
    const releaseY = ghostReleaseY[i];

    // SUBSTEP: chia dt/N, mỗi bước tích pos NGẮN rồi resolve NGAY. Chống tunneling — hạt rơi nhanh không nhảy qua
    // tường mỏng trong 1 nhịp.
    for (let s = 0; s < steps; s++) {
      // semi-implicit: cập nhật v TRƯỚC rồi tích pos (ổn định hơn Euler thường).
      // ⛔ ĐỪNG kẹp v.y ở đây để chữa "hạt chen vào giữa đụn" (knob maxFallSpeed, nguồn XOÁ 2026-08-04): kẹp vận tốc
      // = hạ tốc rơi thật = đổi cảm giác gravity. Lever đúng ở tầng CONTACT (intruderBias).
      _v.x += p.gravityX * sdt;
      _v.y += p.gravityY * sdt;
      _pPrev.x = _p.x; _pPrev.y = _p.y;   // mốc PREVENT-ENTRY: pos đầu substep
      _p.x += _v.x * sdt;
      _p.y += _v.y * sdt;
      if (p.hasSdf !== 0) resolveContainment(_p, _v, sdt, _pPrev, p);
      // NHẢ ghost NGAY trong substep vừa vượt mốc -> hạt ăn occupancy từ chính substep đó, không rơi lố thêm 1 nhịp.
      if (ghosting && _p.y <= releaseY) ghosting = false;
      if (p.hasOcc !== 0 && !ghosting) {
        // prevent-entry tranh (world): DDA chặn hạt ở mặt biên trước khi lọt vào ô occupied + surface-slide.
        sweepBlocked(_p, _v, _pPrev, p.occ, p.occSnapshot, p.occSnapshotRaw, p.occNormals,
                     sdt, p.gravityX, p.gravityY, p.occSlip);
        // (R2) shed hạt đọng mép tranh: creep VỊ TRÍ. Kênh RIÊNG (không đụng v) vì cap eject kẹp drive-trượt qua
        // kênh vận tốc. creepSpeed<=0 -> no-op (default TẮT).
        creepDownhill(_p, p.occ, p.occSnapshot, p.occSnapshotRaw, sdt, p.gravityX, p.gravityY);
      }
    }

    positions[i2] = _p.x; positions[i2 + 1] = _p.y;
    velocities[i2] = _v.x; velocities[i2 + 1] = _v.y;
    if (ghost[i] !== 0 && !ghosting) ghost[i] = 0;   // chỉ ghi khi ĐỔI -> hạt thường không đụng mảng

    posPredicted[i2] = _p.x;                         // mốc để finalize suy velocity feedback từ dịch chuyển contact
    posPredicted[i2 + 1] = _p.y;
  }
}

// --- escape-guard (net cuối) ------------------------------------------------------------------------------------------

/** Mã BĂNG mà escapeGuard bắt được hạt escape — khớp 1-1 với chuỗi băng của isEscaped. */
export const BAND_NONE = 0;
export const BAND_CONVEYOR = 1;
export const BAND_CHUTE = 2;
export const BAND_FUNNEL = 3;
export const BAND_FRAME = 4;        // <- Bug 1-F2 (contact-push tống hạt xuyên khung tranh)
export const BAND_ABOVE_FRAME = 5;
export const BAND_NAN = 6;
export const BAND_COUNT = 7;

/**
 * Nửa bề ngang hành lang tại ly, nội suy tuyến tính đường tâm tường xiên trên băng [y0..y1] (h0->h1) = ĐÚNG segment
 * gốc TRƯỚC fillet -> ở góc bo hành lang rộng hơn tường thật một chút = thiên về KHÔNG flag oan (guard là net cuối).
 */
function corridorHalf(ly: number, y0: number, y1: number, h0: number, h1: number): number {
  const dy = y1 - y0;
  if (dy <= 1e-6) return Math.max(h0, h1);   // băng thoái hoá (bộ phận tắt) — lấy rộng hơn cho an toàn
  return lerp(h0, h1, saturate((ly - y0) / dy));
}

/** Băng mà hạt escape rơi vào; BAND_NONE = chưa escape. */
export interface EscapeResult { escaped: boolean; band: number; }
const _esc: EscapeResult = { escaped: false, band: BAND_NONE };

/**
 * Hạt (GEOMETRY-LOCAL) đã ra NGOÀI lòng rig chưa — dispatch 4 BĂNG theo ly, mỗi băng lấy giới hạn của ĐÚNG bộ phận
 * bao quanh nó. Băng của bộ phận TẮT tự thoái hoá cao 0 nên chuỗi if bỏ qua, khỏi cờ riêng.
 *
 * VÌ SAO test HÀNH LANG chứ không "hạt nằm trong dải collider thì bắt": dải collider CHÍNH LÀ chỗ hạt hợp lệ sống —
 * clampSegment cho hạt nghỉ tại ĐÚNG d=thr. Tường đẩy ra phía GẦN NHẤT (2 phía) ⇒ chỉ có 2 trạng thái nghỉ, ĐỐI XỨNG
 * qua đường tâm: hạt hợp lệ ở corridorHalf-thr, hạt ĐÃ xuyên bị chính clampSegment ghim ở corridorHalf+thr. Nên ngưỡng
 * đặt ở ĐƯỜNG TÂM tường là tách được 2 trạng thái đó với biên thr đều 2 bên — và m suy từ thr nên tune hình học là
 * margin tự ăn theo, KHÔNG cần knob.
 */
export function isEscaped(lp: V2, sdf: GrainSdfField, out: EscapeResult): EscapeResult {
  const m = 0.5 * thrOf(sdf);   // nửa biên nghỉ: hạt hợp lệ phải đi 1.5×thr mới bị flag oan, hạt xuyên bị ghim ở thr
  const ax = Math.abs(lp.x);

  if (lp.y <= sdf.rOut) {       // BĂNG 1 — CONVEYOR (stadium ring), gồm cả đáy
    out.band = BAND_CONVEYOR;
    const cx = lp.x < -sdf.halfBody ? -sdf.halfBody : (lp.x > sdf.halfBody ? sdf.halfBody : lp.x);
    const d = Math.hypot(lp.x - cx, lp.y);
    out.escaped = d > sdf.rOut + m      // xuyên vành NGOÀI (gồm "lọt đáy": ly<-rOut ⇒ d>rOut)
               || d < sdf.rIn - m;      // lọt LÕI ĐẶC inner-hole
    return out;
  }
  if (lp.y <= sdf.chuteTopY) {  // BĂNG 2 — CHUTE: tường xiên gapHalf(đáy) -> chuteInHalf(nóc)
    out.band = BAND_CHUTE;
    out.escaped = ax > corridorHalf(lp.y, sdf.rOut, sdf.chuteTopY, sdf.gapHalf, sdf.chuteInHalf) + m;
    return out;
  }
  if (lp.y <= sdf.funnelTopY) { // BĂNG 3 — CẠNH CHÉO PHỄU: chuteInHalf -> wallX
    out.band = BAND_FUNNEL;
    out.escaped = ax > corridorHalf(lp.y, sdf.chuteTopY, sdf.funnelTopY, sdf.chuteInHalf, sdf.wallX) + m;
    return out;
  }
  if (lp.y <= sdf.wallTop + m) { // BĂNG 4 — KHUNG TRANH: 2 tường DỌC tại ±wallX
    out.band = BAND_FRAME;
    out.escaped = ax > sdf.wallX + m;
    return out;
  }
  // TRÊN nóc khung: có nóc -> hạt trên đó đã xuyên nóc. Không có nóc -> hở lên vùng TRANH, hạt emit rơi xuống là HỢP
  // LỆ ⇒ KHÔNG chặn ly được (điểm mù CỐ Ý), chỉ còn net ngang thô.
  out.band = BAND_ABOVE_FRAME;
  out.escaped = sdf.hasTopWall !== 0 ? true : ax > sdf.bboxHalfX + m;
  return out;
}

/**
 * Unity.Mathematics.Random — xorshift32.
 * ⚠ GIẢ ĐỊNH: Unity.Mathematics KHÔNG có trong IR (là package ngoài project), nên hằng số/thứ tự ở đây tái dựng theo
 * ngữ nghĩa đã biết của `Random(uint seed)` + `NextFloat()`. Chỉ chi phối JITTER x lúc respawn (chống chồng chất tại
 * 1 điểm) — KHÔNG chi phối hành vi tổng. Đánh dấu để P6 xác nhận nếu parity lệch ở nhánh escape.
 */
class XorShift32 {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
    this.nextState();
  }
  nextState(): number {
    let x = this.state;
    const t = x;
    x ^= (x << 13) >>> 0;
    x = x >>> 0;
    x ^= x >>> 17;
    x ^= (x << 5) >>> 0;
    this.state = x >>> 0;
    return t >>> 0;
  }
  /** NextFloat() ∈ [0,1) qua mantissa-inject, rồi map về [min,max). */
  nextFloat(min: number, max: number): number {
    const bits = (0x3f800000 | (this.nextState() >>> 9)) >>> 0;
    const f = new Float32Array(new Uint32Array([bits]).buffer)[0] - 1;
    return f * (max - min) + min;
  }
}

/**
 * NET CUỐI: hạt TUNNELING ra ngoài rig (contact-push đẩy qua tường SDF quá band clampOuter -> frame sau bắt hụt ->
 * thoát VĨNH VIỄN) bị GIẬT về miệng phễu + zero-vel, GIỮ colorId/carried -> COUNTER-NEUTRAL (LiveCount không tụt,
 * màu/pixel bảo toàn — level không kẹt vì mất cát).
 * Chạy SAU finalize, TRƯỚC killBelowY -> hạt lọt đáy tái tuần hoàn thay vì bị kill.
 * `bandCounts` (tuỳ chọn, độ dài BAND_COUNT) = đếm theo băng cho diag; chỉ băng FRAME mới LÀ Bug 1-F2.
 * Trả về số hạt bị giật về.
 */
export function escapeGuard(positions: Float32Array, velocities: Float32Array, asleep: Uint8Array,
                            count: number, sdf: GrainSdfField, bandCounts?: Int32Array): number {
  let respawned = 0;
  for (let i = 0; i < count; i++) {
    if (asleep[i] !== 0) continue;              // hạt ngủ = đã lắng trong rig, không thể tunneling
    const i2 = i * 2;
    const px = positions[i2], py = positions[i2 + 1];
    const finite = Number.isFinite(px) && Number.isFinite(py);
    let escaped = !finite;
    let band = BAND_NAN;
    if (finite) {
      xformPoint(sdf.worldToLocal, px, py, _lp);
      isEscaped(_lp, sdf, _esc);
      escaped = _esc.escaped;
      band = _esc.band;
    }
    if (!escaped) continue;
    if (bandCounts) bandCounts[band]++;

    // Teleport về miệng phễu (local) + jitter x chống chồng chất tại 1 điểm (seed theo i).
    const rng = new XorShift32(i + 1);
    const jitter = rng.nextFloat(-1, 1) * sdf.radiusLocal * 2;
    xformPoint(sdf.localToWorld, sdf.respawnLocalX + jitter, sdf.respawnLocalY, _tmp);
    positions[i2] = _tmp.x;
    positions[i2 + 1] = _tmp.y;
    velocities[i2] = 0;
    velocities[i2 + 1] = 0;     // KHÔNG đụng colorId/carried -> counter-neutral
    respawned++;
  }
  return respawned;
}
