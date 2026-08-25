// PORT Mode A — nguồn: ir/code/!_Game_SDK/SandFlow/Flow/Grain/GrainSdfColliders.cs:363-1137
// (GrainOccupancyField · static GrainOccupancy · GrainDilateOccupancyJob · GrainBuildOccNormalsJob).
//
// Va chạm HẠT ↔ TRANH (pixel chưa tan). PRIMARY = sweepBlocked (PREVENT-ENTRY: DDA Amanatides-Woo chặn hạt ở mặt biên
// TRƯỚC khi vào tranh); resolveOccupancy (gradient-eject) chỉ còn làm FALLBACK cho hạt lỡ spawn-inside.
//
// LỆCH SO VỚI NGUỒN (có chủ ý):
// - `float4 colScrollPy` -> Float32Array(4). `NativeArray<byte>` -> Uint8Array. `NativeArray<float2>` -> Float32Array
//   stride 2.
// - out-param (`out int ox`) -> object TÁI DÙNG ở scope module, không cấp phát trong vòng update.
// - `(int)(pxf / occCellPixels)` của nguồn là TRUNCATE (C# cast) chứ không phải floor — chỗ đó pxf >= 0 đã được guard
//   ngay trên nên 2 phép trùng nhau; port dùng Math.trunc để giữ đúng chữ.
// - ProbeStuckCell KHÔNG port: chỉ SandDropFrameDiag gọi, mà diag nằm trong `excluded` của manifest.
//
// LƯU Ý ĐỌC MÃ: nhiều nhánh ở đây tồn tại để giữ bit-identical với hành vi cũ khi knob = 0 (dilate, slip, creepSpeed,
// edgeApronCells, ejectSearchCells, colCount=1, viewportRows>=pictureHeight). Đừng "dọn" chúng — chúng là đường
// rollback đã được nguồn dùng để A/B từng fix.

import { normalizeSafe, type V2 } from './sdfWalls';

export interface GrainOccupancyField {
  worldOriginX: number; worldOriginY: number;   // = PictureCellToWorld(0,0)
  invRow0X: number; invRow0Y: number;           // px = dot(invRow0, p - worldOrigin)   (picture-pixel)
  invRow1X: number; invRow1Y: number;           // py = dot(invRow1, p - worldOrigin)   (py=0 ĐỈNH tranh)
  pxAxisWorldX: number; pxAxisWorldY: number;   // hướng world chuẩn hoá của +1 picture-px
  pyAxisWorldX: number; pyAxisWorldY: number;   // hướng world chuẩn hoá của +1 picture-py

  occWidth: number;
  occHeight: number;
  occCellPixels: number;    // picture-px / occ-cell (đường Grain LUÔN = 1: BuildOccupancyField ép FINE per-pixel)
  pictureWidth: number;
  pictureHeight: number;

  pushStrength: number;     // vận tốc đẩy ra khỏi pixel tranh (world/s) — đọc LIVE
  maxStep: number;          // CLAMP dịch chuyển đẩy/call (world) — chống VỌT lên quá mặt = nảy
  smoothRadius: number;     // bán kính cửa sổ gộp normal macro (occ-cell)
  dilateCells: number;      // số ô snapshot ĐÃ dilate; 0 = snapshot raw
  edgeApronCells: number;   // SEAL mép X: số ô ngoài mép đọc-theo-ô-mép; 0 = không seal = bit-identical
  ejectSearchCells: number; // bán kính quét ô TRỐNG gần nhất khi gradient suy biến; 0 = hành vi cũ

  creepWindow: number;      // bán kính cửa sổ quét ô-trống-xuôi-nhất (2-3)
  creepSpeed: number;       // vận tốc creep VỊ TRÍ (world/s); <=0 = TẮT
  creepSlopeMin: number;    // ngưỡng dot(dirÔTrống, hướng-trọng-lực) để coi "xuôi" (~0.3)
  creepLateralMax: number;  // tầm quét MÉP RƠI 2 bên (ô tranh THẬT); <=0 -> 4

  colScrollPy: Float32Array; // s_i = số hàng pixel cột i ĐÃ TỤT (4 slot, k<=4)
  colCount: number;          // k ∈ [1..4]. 1 = không scroll
  colWidthPx: number;        // pw/k (picture-px, có thể LẺ)
  viewportRows: number;      // Vh — clamp dải ĐÃ LỘ; >= pictureHeight -> tắt
}

// --- helper đọc ô ------------------------------------------------------------------------------------------------

/**
 * Ô (ox,oy) có CHẶN không. oxMin/oxMax = biên occ-cell của CỘT đang xét (ngoài cột = affine sai ⇒ coi như trống, xem
 * nợ seam ở sweepBlocked); oyMin = mép trên dải ĐÃ LỘ. Caller tính 3 số này 1 LẦN/hạt rồi truyền xuống — KHÔNG tính
 * lại trong vòng DDA.
 */
export function occAt(s: Uint8Array, occ: GrainOccupancyField,
                      ox: number, oy: number, oxMin: number, oxMax: number, oyMin: number): boolean {
  if (ox < oxMin || ox > oxMax || oy < oyMin || oy >= occ.occHeight) return false;
  return s[oy * occ.occWidth + ox] !== 0;
}

/**
 * Như occAt nhưng SEAL mép X NGOÀI grid: ox vượt biên TOÀN CỤC trong tầm edgeApronCells thì đọc THEO Ô MÉP
 * (clamp-to-edge) — bịt hành lang rơi-tự-do giữa tường khung (đã FrameWallOutset) và mép tranh.
 * CHỈ dùng cho vai CHẶN của DDA — vai phán-đang-ở-trong + eject giữ occAt thường (seal cả 2 = hạt trong khe bị coi
 * "kẹt trong tranh" ⇒ freeze ⇒ giằng với tường = đúng bug cũ). Biên CỘT scroll NỘI BỘ KHÔNG seal.
 */
export function occAtSealX(s: Uint8Array, occ: GrainOccupancyField,
                           ox: number, oy: number, oxMin: number, oxMax: number, oyMin: number): boolean {
  const apron = occ.edgeApronCells;
  if (apron > 0) {
    if (ox < oxMin) { if (oxMin === 0 && oxMin - ox <= apron) ox = oxMin; }
    else if (ox > oxMax) { if (oxMax === occ.occWidth - 1 && ox - oxMax <= apron) ox = oxMax; }
  }
  return occAt(s, occ, ox, oy, oxMin, oxMax, oyMin);
}

function occF(s: Uint8Array, occ: GrainOccupancyField,
              ox: number, oy: number, oxMin: number, oxMax: number, oyMin: number): number {
  return occAt(s, occ, ox, oy, oxMin, oxMax, oyMin) ? 1 : 0;
}

/**
 * Cột chứa picture-x `px` — CÙNG luật với PictureColliderBuilder.ColumnOfPictureX (clamp về cột biên vì px được phép
 * NGOÀI [0,pw) — vùng phễu dưới đáy tranh). colCount<=1 -> LUÔN 0.
 */
export function colOfPx(occ: GrainOccupancyField, px: number): number {
  if (occ.colCount <= 1) return 0;
  const c = Math.floor(px / occ.colWidthPx);
  return c < 0 ? 0 : (c > occ.colCount - 1 ? occ.colCount - 1 : c);
}

/** s_i của cột `col`. */
export function scrollPyOf(occ: GrainOccupancyField, col: number): number {
  return occ.colScrollPy[col];
}

/** Biên occ-cell [oxMin..oxMax] của cột `col`. CEIL 2 đầu để khớp CHÍNH XÁC floor(px/colWidthPx)==col khi colWidthPx LẺ. */
export interface ColBounds { oxMin: number; oxMax: number; }
const _bounds: ColBounds = { oxMin: 0, oxMax: 0 };

export function colOccBounds(occ: GrainOccupancyField, col: number, out: ColBounds): ColBounds {
  if (occ.colCount <= 1) { out.oxMin = 0; out.oxMax = occ.occWidth - 1; return out; }
  const invCell = 1 / occ.occCellPixels;
  out.oxMin = Math.max(0, Math.ceil(col * occ.colWidthPx * invCell));
  out.oxMax = Math.min(occ.occWidth - 1, Math.ceil((col + 1) * occ.colWidthPx * invCell) - 1);
  return out;
}

/**
 * Mép TRÊN (occ-cell) của dải ĐÃ LỘ ở cột `col`: hàng py < ph-Vh-s_i nằm TRÊN cửa sổ -> LevelSpawner chưa bake
 * (alpha 0, VÔ HÌNH) -> không được chặn hạt (visible <=> collidable).
 */
export function revealOyMin(occ: GrainOccupancyField, col: number): number {
  if (occ.viewportRows <= 0 || occ.viewportRows >= occ.pictureHeight) return 0;
  const pyTop = occ.pictureHeight - occ.viewportRows - scrollPyOf(occ, col);
  return Math.max(0, Math.floor(pyTop / occ.occCellPixels));
}

// --- sweepBlocked (PRIMARY) ---------------------------------------------------------------------------------------

/**
 * (F2.4) Số LẦN cho phần dịch chuyển CÒN LẠI được trượt tiếp dọc contour trong CÙNG 1 bước. 1 = hành vi trước F2.4
 * (chạm mặt là vứt phần còn lại). PROBE 12 đo xong: dốc 3->4 = lever chết, root ở tầng vận tốc -> về 3.
 */
const SLIDE_BOUNCES = 3;

const _from: V2 = { x: 0, y: 0 };
const _target: V2 = { x: 0, y: 0 };

/**
 * PREVENT-ENTRY sweep — DDA voxel (Amanatides-Woo) quét occ-cell dọc đoạn pPrev->p, gặp ô occupied ĐẦU TIÊN thì DỪNG
 * hạt ngay TRƯỚC mặt biên + giết vận tốc ĐÂM vào mặt (theo trục vừa băng). Dissolve ĐƠN ĐIỆU (ô chỉ occupied->trống)
 * ⇒ hạt đang ở NGOÀI không bao giờ kẹt trong ô mới-occupied; DDA visit MỌI cell ⇒ không tunneling.
 *
 * @param snapshot    bản CHẶN-VÀO = raw ĐÃ dilate N ô — bù bán kính hạt mà DDA điểm-tâm bỏ qua.
 * @param snapshotRaw bản TRANH THẬT (chưa dilate) — phán "hạt đang Ở TRONG" + gradient-eject.
 *                    dilate=0 -> caller truyền TRÙNG `snapshot` ⇒ mọi nhánh rút về đường cũ bit-identical.
 * @param slip        0 -> BIT-IDENTICAL bản trước F2.4 (return ngay sau khi giết vận tốc pháp tuyến).
 */
export function sweepBlocked(p: V2, v: V2, pPrev: V2, occ: GrainOccupancyField,
                             snapshot: Uint8Array, snapshotRaw: Uint8Array, normals: Float32Array,
                             sdt: number, gravityX: number, gravityY: number, slip: number): void {
  const invCell = 1 / occ.occCellPixels;
  const relPrevX = pPrev.x - occ.worldOriginX, relPrevY = pPrev.y - occ.worldOriginY;
  const pxPrev = occ.invRow0X * relPrevX + occ.invRow0Y * relPrevY;

  // SCROLL: chọn cột MỘT LẦN từ đầu đoạn rồi dùng affine cột đó cho CẢ sweep. Hợp lệ vì px scroll-invariant + 1 hạt
  // tại 1 thời điểm nằm dưới ĐÚNG 1 cột. THÂN DDA dưới KHÔNG biết gì về cột — chỉ occAt bị bound lại.
  // NỢ ĐÃ BIẾT: hạt băng qua SEAM trong 1 substep bị cắt sweep ở biên cột; substep sau cột kia bắt tiếp.
  const col = colOfPx(occ, pxPrev);
  const sPy = scrollPyOf(occ, col);
  colOccBounds(occ, col, _bounds);
  const oxMin = _bounds.oxMin, oxMax = _bounds.oxMax;
  const oyMin = revealOyMin(occ, col);

  // DEFLECT-AND-CONTINUE: chạm mặt -> KHÔNG vứt phần dịch chuyển còn lại mà chiếu nó lên tiếp tuyến mặt MACRO rồi
  // sweep tiếp NGAY trong bước này. Bản trước return thẳng tại mặt ⇒ hạt chỉ nhích được 1 lần chạm/substep ⇒ đọng
  // thành lớp mỏng bám mép (số hạt bám tỉ lệ NGHỊCH với substeps = dấu vân tay của truncation).
  _from.x = pPrev.x; _from.y = pPrev.y;
  _target.x = p.x; _target.y = p.y;

  for (let bounce = 0; bounce < SLIDE_BOUNCES; bounce++) {
    const relFromX = _from.x - occ.worldOriginX, relFromY = _from.y - occ.worldOriginY;
    const relToX = _target.x - occ.worldOriginX, relToY = _target.y - occ.worldOriginY;
    const cx0 = (occ.invRow0X * relFromX + occ.invRow0Y * relFromY) * invCell;
    const cy0 = (occ.invRow1X * relFromX + occ.invRow1Y * relFromY - sPy) * invCell;
    const cx1 = (occ.invRow0X * relToX + occ.invRow0Y * relToY) * invCell;
    const cy1 = (occ.invRow1X * relToX + occ.invRow1Y * relToY - sPy) * invCell;

    let ox = Math.floor(cx0);
    let oy = Math.floor(cy0);

    // pPrev đã kẹt TRONG tranh: điểm xuất phát không hợp lệ để sweep -> gradient-eject best-effort. HOÀN TÁC bước đi
    // trước khi eject (giữ nguyên `p` = pPrev+bước thì bước vẫn được áp TRỌN, chỉ nudge ngược lại tối đa maxStep ⇒
    // trong vòng contact, delta tới maxPush ĐÈ nudge 10× ⇒ hạt lún sâu thêm mỗi iter rồi xuyên hẳn sang bên kia).
    // CHỈ eject ở lượt ĐẦU: mỗi resolveOccupancy cộng thêm min(pushStrength·sdt, maxStep); gọi nhiều lần trong 1 bước
    // = khuếch đại lực đẩy (đúng cơ chế đã làm hạt BẮN XUYÊN LÊN khi substeps=24).
    // TÁCH 2 VAI: RAW = tranh THẬT -> phán "đang ở TRONG" + eject; DILATED -> CHẶN-VÀO. Dùng chung bản dilated cho cả
    // 2 vai ⇒ hạt emit sát pixel Solid sinh ra TRONG VÀNH dilate bị coi là "kẹt trong tranh" ⇒ đóng băng + eject theo
    // gradient DILATED (bao kín ảo) = hạt TRÔI LÊN giữa tranh.
    if (occAt(snapshotRaw, occ, ox, oy, oxMin, oxMax, oyMin)) {
      p.x = _from.x; p.y = _from.y;
      if (bounce === 0) resolveOccupancy(p, v, occ, snapshotRaw, sdt);
      return;
    }
    const inRing = occAt(snapshot, occ, ox, oy, oxMin, oxMax, oyMin);   // born-inside VÀNH dilate
    const blockArr = inRing ? snapshotRaw : snapshot;                   // mảng CHẶN cho bounce này

    const dcx = cx1 - cx0;
    const dcy = cy1 - cy0;
    const stepX = dcx > 0 ? 1 : (dcx < 0 ? -1 : 0);
    const stepY = dcy > 0 ? 1 : (dcy < 0 ? -1 : 0);
    const INF = 1e30;
    const invdx = stepX !== 0 ? 1 / Math.abs(dcx) : INF;
    const invdy = stepY !== 0 ? 1 / Math.abs(dcy) : INF;
    // t (0..1 dọc đoạn) tới mặt occ-cell kế theo mỗi trục.
    let tMaxX = stepX > 0 ? (ox + 1 - cx0) * invdx : (stepX < 0 ? (cx0 - ox) * invdx : INF);
    let tMaxY = stepY > 0 ? (oy + 1 - cy0) * invdy : (stepY < 0 ? (cy0 - oy) * invdy : INF);

    let hit = false;
    let tHit = 0;
    let axisHit = 0;
    let hitOx = 0;
    let hitOy = 0;
    for (let guard = 0; guard < 64; guard++) {
      let tCross: number;
      let axis: number;
      if (tMaxX < tMaxY) { tCross = tMaxX; ox += stepX; axis = 0; tMaxX += invdx; }
      else { tCross = tMaxY; oy += stepY; axis = 1; tMaxY += invdy; }
      if (tCross > 1) break;                                            // tới target mà không chạm tranh
      // ô trống / ngoài cột / chưa lộ -> đi tiếp (seal mép X — hành lang outset)
      if (!occAtSealX(blockArr, occ, ox, oy, oxMin, oxMax, oyMin)) continue;
      hit = true; tHit = tCross; axisHit = axis; hitOx = ox; hitOy = oy;
      break;
    }

    if (!hit) { p.x = _target.x; p.y = _target.y; return; }              // đi TRỌN phần còn lại

    // CHẠM: dừng hạt ngay TRƯỚC mặt (lùi epsilon để nằm trong ô trống) + giết vận tốc ĐÂM vào mặt (theo trục băng).
    const tStop = Math.max(0, tHit - 1e-3);
    const segX = _target.x - _from.x, segY = _target.y - _from.y;
    p.x = _from.x + tStop * segX;
    p.y = _from.y + tStop * segY;
    const intoX = axisHit === 0 ? stepX * occ.pxAxisWorldX : stepY * occ.pyAxisWorldX;
    const intoY = axisHit === 0 ? stepX * occ.pxAxisWorldY : stepY * occ.pyAxisWorldY;
    const vk = v.x * intoX + v.y * intoY;
    if (vk <= 0) return;                                                // không đâm vào mặt -> không có momentum

    // CHỤP tốc độ VÀO trước khi va chạm chỉnh v. Mép XIÊN ~45°: cross-term của (kill micro-face axis-aligned) +
    // (slide theo tangent macro chéo) DƯƠNG ⇒ |v| PHỒNG ~60%/hit ⇒ runaway ghim-chỗ. Va chạm chỉ được CHUYỂN HƯỚNG
    // momentum, KHÔNG tạo ⇒ cap về vInSq.
    const vInSq = v.x * v.x + v.y * v.y;
    v.x -= vk * intoX;                                                  // giết vận tốc pháp tuyến (micro-face)
    v.y -= vk * intoY;
    if (slip <= 0) return;                                              // slip=0 -> BIT-IDENTICAL bản trước F2.4

    // Normal MACRO = thứ DUY NHẤT cả 2 việc dưới cần. Triệt tiêu (đối xứng/bao kín) ⇒ không có contour để bám vào ⇒
    // giữ hành vi cũ: dừng tại mặt. LOOKUP thay vì tính tại chỗ (81 sample/lần chạm × 16 lần/hạt/step).
    // hitOx/hitOy LUÔN là ô biên (DDA dừng ở ô occupied ĐẦU TIÊN trên tia xuất phát từ ô trống) ⇒ lookup luôn trúng ô
    // đã được build. hit trên ô APRON (ngoài grid, seal đọc theo ô mép) -> clamp index kẻo đọc ngoài mảng.
    const nIdx = (hitOy * occ.occWidth + Math.max(0, Math.min(occ.occWidth - 1, hitOx))) * 2;
    const nMacroX = normals[nIdx], nMacroY = normals[nIdx + 1];
    if (nMacroX * nMacroX + nMacroY * nMacroY <= 1e-6) return;

    // (1) SURFACE-SLIDE tầng VẬN TỐC: chuyển phần momentum vừa bị chặn (vk) sang HƯỚNG DỐC XUỐNG của mặt làm mịn ->
    // hạt TRƯỢT dọc contour thay vì kẹt trên micro-ledge răng-cưa. Mặt macro PHẲNG NGANG -> gTan~0 -> KHÔNG có chiều
    // dốc nào để đẩy ⇒ bỏ qua, hạt đứng yên VẪN đứng yên (đúng angle-of-repose).
    // ⚠ `gl > 1e-5` là guard CHIA-0 (gl là mẫu số), KHÔNG phải chính sách repose — nó chỉ ôm ĐÚNG dòng có phép chia.
    // Bỏ nó = NaN -> escape-guard teleport hạt về miệng phễu.
    const gDot = gravityX * nMacroX + gravityY * nMacroY;
    const gTanX = gravityX - gDot * nMacroX;
    const gTanY = gravityY - gDot * nMacroY;
    const gl = Math.sqrt(gTanX * gTanX + gTanY * gTanY);
    if (gl > 1e-5) {
      v.x += (slip * vk) * (gTanX / gl);
      v.y += (slip * vk) * (gTanY / gl);
    }
    // CAP: slide vừa bơm |v| vượt tốc độ VÀO thì scale ngược về vInSq. Ca mép THẲNG có ΔE<0 nên cap KHÔNG đụng; chỉ
    // chặn phồng ở mép xiên. Cap MỖI vòng bounce ⇒ momentum không compound qua các lần trượt trong 1 bước.
    const vSq = v.x * v.x + v.y * v.y;
    if (vSq > vInSq) {
      const k = Math.sqrt(vInSq / vSq);
      v.x *= k; v.y *= k;
    }

    // (2) F2.5 — DEFLECT tầng DỊCH CHUYỂN: phần đường CÒN LẠI chiếu lên tiếp tuyến MACRO rồi sweep tiếp từ p.
    // Chạy KỂ CẢ khi gl~0: đây là hình học THUẦN (chỉ chiếu lên nMacro đã normalizesafe ⇒ unit), KHÔNG có mẫu số nên
    // guard chia-0 ở trên KHÔNG được phép gác nó (F2.4 đặt nhầm nó DƯỚI guard gl ⇒ hạt LƯỚT NGANG trên gờ phẳng vẫn
    // bị cắt cụt mỗi bước). Dùng nMacro chứ KHÔNG dùng `into`: `into` là micro-face axis-aligned ⇒ trượt dọc nó lại
    // đâm ngay vào bậc kế của staircase.
    const resX = (1 - tStop) * segX, resY = (1 - tStop) * segY;
    const rDot = resX * nMacroX + resY * nMacroY;
    const slideX = resX - rDot * nMacroX;
    const slideY = resY - rDot * nMacroY;
    if (slideX * slideX + slideY * slideY < 1e-12) return;
    _from.x = p.x; _from.y = p.y;
    _target.x = p.x + slideX;
    _target.y = p.y + slideY;
  }
}

// --- resolveOccupancy (FALLBACK gradient-eject) --------------------------------------------------------------------

const _push: V2 = { x: 0, y: 0 };

/**
 * Gradient-eject: hạt ĐANG TRONG ô occupied bị đẩy XUỐNG DỐC mật độ (về phía trống), bước bị kẹp <= maxStep.
 * Chỉ còn là FALLBACK cho hạt spawn-inside — đường chính là sweepBlocked.
 */
/**
 * CHẨN ĐOÁN cú đẩy thoát của resolveOccupancy (2026-08-25). Đo thật: một hạt đứng NGUYÊN toạ độ (-2.41,27.71)
 * suốt 270+ step trong khi |v| tăng 14.5 -> 25.2 — tức bước đi bị hoàn tác mỗi step và cú đẩy ra ĐÚNG 0.
 * Hàm có 3 nhánh thoát sớm khác nhau, mỗi nhánh là một chỗ sửa khác hẳn; không gắn số thì chỉ đoán được.
 *
 * `code`: 0 chưa gọi · 1 NGOÀI tranh · 2 ô KHÔNG đặc (bất thường: sweepBlocked vừa bảo là đặc) ·
 *         3 push suy biến ~0 (nearestFreeDirPic không tìm ra hướng) · 4 CÓ đẩy (kèm step thật).
 * Chỉ ghi khi `occEjectDiag.on` — tắt thì 1 phép so sánh, không đụng đường nóng.
 */
export const occEjectDiag = {
  on: false, code: 0, pushX: 0, pushY: 0, step: 0, calls: 0,
  /** Nhánh + độ đẩy của TỪNG hạt ở step vừa rồi. Bản chỉ-1-biến-toàn-cục trước đó VÔ DỤNG: hạt không hề gọi
   *  resolveOccupancy vẫn in ra số của hạt khác, đọc log tưởng có đẩy mà thật ra không ai gọi. integrate ghi. */
  perGrainCode: null as Uint8Array | null,
  perGrainStep: null as Float32Array | null,
  perGrainPushX: null as Float32Array | null,
  perGrainPushY: null as Float32Array | null,
};

/** Cấp mảng chẩn đoán theo hạt. Gọi 1 lần lúc dựng khi bật probe; không gọi = mọi thứ null = 0 phí. */
export function allocOccEjectDiag(capacity: number): void {
  occEjectDiag.perGrainCode = new Uint8Array(capacity);
  occEjectDiag.perGrainStep = new Float32Array(capacity);
  occEjectDiag.perGrainPushX = new Float32Array(capacity);
  occEjectDiag.perGrainPushY = new Float32Array(capacity);
}

/** Tên nhánh để in ra log. */
export const OCC_EJECT_NAME = ['chua-goi', 'ngoai-tranh', 'o-khong-dac', 'push-suy-bien', 'co-day'];

export function resolveOccupancy(p: V2, v: V2, occ: GrainOccupancyField, snapshot: Uint8Array, sdt: number): void {
  const relX = p.x - occ.worldOriginX, relY = p.y - occ.worldOriginY;
  const pxf = occ.invRow0X * relX + occ.invRow0Y * relY;
  const col = colOfPx(occ, pxf);                                    // cùng phép chọn cột với sweepBlocked
  const pyf = occ.invRow1X * relX + occ.invRow1Y * relY - scrollPyOf(occ, col);
  if (occEjectDiag.on) { occEjectDiag.calls++; occEjectDiag.code = 1; occEjectDiag.step = 0; }
  if (pxf < 0 || pxf >= occ.pictureWidth || pyf < 0 || pyf >= occ.pictureHeight) return;   // ngoài tranh
  colOccBounds(occ, col, _bounds);
  const oxMin = _bounds.oxMin, oxMax = _bounds.oxMax;
  const oyMin = revealOyMin(occ, col);
  const ox = Math.trunc(pxf / occ.occCellPixels);                   // (int) cast của nguồn; pxf>=0 nên == floor
  const oy = Math.trunc(pyf / occ.occCellPixels);
  if (occEjectDiag.on) occEjectDiag.code = 2;
  if (!occAt(snapshot, occ, ox, oy, oxMin, oxMax, oyMin)) return;   // ô trống (pixel đã tan / không có tranh)

  // Gradient của trường ĐÃ dịch = gradient trường gốc -> offset scroll KHÔNG đụng công thức dưới.
  const gx = occF(snapshot, occ, ox + 1, oy, oxMin, oxMax, oyMin) - occF(snapshot, occ, ox - 1, oy, oxMin, oxMax, oyMin);
  const gy = occF(snapshot, occ, ox, oy + 1, oxMin, oxMax, oyMin) - occF(snapshot, occ, ox, oy - 1, oxMin, oxMax, oyMin);
  // SUY BIẾN (hạt lọt SÂU trong khối đặc -> cả 4 hàng xóm đều đặc -> gradient = 0): bản cũ đẩy cứng (0,-1) = VỀ ĐỈNH
  // TRANH. Giả định "tranh đặc từ trên xuống nên đi lên = ra mặt thoáng" ĐÚNG lúc viết, SAI từ khi có swipe (tranh bị
  // cào thành kênh ở bất kỳ đâu) ⇒ hạt bị đẩy hết chiều cao tranh rồi đậu trên nóc.
  let ppx: number, ppy: number;
  if (Math.abs(gx) + Math.abs(gy) > 0) { ppx = -gx; ppy = -gy; }
  else { nearestFreeDirPic(snapshot, occ, ox, oy, oxMin, oxMax, oyMin, _push); ppx = _push.x; ppy = _push.y; }
  _push.x = ppx * occ.pxAxisWorldX + ppy * occ.pyAxisWorldX;
  _push.y = ppx * occ.pxAxisWorldY + ppy * occ.pyAxisWorldY;
  normalizeSafe(_push);
  if (occEjectDiag.on) { occEjectDiag.code = 3; occEjectDiag.pushX = _push.x; occEjectDiag.pushY = _push.y; }
  if (_push.x * _push.x + _push.y * _push.y < 1e-8) return;

  // CLAMP bước đẩy: pushStrength·sdt lớn -> VỌT lên quá mặt = nảy. Kẹp <= maxStep để hạt CHỈ chạm mặt rồi DỪNG.
  const step = Math.min(occ.pushStrength * sdt, occ.maxStep);
  if (occEjectDiag.on) { occEjectDiag.code = 4; occEjectDiag.step = step; }
  p.x += _push.x * step;
  p.y += _push.y * step;
  const vn = v.x * _push.x + v.y * _push.y;                          // giết vận tốc ĐÂM VÀO tranh
  if (vn < 0) { v.x -= vn * _push.x; v.y -= vn * _push.y; }
}

/**
 * Hướng picture-space tới ô TRỐNG GẦN NHẤT quanh (ox,oy) — quét từng VÒNG Chebyshev r=1..ejectSearchCells, dừng ở
 * vòng ĐẦU TIÊN có ô trống rồi trong vòng đó chọn ô khoảng cách Euclid nhỏ nhất (vòng Chebyshev không đẳng cự).
 * Không thấy (hoặc knob=0) -> (0,-1) = hành vi CŨ "về đỉnh tranh" (KHÔNG trả 0 — caller sẽ chia rồi bail).
 */
function nearestFreeDirPic(s: Uint8Array, occ: GrainOccupancyField, ox: number, oy: number,
                           oxMin: number, oxMax: number, oyMin: number, out: V2): V2 {
  const cap = occ.ejectSearchCells;
  if (cap <= 0) { out.x = 0; out.y = -1; return out; }
  for (let r = 1; r <= cap; r++) {
    let bestI = 0, bestJ = 0, bestD2 = Number.MAX_SAFE_INTEGER;
    for (let j = -r; j <= r; j++) {
      for (let i = -r; i <= r; i++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;      // chỉ VÀNH r
        if (occAt(s, occ, ox + i, oy + j, oxMin, oxMax, oyMin)) continue;
        const d2 = i * i + j * j;
        if (d2 < bestD2) { bestD2 = d2; bestI = i; bestJ = j; }
      }
    }
    if (bestD2 !== Number.MAX_SAFE_INTEGER) { out.x = bestI; out.y = bestJ; return out; }
  }
  out.x = 0; out.y = -1;
  return out;
}

// --- creepDownhill (R2 — shed hạt đọng mép tranh) ------------------------------------------------------------------

/** Mã NHÁNH THOÁT của creepDownhill. "STEP" = hàm CÓ dịch p; còn lại = hạt đứng im vì lý do đó. */
export const CREEP_OFF = 0;                  // knob creepSpeed <= 0
export const CREEP_NO_GRAVITY = 1;           // |gravity| ~ 0
export const CREEP_APRON_BLOCKED = 2;        // trong HÀNH LANG apron, ô inward đọc-seal = ĐẶC
export const CREEP_APRON_STEP = 3;           // trong hành lang, bước NGANG vào trong (CÓ dịch)
export const CREEP_NOT_RESTING = 4;          // gate 3×3 KHÔNG có ô tranh đặc (hạt tựa HẠT) -> tắt THEO THIẾT KẾ
export const CREEP_LEDGE_SHED = 5;           // tựa mặt tranh, thấy mép rơi -> bước ngang (CÓ dịch)
export const CREEP_NO_DOWNHILL = 6;          // tựa mặt nhưng không ô trống xuôi đi-thẳng-được -> repose giữ
export const CREEP_DOWNHILL_STEP = 7;        // B' bước theo hướng xuôi nhất (CÓ dịch)
// 8/9 = 2 mã ĐO giả thuyết "creep bước RA NGOÀI mép tranh". Hành vi dịch p HỆT 5/7 — chỉ tách nhãn để đếm.
export const CREEP_LEDGE_SHED_OUTWARD = 8;
export const CREEP_DOWNHILL_STEP_OUTWARD = 9;

/**
 * POSITION-creep KÊNH RIÊNG, gọi SAU sweepBlocked (per-substep). Bypass cap + settleDamping (KHÔNG đụng v).
 * HAI nhánh loại trừ nhau: (b) CREEP-OFF-EDGE trước (hạt tựa mặt tranh -> quét hàng-dưới tìm "MÉP RƠI" gần nhất rồi
 * creep NGANG về đó); không tựa mặt -> (B') downhill-max với LINE-OF-SIGHT (chống xuyên tranh).
 * AN TOÀN pile phễu: (b) chỉ fire khi CHẠM occupancy TRANH; pile phễu tựa HẠT ⇒ không creep.
 * Trả về = mã nhánh thoát (hằng CREEP_* trên).
 */
export function creepDownhill(p: V2, occ: GrainOccupancyField, snapshot: Uint8Array, snapshotRaw: Uint8Array,
                              sdt: number, gravityX: number, gravityY: number): number {
  if (occ.creepSpeed <= 0) return CREEP_OFF;                          // knob OFF -> no-op bit-identical
  const gLen2 = gravityX * gravityX + gravityY * gravityY;
  if (gLen2 < 1e-8) return CREEP_NO_GRAVITY;
  const invG = 1 / Math.sqrt(gLen2);
  const gDirX = gravityX * invG, gDirY = gravityY * invG;

  // Map p -> occ-cell ĐÚNG phép chọn cột + reveal của sweepBlocked (KHÔNG chép affine — drift câm khi scroll).
  const relX = p.x - occ.worldOriginX, relY = p.y - occ.worldOriginY;
  const pxf = occ.invRow0X * relX + occ.invRow0Y * relY;
  const col = colOfPx(occ, pxf);
  const invCell = 1 / occ.occCellPixels;
  const ox = Math.floor(pxf * invCell);
  const oy = Math.floor((occ.invRow1X * relX + occ.invRow1Y * relY - scrollPyOf(occ, col)) * invCell);
  colOccBounds(occ, col, _bounds);
  const oxMin = _bounds.oxMin, oxMax = _bounds.oxMax;
  const oyMin = revealOyMin(occ, col);

  // Hạt trong HÀNH LANG ngoài mép X (chỉ tồn tại khi có outset ⇒ apron>0) — creep 1 CHIỀU VÀO TRONG, đo bằng
  // occAtSealX. CẤM hướng RA tường (creep 2 chiều ở đây = jitter giằng với tường SDF) và CẤM đi XUỐNG trong hành lang
  // (đó đúng là kênh tunnel xuyên sàn apron) ⇒ chỉ đúng 1 bước ngang, an toàn.
  if (occ.edgeApronCells > 0 && (ox < oxMin || ox > oxMax)) {
    const inward = ox < oxMin ? 1 : -1;                               // dấu bước NGANG hướng vào lòng tranh
    const oxIn = ox + inward;
    // Ô đích phải TRỐNG theo phép đọc SEAL — đọc thường sẽ tưởng ngoài biên là trống tuốt rồi đẩy hạt trôi ngang.
    if (occAtSealX(snapshot, occ, oxIn, oy, oxMin, oxMax, oyMin)) return CREEP_APRON_BLOCKED;
    const apronStep = Math.min(occ.creepSpeed * sdt, occ.maxStep);
    p.x += inward * occ.pxAxisWorldX * apronStep;
    p.y += inward * occ.pxAxisWorldY * apronStep;
    return CREEP_APRON_STEP;
  }

  // Chọn bản đo MỘT LẦN cho cả hàm: trong vành dilate -> RAW + dilateEff=0; ngoài -> DILATED như cũ.
  const inRing = occAt(snapshot, occ, ox, oy, oxMin, oxMax, oyMin)
              && !occAt(snapshotRaw, occ, ox, oy, oxMin, oxMax, oyMin);
  const s = inRing ? snapshotRaw : snapshot;
  const dilateEff = inRing ? 0 : occ.dilateCells;

  // GATE "đang tựa mặt tranh": >=1 ô ĐẶC trong 3×3 quanh center. Không có = rơi tự do / lòng trống -> KHÔNG creep
  // (chống hoá-lỏng: chỉ hạt CHẠM tranh mới được nhích).
  let resting = false;
  for (let j = -1; j <= 1 && !resting; j++) {
    for (let i = -1; i <= 1; i++) {
      if (i === 0 && j === 0) continue;
      if (occAt(s, occ, ox + i, oy + j, oxMin, oxMax, oyMin)) { resting = true; break; }
    }
  }
  if (!resting) return CREEP_NOT_RESTING;

  const step = Math.min(occ.creepSpeed * sdt, occ.maxStep);           // VỊ TRÍ only — bypass cap + settleDamping

  // Trục XUỐNG (theo trọng lực) + trục NGANG trong cell-space (robust cả khi trọng lực xiên).
  const gx = occ.pxAxisWorldX * gravityX + occ.pxAxisWorldY * gravityY;
  const gy = occ.pyAxisWorldX * gravityX + occ.pyAxisWorldY * gravityY;
  let ddx: number, ddy: number, lx: number, ly: number;
  if (Math.abs(gy) >= Math.abs(gx)) { ddx = 0; ddy = gy >= 0 ? 1 : -1; lx = 1; ly = 0; }
  else { ddx = gx >= 0 ? 1 : -1; ddy = 0; lx = 0; ly = 1; }

  // (b) CREEP-OFF-EDGE: hạt tựa mặt tranh (đặc NGAY dưới) -> creep NGANG tới "MÉP RƠI" gần nhất, rồi gravity thả
  // xuống bậc kế. Xử lý CẢ gờ mỏng LẪN bậc thang DÀY (staircase) — ca mà B' downhill-max mù.
  // snapshot dilate N ô -> mọi khoảng cách đo trên nó dài thêm N -> nới cap cùng lượng, giữ NGỮ NGHĨA "4 ô tranh thật".
  const lateralMax = (occ.creepLateralMax > 0 ? occ.creepLateralMax : 4) + dilateEff;
  if (occAt(s, occ, ox + ddx, oy + ddy, oxMin, oxMax, oyMin)) {       // NGAY dưới = ĐẶC (tựa mặt)
    const rPos = ledgeRun(s, occ, ox + ddx, oy + ddy, lx, ly, lateralMax, oxMin, oxMax, oyMin);
    const rNeg = ledgeRun(s, occ, ox + ddx, oy + ddy, -lx, -ly, lateralMax, oxMin, oxMax, oyMin);
    if (Math.min(rPos, rNeg) <= lateralMax) {                          // có mép rơi trong tầm -> shed
      // bên occupied-run NGẮN hơn = mép gần; HOÀ (mép đối xứng) -> tie-break +lateral (deterministic, KHÔNG flip).
      const sgn = rPos <= rNeg ? 1 : -1;
      p.x += (sgn * lx * occ.pxAxisWorldX + sgn * ly * occ.pyAxisWorldX) * step;
      p.y += (sgn * lx * occ.pxAxisWorldY + sgn * ly * occ.pyAxisWorldY) * step;
      const ledgeOx = ox + ddx + sgn * lx * (sgn > 0 ? rPos : rNeg);
      return (ledgeOx < 0 || ledgeOx >= occ.occWidth) ? CREEP_LEDGE_SHED_OUTWARD : CREEP_LEDGE_SHED;
    }
    // cả 2 mép > lateralMax = lòng phẳng/thung lũng -> nghỉ (rơi xuống B'; line-of-sight vô hại).
  }

  // B' downhill-max + LINE-OF-SIGHT: chỉ chọn ô TRỐNG đi THẲNG tới được (KHÔNG nằm sau ô đặc) = chống xuyên.
  const w = Math.max(1, occ.creepWindow) + dilateEff;
  let bestComp = occ.creepSlopeMin;   // phải VƯỢT mới creep — mặt phẳng: ô trống chỉ ngang/lên -> comp <= 0 < min
  let bestDirX = 0, bestDirY = 0;
  let bestI = 0;
  let found = false;
  for (let j = -w; j <= w; j++) {
    for (let i = -w; i <= w; i++) {
      if (i === 0 && j === 0) continue;
      // (D13) như ledgeRun: ngoài biên X toàn cục = TƯỜNG, KHÔNG phải ô trống
      if (ox + i < 0 || ox + i >= occ.occWidth) continue;
      if (occAt(s, occ, ox + i, oy + j, oxMin, oxMax, oyMin)) continue;                  // chỉ ô TRỐNG
      if (!pathClear(s, occ, ox, oy, i, j, oxMin, oxMax, oyMin)) continue;               // ô sau ô đặc = bỏ
      const dirWX = i * occ.pxAxisWorldX + j * occ.pyAxisWorldX;
      const dirWY = i * occ.pxAxisWorldY + j * occ.pyAxisWorldY;
      const dLen2 = dirWX * dirWX + dirWY * dirWY;
      if (dLen2 < 1e-8) continue;
      const inv = 1 / Math.sqrt(dLen2);
      const dirNX = dirWX * inv, dirNY = dirWY * inv;
      const comp = dirNX * gDirX + dirNY * gDirY;
      if (comp > bestComp) { bestComp = comp; bestDirX = dirNX; bestDirY = dirNY; bestI = i; found = true; }
    }
  }
  if (!found) return CREEP_NO_DOWNHILL;                                // không ô trống xuôi đi-thẳng-được -> repose giữ

  p.x += bestDirX * step;
  p.y += bestDirY * step;
  const bestOx = ox + bestI;
  return (bestOx < 0 || bestOx >= occ.occWidth) ? CREEP_DOWNHILL_STEP_OUTWARD : CREEP_DOWNHILL_STEP;
}

/**
 * Khoảng cách (ô) từ (cx,cy) tới ô TRỐNG đầu tiên dọc hướng (sx,sy) = độ dài occupied-run + 1 = "mép gờ cách bao xa".
 * Không thấy mép trong `cap` -> cap+1 (coi như xa).
 * (D13) NGOÀI BIÊN X TOÀN CỤC = tường khung, KHÔNG phải mép rơi — không thế thì hạt cột rìa LUÔN thấy "mép rơi" ảo
 * ngay ngoài mảng ⇒ shed RA phía tường mỗi substep ⇒ rung tại chỗ (đo StuckDiag: 100% ca kẹt = LEDGE-OUT).
 */
function ledgeRun(s: Uint8Array, occ: GrainOccupancyField, cx: number, cy: number, sx: number, sy: number,
                  cap: number, oxMin: number, oxMax: number, oyMin: number): number {
  for (let d = 1; d <= cap; d++) {
    const qx = cx + sx * d;
    if (qx < 0 || qx >= occ.occWidth) return cap + 1;
    if (!occAt(s, occ, qx, cy + sy * d, oxMin, oxMax, oyMin)) return d;
  }
  return cap + 1;
}

/**
 * TRUE nếu đường thẳng cell (ox,oy)->(ox+i,oy+j) không cắt ô occupied ở GIỮA (trừ 2 đầu). Chặn creep chọn ô trống nằm
 * SAU gờ đặc (vd (0,+2) sau gờ (0,+1)) = gốc xuyên tranh + deadlock với sweep.
 */
function pathClear(s: Uint8Array, occ: GrainOccupancyField, ox: number, oy: number, i: number, j: number,
                   oxMin: number, oxMax: number, oyMin: number): boolean {
  const steps = Math.max(Math.abs(i), Math.abs(j));
  for (let k = 1; k < steps; k++) {
    const cx = ox + Math.round(i * k / steps);
    const cy = oy + Math.round(j * k / steps);
    if (occAt(s, occ, cx, cy, oxMin, oxMax, oyMin)) return false;
  }
  return true;
}

// --- normal field ---------------------------------------------------------------------------------------------------

/**
 * Normal NGOÀI (world) LÀM MỊN từ occupancy: gộp center-of-mass các ô occupied trong cửa sổ ±smoothRadius quanh
 * (ox,oy) -> vector trỏ RA XA khối tranh. Khử răng-cưa micro của grid để lấy ĐỘ DỐC MACRO của contour cho
 * surface-slide. Đối xứng/bao kín -> ~0 (caller bỏ qua slide).
 * SCROLL: cửa sổ gộp bị CẮT ở biên cột — ĐÚNG VẬT LÝ (2 cột lệch độ cao LÀ một vách thật).
 */
function smoothNormalWorld(s: Uint8Array, occ: GrainOccupancyField, ox: number, oy: number,
                           oxMin: number, oxMax: number, oyMin: number, out: V2): V2 {
  let gX = 0, gY = 0;                       // gradient picture-cell space (trỏ VỀ khối)
  const r = Math.max(1, occ.smoothRadius);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if ((dx !== 0 || dy !== 0) && occAt(s, occ, ox + dx, oy + dy, oxMin, oxMax, oyMin)) { gX += dx; gY += dy; }
    }
  }
  out.x = (-gX) * occ.pxAxisWorldX + (-gY) * occ.pyAxisWorldX;   // ra XA khối, map picture->world
  out.y = (-gX) * occ.pxAxisWorldY + (-gY) * occ.pyAxisWorldY;
  return normalizeSafe(out);
}

/**
 * Normal MACRO của ô (ox,oy) cho NORMAL FIELD precompute — đúng giá trị mà sweepBlocked TRƯỚC ĐÂY tính tại chỗ mỗi
 * lần chạm. Trả 0 cho ô TRỐNG + ô LÒNG TRONG (occupied mà cả 4 hàng xóm occupied): DDA dừng ở ô occupied ĐẦU TIÊN
 * trên tia xuất phát từ ô trống ⇒ ô lòng trong KHÔNG BAO GIỜ bị tra.
 * ⚠ col derive từ ox NGUYÊN (mép TRÁI ô), KHÔNG phải tâm ô — colOccBounds dùng ceil 2 đầu để khớp ĐÚNG luật
 * floor(px/colWidthPx)==col cho px NGUYÊN; lấy ox+0.5 thì ô CUỐI mỗi cột rơi nhầm sang cột sau ⇒ normal sai.
 */
export function buildNormalAt(s: Uint8Array, occ: GrainOccupancyField, ox: number, oy: number, out: V2): V2 {
  out.x = 0; out.y = 0;
  const col = colOfPx(occ, ox);
  colOccBounds(occ, col, _bounds);
  const oxMin = _bounds.oxMin, oxMax = _bounds.oxMax;
  const oyMin = revealOyMin(occ, col);
  if (!occAt(s, occ, ox, oy, oxMin, oxMax, oyMin)) return out;        // ô trống -> không ai hỏi
  // BIÊN <=> có >=1 hàng xóm 4-neighbor TRỐNG. Dùng CHÍNH occAt ⇒ "ngoài cột" / "trên mép chưa lộ" cũng tính là
  // trống, khớp tuyệt đối với thứ DDA nhìn thấy.
  const boundary = !occAt(s, occ, ox + 1, oy, oxMin, oxMax, oyMin)
                || !occAt(s, occ, ox - 1, oy, oxMin, oxMax, oyMin)
                || !occAt(s, occ, ox, oy + 1, oxMin, oxMax, oyMin)
                || !occAt(s, occ, ox, oy - 1, oxMin, oxMax, oyMin);
  if (!boundary) return out;                                          // lòng trong -> DDA không tới được
  return smoothNormalWorld(s, occ, ox, oy, oxMin, oxMax, oyMin, out);
}

const _nOut: V2 = { x: 0, y: 0 };

/** J0 — precompute normal MACRO cho MỌI ô occ vào `normals` (stride 2). Rebuild MỖI STEP, CỐ Ý KHÔNG dirty-track. */
export function buildOccNormals(occ: GrainOccupancyField, snapshot: Uint8Array, normals: Float32Array): void {
  const n = occ.occWidth * occ.occHeight;
  for (let index = 0; index < n; index++) {
    const ox = index % occ.occWidth;
    const oy = (index / occ.occWidth) | 0;
    buildNormalAt(snapshot, occ, ox, oy, _nOut);
    normals[index * 2] = _nOut.x;
    normals[index * 2 + 1] = _nOut.y;
  }
}

/**
 * J-1 — DILATE occupancy Chebyshev `radius` ô: ô TRỐNG có >=1 ô ĐẶC trong cửa sổ (2r+1)² -> thành ĐẶC trong `dst`.
 * Bù BÁN KÍNH hạt mà sweepBlocked bỏ qua (DDA quét ĐIỂM tâm; thân hạt phủ ~2.3 ô, lách qua ô mép = radius-leak).
 * Minkowski-sum tranh⊕hạt đưa bài toán đĩa về bài toán điểm. radius=0 -> caller KHÔNG gọi, dùng thẳng snapshot cũ.
 * ⚠ NỢ SEAM CỘT (scroll): dilate trong picture-space mốc s=0, vành lan NGANG qua biên cột KHÔNG biết Δs giữa 2 cột.
 */
export function dilateOccupancy(src: Uint8Array, dst: Uint8Array, width: number, height: number, radius: number): void {
  const n = width * height;
  for (let index = 0; index < n; index++) {
    const ox = index % width;
    const oy = (index / width) | 0;
    let occupied = src[index];
    if (occupied === 0) {
      const xMin = Math.max(0, ox - radius);
      const xMax = Math.min(width - 1, ox + radius);
      const yMin = Math.max(0, oy - radius);
      const yMax = Math.min(height - 1, oy + radius);
      for (let y = yMin; y <= yMax && occupied === 0; y++) {
        const row = y * width;
        for (let x = xMin; x <= xMax; x++) {
          if (src[row + x] !== 0) { occupied = 1; break; }
        }
      }
    }
    dst[index] = occupied;
  }
}
