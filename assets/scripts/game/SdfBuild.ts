// A1 — BUILDER tường SDF. Port `GrainFlowBackend.BuildSdfField` + `BuildSideCorners` + `BuildFilletedPolyline`
// + `AppendFilletedCorner` + `AppendPolylineSegments` + `BuildWallGrid`
// (ir/code/!_Game_SDK/SandFlow/Flow/Grain/GrainFlowBackend.cs:2731-2995).
//
// P4a đã port phần CLAMP (solver/sdfWalls.ts) nhưng KHÔNG port builder, nên `AdRoot` phải chạy `hasSdf = 0`:
// hạt rơi tự do khỏi vùng tranh rồi bị `killBelowY` loại, escape-guard không chạy. File này đóng lỗ hổng đó.
//
// KHÔNG có toán mới ở đây — chỉ là builder, và mọi hằng số đọc từ SandTuning.ts (đã bake từ ir/tuning.json).
//
// KHÔNG GIAN: mọi thứ dựng ở GEOMETRY-LOCAL (raw coords). Ma trận local->world = TRS(rigPos) × Scale(geomScale).
// Nguồn còn nhân thêm `anchor.localToWorldMatrix` (transform của GO flowRoot); bên Cocos rig KHÔNG có node cha
// riêng — toạ độ world của ad này chính là hệ đó — nên anchor = identity. Đổi ý sau thì sửa ĐÚNG chỗ makeRigMatrix.
//
// KHÔNG PORT (có chủ ý):
// · cửa trượt gateWall (`hasDoor`): nó đóng khe entry khi belt ĐẦY, mà ConveyorController là shell no-op
//   (manifest P2 chuyển sang bake data-only) -> không có nguồn đóng/mở. `doorThr` vẫn tính đúng công thức để
//   bật lại không phải đi tìm số.

import {
  mat4Identity, thrOf, SEG_STRIDE,
  type GrainSdfField, type GrainWallGrid, type Mat4,
} from '../solver/sdfWalls';
import { SAND_TUNING, CONVEYOR_SHAPE, RIG_LAYOUT } from './SandTuning';

/** Sản phẩm của builder — nhét thẳng vào SolverParams. */
export interface SdfRig {
  sdf: GrainSdfField;
  /** stride 4 (ax, ay, bx, by), GEOMETRY-LOCAL. */
  segments: Float32Array;
  grid: GrainWallGrid;
  cellStart: Int32Array;
  cellItems: Int32Array;
  /** stride 2 (lo, hi) mỗi ô — bitmask segment. */
  cellMask: Uint32Array;
}

/** TRS(rigPos, identity) × Scale(geomScale), column-major (index = col*4 + row) khớp Unity float4x4. */
function makeRigMatrix(px: number, py: number, s: number): { l2w: Mat4; w2l: Mat4 } {
  const l2w = mat4Identity();
  l2w[0] = s; l2w[5] = s; l2w[10] = s;
  l2w[12] = px; l2w[13] = py; l2w[14] = 0;

  const inv = 1 / s;
  const w2l = mat4Identity();
  w2l[0] = inv; w2l[5] = inv; w2l[10] = inv;
  w2l[12] = -px * inv; w2l[13] = -py * inv; w2l[14] = 0;
  return { l2w, w2l };
}

interface Corner { x: number; y: number; r: number }

/**
 * Danh sách góc (LOCAL) 1 BÊN từ ĐÁY (ô entry) đi LÊN + bán kính bo mỗi góc (0 = nhọn/endpoint).
 * Port `BuildSideCorners`. sign = -1 trái / +1 phải.
 */
function buildSideCorners(sign: number, frame: boolean, hasChute: boolean, wallX: number, funnelTopY: number,
                          wallTop: number, chuteInHalf: number, chuteTopY: number, gapHalf: number, rOut: number,
                          frameR: number, junctionR: number): Corner[] {
  const out: Corner[] = [];
  out.push({ x: sign * gapHalf, y: rOut, r: 0 });                                  // đáy = ô entry (endpoint)
  if (hasChute) out.push({ x: sign * chuteInHalf, y: chuteTopY, r: junctionR });   // đỉnh chute = đáy cạnh chéo
  out.push({ x: sign * wallX, y: funnelTopY, r: frame ? frameR : 0 });             // đỉnh cạnh chéo = góc đáy khung
  if (frame) out.push({ x: sign * wallX, y: wallTop, r: frameR });                 // nóc tường khung
  return out;
}

/**
 * Bo góc B (giữa A-B-C) bán kính r -> append cung tiếp tuyến THAY điểm nhọn B. Port `AppendFilletedCorner`.
 * Góc thẳng/gập -> giữ nhọn.
 */
function appendFilletedCorner(pts: number[], ax: number, ay: number, bx: number, by: number,
                              cx: number, cy: number, r: number, segs: number): void {
  let d1x = ax - bx, d1y = ay - by;
  const l1 = Math.sqrt(d1x * d1x + d1y * d1y);
  if (l1 > 0) { d1x /= l1; d1y /= l1; }
  let d2x = cx - bx, d2y = cy - by;
  const l2 = Math.sqrt(d2x * d2x + d2y * d2y);
  if (l2 > 0) { d2x /= l2; d2y /= l2; }

  let dot = d1x * d2x + d1y * d2y;
  if (dot < -1) dot = -1; else if (dot > 1) dot = 1;
  const theta = Math.acos(dot);
  if (theta < 1e-3 || theta > Math.PI - 1e-3) { pts.push(bx, by); return; }

  const halfT = theta * 0.5;
  let rr = r;
  let back = rr / Math.tan(halfT);
  const maxBack = 0.49 * Math.min(l1, l2);
  if (back > maxBack && maxBack > 1e-5) { back = maxBack; rr = back * Math.tan(halfT); }

  const t1x = bx + d1x * back, t1y = by + d1y * back;
  const t2x = bx + d2x * back, t2y = by + d2y * back;
  let bisX = d1x + d2x, bisY = d1y + d2y;
  const bl = Math.sqrt(bisX * bisX + bisY * bisY);
  if (bl > 0) { bisX /= bl; bisY /= bl; }
  const dist = rr / Math.sin(halfT);
  const ccx = bx + bisX * dist, ccy = by + bisY * dist;

  const a1 = Math.atan2(t1y - ccy, t1x - ccx);
  const a2 = Math.atan2(t2y - ccy, t2x - ccx);
  // Mathf.DeltaAngle: đưa hiệu góc về (-180, 180] rồi mới đổi lại radian.
  let delta = a2 - a1;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;

  const n = Math.max(1, segs);
  for (let i = 0; i <= n; i++) {
    const ang = a1 + delta * (i / n);
    pts.push(ccx + rr * Math.cos(ang), ccy + rr * Math.sin(ang));
  }
}

/** Port `BuildFilletedPolyline` — trả mảng phẳng x,y,x,y. Đầu/cuối GIỮ nguyên (endpoint không bo). */
function buildFilletedPolyline(corners: Corner[], arcSegs: number): number[] {
  const pts: number[] = [];
  if (corners.length === 0) return pts;
  pts.push(corners[0].x, corners[0].y);
  for (let i = 1; i < corners.length - 1; i++) {
    const r = corners[i].r;
    if (r > 1e-4) {
      appendFilletedCorner(pts, corners[i - 1].x, corners[i - 1].y, corners[i].x, corners[i].y,
                           corners[i + 1].x, corners[i + 1].y, r, arcSegs);
    } else {
      pts.push(corners[i].x, corners[i].y);
    }
  }
  const last = corners[corners.length - 1];
  pts.push(last.x, last.y);
  return pts;
}

/** Port `AppendPolylineSegments` — nối điểm liên tiếp, BỎ đoạn 0 chiều dài (ngưỡng sqrMagnitude 1e-8 của nguồn). */
function appendPolylineSegments(segs: number[], pts: number[]): void {
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i], ay = pts[i + 1], bx = pts[i + 2], by = pts[i + 3];
    const dx = bx - ax, dy = by - ay;
    if (dx * dx + dy * dy < 1e-8) continue;
    segs.push(ax, ay, bx, by);
  }
}

/**
 * Dựng toàn bộ rig tường: stadium ring (annulus giải analytic) + segment phễu/chute/khung + broad-phase grid.
 * Port `BuildSdfField`.
 */
export function buildSdfRig(): SdfRig {
  const T = SAND_TUNING;
  const shape = CONVEYOR_SHAPE;

  const halfBody = shape.bodyLength * 0.5;
  const rIn = Math.max(0, shape.innerHoleRadius);
  const rOut = rIn + shape.channelWidth;
  const gapHalf = Math.min(T.entryGapWidth * 0.5, halfBody * 0.9);
  const mouthHalf = T.funnelMouthHalfWidth;
  const geomScale = Math.max(0.0001, RIG_LAYOUT.geomScale);

  // FrameWallOutset là quãng đẩy tường khung RA (đơn vị WORLD) -> chia geomScale để về local. 0 = hình học gốc.
  const wallX = mouthHalf + Math.max(0, T.frameWallOutset) / geomScale;
  const chuteLength = Math.max(0, T.chuteLength);
  const hasChute = chuteLength > 1e-3;
  const chuteInHalf = hasChute ? Math.max(0.01, T.chuteInputWidth * 0.5) : gapHalf;
  const chuteTopY = rOut + chuteLength;
  const funnelTopY = chuteTopY + T.funnelHeight;
  const frame = T.buildFrameWalls;
  const frameExtent = T.frameWallHeight + T.frameWallExtraHeight;
  const wallTop = funnelTopY + frameExtent;

  const frameR = Math.max(0, T.frameCornerRadius);
  const junctionR = Math.max(0, T.chuteJunctionCornerRadius);
  // Mathf.Clamp(capSegments / 4, 2, 16) — capSegments là int nên phép chia là INT DIVISION bên C#.
  const arcSegs = Math.min(16, Math.max(2, Math.trunc(T.capSegments / 4)));

  const left = buildSideCorners(-1, frame, hasChute, wallX, funnelTopY, wallTop, chuteInHalf, chuteTopY,
                                gapHalf, rOut, frameR, junctionR);
  const right = buildSideCorners(+1, frame, hasChute, wallX, funnelTopY, wallTop, chuteInHalf, chuteTopY,
                                 gapHalf, rOut, frameR, junctionR);

  const segList: number[] = [];
  if (frame && T.buildTopWall) {
    // Hàn 1 polyline: trái (đáy->nóc) + phải ĐẢO (nóc->đáy) => 2 góc NÓC trở thành interior nên được bo frameR.
    right.reverse();
    appendPolylineSegments(segList, buildFilletedPolyline(left.concat(right), arcSegs));
  } else {
    appendPolylineSegments(segList, buildFilletedPolyline(left, arcSegs));
    appendPolylineSegments(segList, buildFilletedPolyline(right, arcSegs));
  }
  const segments = new Float32Array(segList);
  const segmentCount = (segments.length / SEG_STRIDE) | 0;

  const { l2w, w2l } = makeRigMatrix(RIG_LAYOUT.rigPositionX, RIG_LAYOUT.rigPositionY, geomScale);

  const sdf: GrainSdfField = {
    worldToLocal: w2l,
    localToWorld: l2w,
    halfBody,
    rIn,
    rOut,
    gapHalf,
    // edgeRadius/radiusLocal là số WORLD trong config -> đổi sang local. KHÔNG chia thì thr nuốt trọn
    // channelWidth và dải tường chứa vùng SỤP ÂM (nguồn ghi rõ bẫy này ngay tại chỗ khởi tạo).
    edgeRadius: T.edgeRadius / geomScale,
    radiusLocal: T.grainParticleRadius / geomScale,
    doorThr: ((T.edgeRadius + T.grainParticleRadius) / geomScale) * Math.max(0, T.grainGateWallThicknessMul),
    beltHalfX: halfBody + rOut,
    beltTopY: rOut,
    segmentCount,

    respawnLocalX: 0,
    respawnLocalY: funnelTopY,
    chuteInHalf,
    wallX,
    chuteTopY,
    funnelTopY,
    wallTop: frame ? wallTop : funnelTopY,
    hasTopWall: frame && T.buildTopWall ? 1 : 0,
    bboxHalfX: Math.max(halfBody + rOut, wallX),
  };

  return { sdf, segments, ...buildWallGrid(sdf, segments, segmentCount) };
}

/** Dải ô mà AABB của segment `s` nở thêm `pad` phủ tới (đã clamp vào grid). Port `WallGridCellRange`. */
function cellRange(segs: Float32Array, s: number, originX: number, originY: number, cell: number,
                   nx: number, ny: number, pad: number, out: Int32Array): void {
  const o = s * SEG_STRIDE;
  const ax = segs[o], ay = segs[o + 1], bx = segs[o + 2], by = segs[o + 3];
  const minX = Math.min(ax, bx) - pad, maxX = Math.max(ax, bx) + pad;
  const minY = Math.min(ay, by) - pad, maxY = Math.max(ay, by) + pad;
  const cl = (v: number, hi: number) => (v < 0 ? 0 : (v > hi ? hi : v));
  out[0] = cl(Math.floor((minX - originX) / cell), nx - 1);
  out[1] = cl(Math.floor((maxX - originX) / cell), nx - 1);
  out[2] = cl(Math.floor((minY - originY) / cell), ny - 1);
  out[3] = cl(Math.floor((maxY - originY) / cell), ny - 1);
}

/**
 * Broad-phase uniform-grid trên mảng segment. Port `BuildWallGrid`.
 *
 * Bin CONSERVATIVE (segment vào MỌI ô mà AABB nở (roam+thr) phủ tới) = siêu tập của "segment có thể clamp một
 * điểm nào đó trong ô" -> thừa ứng viên KHÔNG đổi kết quả, chỉ tốn thêm vài phép so. Pass fill duyệt s TĂNG DẦN
 * nên danh sách mỗi ô tự sắp tăng = giữ nguyên thứ tự clampSegment.
 *
 * `ulong` của nguồn -> cặp (lo, hi) Uint32 đúng như solver/sdfWalls.ts đã quy ước.
 */
function buildWallGrid(sdf: GrainSdfField, segs: Float32Array, segCount: number):
    { grid: GrainWallGrid; cellStart: Int32Array; cellItems: Int32Array; cellMask: Uint32Array } {
  const off = {
    grid: { originX: 0, originY: 0, cellSize: 1, nx: 1, ny: 1, roam: 0, enabled: 0, maskValid: 0 } as GrainWallGrid,
    cellStart: new Int32Array(1),
    cellItems: new Int32Array(0),
    cellMask: new Uint32Array(2),
  };
  if (!SAND_TUNING.grainWallGridEnabled || segCount <= 0) return off;

  const thr = thrOf(sdf);
  const cell = Math.max(1e-4, SAND_TUNING.grainWallGridCellMul) * thr;
  const roam = cell;              // A = cạnh ô (1 knob nuôi cả 2, đúng nguồn)
  const pad = roam + thr;

  let loX = Infinity, loY = Infinity, hiX = -Infinity, hiY = -Infinity;
  for (let s = 0; s < segCount; s++) {
    const o = s * SEG_STRIDE;
    loX = Math.min(loX, segs[o], segs[o + 2]);
    loY = Math.min(loY, segs[o + 1], segs[o + 3]);
    hiX = Math.max(hiX, segs[o], segs[o + 2]);
    hiY = Math.max(hiY, segs[o + 1], segs[o + 3]);
  }
  loX -= pad; loY -= pad; hiX += pad; hiY += pad;
  const nx = Math.max(1, Math.ceil((hiX - loX) / cell));
  const ny = Math.max(1, Math.ceil((hiY - loY) / cell));

  // mask 1 bit/segment -> chỉ dựng được khi segCount <= 64. Vượt trần: đường INTEGRATE quét trọn (maskValid=0),
  // đường CONTACT/CSR không đổi.
  const maskOk = segCount <= 64;
  const grid: GrainWallGrid = {
    originX: loX, originY: loY, cellSize: cell, nx, ny, roam, enabled: 1, maskValid: maskOk ? 1 : 0,
  };

  const cellTotal = nx * ny;
  const counts = new Int32Array(cellTotal);
  const r = new Int32Array(4);

  for (let s = 0; s < segCount; s++) {
    cellRange(segs, s, loX, loY, cell, nx, ny, pad, r);
    for (let gy = r[2]; gy <= r[3]; gy++) for (let gx = r[0]; gx <= r[1]; gx++) counts[gy * nx + gx]++;
  }
  const cellStart = new Int32Array(cellTotal + 1);
  let running = 0;
  for (let c = 0; c < cellTotal; c++) { cellStart[c] = running; running += counts[c]; }
  cellStart[cellTotal] = running;

  const cellItems = new Int32Array(running);
  const cellMask = new Uint32Array(maskOk ? cellTotal * 2 : 2);
  const cursor = new Int32Array(cellTotal);

  for (let s = 0; s < segCount; s++) {
    cellRange(segs, s, loX, loY, cell, nx, ny, pad, r);
    const bitLo = maskOk && s < 32 ? (1 << s) >>> 0 : 0;
    const bitHi = maskOk && s >= 32 ? (1 << (s - 32)) >>> 0 : 0;
    for (let gy = r[2]; gy <= r[3]; gy++) {
      for (let gx = r[0]; gx <= r[1]; gx++) {
        const c = gy * nx + gx;
        cellItems[cellStart[c] + cursor[c]] = s;
        cursor[c]++;
        if (maskOk) {
          cellMask[c * 2] = (cellMask[c * 2] | bitLo) >>> 0;
          cellMask[c * 2 + 1] = (cellMask[c * 2 + 1] | bitHi) >>> 0;
        }
      }
    }
  }
  return { grid, cellStart, cellItems, cellMask };
}
