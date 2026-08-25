// PROBE CHẨN ĐOÁN "hạt đứng im giữa không trung" — KHÔNG phải feature, gỡ được sau khi chốt nguyên nhân.
//
// VÌ SAO CÓ FILE NÀY: harness offline (tools/belt-probe) KHÔNG tái hiện được triệu chứng ở bất kỳ cấu hình nào
// (tĩnh 0%), trong khi bản chạy thật có hạt đứng im — và play test 2026-08-24 với showRigStandIn BẬT xác nhận
// cụm hạt nằm NGOÀI mọi hình khối rig. Tức thủ phạm nằm ở thứ harness KHÔNG phủ, mà 3 thứ đó đều quanh occupancy
// tranh: `hasOcc` · ghost grain · spawn-trong-pocket của ConversionFront.
//
// PROBE NÀY CHỈ ĐỌC, KHÔNG SỬA GÌ. Nó phân loại từng hạt tĩnh vào ĐÚNG 1 giỏ để log nói thẳng ai giữ hạt lại:
//   wall     — tựa segment SDF (phễu/chute/khung)         => rig giữ, ĐÚNG vật lý
//   ring     — tựa vành trong/ngoài băng chuyền           => rig giữ, ĐÚNG vật lý
//   occIn    — TÂM hạt nằm trong ô tranh RAW đang đặc     => kẹt TRONG tranh (đáng ngờ)
//   occDil   — nằm trong vành DILATE nhưng RAW đã rỗng    => ★ NGHI CHÍNH: tường vô hình do dilate
//   occRest  — ô ngay DƯỚI là tranh RAW đặc               => tựa mặt tranh, đúng vật lý (nếu tranh còn pixel)
//   pile     — có hạt khác ĐỠ NGAY DƯỚI                   => đụn cát nghỉ, đúng vật lý (giỏ này phải có, nếu
//                                                            không thì ruột đụn bị đếm nhầm thành `float`)
//   ghost    — đang ghost (bỏ occupancy) mà vẫn đứng im   => bug đường ghost
//   float    — ★ KHÔNG thứ nào ở trên giữ                 => lơ lửng thật, thủ phạm ngoài 3 nghi phạm
//
// ĐỌC LOG: giỏ nào chiếm đa số CHÍNH LÀ nguyên nhân. `occDil` cao = desync giữa texture tranh (đã xoá pixel) và
// snapshot dilate (còn đặc) -> sửa ở refreshOccupancy/dilateCells. `float` cao = phải mở lại điều tra solver.
//
// PHẦN 3 (2026-08-25, giả thuyết của user) — dòng `[mouth]`: hạt tĩnh có nằm trong HỘP HÚT của cột nào không.
// Hộp hút vô hình và KHÔNG nằm ở chỗ đứng của lọ (nguồn đặt nó ở rãnh đáy belt, cách head jar 4 world lên trên),
// nên mắt thường không phân biệt được "hạt lơ lửng vô cớ" với "hạt nằm trong hộp hút mà chưa bị hút". Luật hút:
// chỉ hạt ĐÚNG MÀU head của cột đó VÀ cột CÒN CHỖ mới bị `harvestJar` xoá — xoá TẠI CHỖ, không rơi. Nên hạt
// khác màu (hoặc cột đang đầy chờ clip đóng) đứng lại trong hộp sẽ nhìn ra đúng như user tả: kẹt giữa không
// trung -> biến mất không rơi (lúc cột đổi head sang màu đó) -> swipe thì hạt mới lại dừng đúng chỗ cũ.
// ĐỌC: `khacMau`/`hetCho`/`hetLo` cao = đúng luật nguồn nhưng SAI THỊ GIÁC -> chỉnh `mouth{}` trong
// board-layout.txt (bật `mouth.debug` để thấy 4 hộp). `dungMau` > 0 = BUG thật ở đường hút. `tinh-trong-hop=0`
// = giả thuyết hộp hút SAI, quay lại nhánh pixel tranh (`[pix]`).
//
// PHẦN 2 (2026-08-25) — `StallTracker` ở cuối file: bắt "khựng NGẮN" theo TỪNG SIM STEP. probeStatic ở trên lấy
// mẫu 2s/lần và chỉ nhìn hạt |v|<0.5 nên MÙ với ca user tả: hạt trong TÚI ĐANG RƠI khựng vài frame rồi rơi tiếp,
// quanh không có SDF/tranh. Xem docblock của class để biết cách đọc dòng `[pin]`.

import type { GrainParticlePool } from '../solver/pool';
import type { IntegrateParams } from '../solver/integrate';
import type { SandSolver } from '../solver/step';
import type { PictureCarveModel } from '../solver/carveModel';
import type { PictureTexture } from './PictureTexture';
import type { PictureMap } from './PictureMap';
import type { SandPictureHost } from './SandPictureHost';
import type { JarColumnDiag } from './JarColumns';
import { CCD_DIAG_SWEPT, CCD_DIAG_CLAMPED } from '../solver/ccd';
import { thrOf, xformPoint, v2, type GrainSdfField, type V2 } from '../solver/sdfWalls';
import { colOfPx, scrollPyOf, colOccBounds, revealOyMin, occAt, occEjectDiag, OCC_EJECT_NAME,
         type ColBounds } from '../solver/occupancy';
import { rowSpan, cellOf, type Span } from '../solver/neighborGrid';
import type { AccumulateParams } from '../solver/contact';
import type { Node } from 'cc';

/** |v| dưới ngưỡng này = coi như đứng im. 0.5 world/s — cùng ngưỡng đã dùng khi đếm trên video play-test. */
const V_STILL = 0.5;
/** Cạnh ô gom cụm (world) khi báo "cụm ở đâu". */
const CLUSTER_CELL = 2.0;
/** Số cụm đông nhất được in ra cho mỗi giỏ. */
const TOP_CLUSTERS = 3;

type Bucket = 'wall' | 'ring' | 'occIn' | 'occDil' | 'occRest' | 'pile' | 'ghost' | 'float';
const BUCKETS: readonly Bucket[] = ['wall', 'ring', 'occIn', 'occDil', 'occRest', 'pile', 'ghost', 'float'];

const _lp: V2 = v2();
const _bounds: ColBounds = { oxMin: 0, oxMax: 0 };

// lib của project là ES2015 -> KHÔNG có padStart/padEnd, tự đệm.
function padR(s: string, w: number): string { let r = s; while (r.length < w) r += ' '; return r; }
function padL(s: string, w: number): string { let r = s; while (r.length < w) r = ' ' + r; return r; }

/** Bình phương khoảng cách từ điểm tới đoạn AB. */
function distSqToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax, aby = by - ay;
  const apx = px - ax, apy = py - ay;
  const den = abx * abx + aby * aby;
  let t = den > 1e-12 ? (apx * abx + apy * aby) / den : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const dx = apx - abx * t, dy = apy - aby * t;
  return dx * dx + dy * dy;
}

/** Khoảng cách local tới spine stadium (trục X, nửa dài halfBody) — cùng phép chiếu clampInner/clampOuter dùng. */
function distToSpine(sdf: GrainSdfField, lx: number, ly: number): number {
  const cx = lx < -sdf.halfBody ? -sdf.halfBody : (lx > sdf.halfBody ? sdf.halfBody : lx);
  const dx = lx - cx;
  return Math.sqrt(dx * dx + ly * ly);
}

/**
 * Lưới băm thưa trên TOÀN pool để hỏi "có hạt nào đỡ ngay dưới không". Dựng lại mỗi lần probe (2s/lần) nên
 * không nằm trên đường nóng; dùng Map thay mảng cấp sẵn để probe không giữ bộ nhớ theo capacity.
 */
class NeighborLookup {
  private readonly cells = new Map<number, number[]>();
  private readonly cell: number;

  constructor(private readonly pos: Float32Array, n: number, cellSize: number) {
    this.cell = cellSize;
    for (let i = 0; i < n; i++) {
      const k = this.key(pos[i * 2], pos[i * 2 + 1]);
      const a = this.cells.get(k);
      if (a === undefined) this.cells.set(k, [i]); else a.push(i);
    }
  }

  private key(x: number, y: number): number {
    return (Math.floor(x / this.cell) + 16384) * 32768 + (Math.floor(y / this.cell) + 16384);
  }

  /** Có hạt nào tâm nằm THẤP HƠN (dy trong [loY, hiY]) và lệch ngang <= maxDx không. */
  supportedBelow(x: number, y: number, maxDx: number, loY: number, hiY: number): boolean {
    const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell);
    const p = this.pos;
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 2; gy <= cy; gy++) {
        const a = this.cells.get((gx + 16384) * 32768 + (gy + 16384));
        if (a === undefined) continue;
        for (let k = 0; k < a.length; k++) {
          const j = a[k];
          const dy = y - p[j * 2 + 1];
          if (dy < loY || dy > hiY) continue;
          const dx = x - p[j * 2];
          if (dx <= maxDx && dx >= -maxDx) return true;
        }
      }
    }
    return false;
  }
}

class Clusters {
  private readonly map = new Map<number, { n: number; sx: number; sy: number }>();

  add(x: number, y: number): void {
    const cx = Math.floor(x / CLUSTER_CELL), cy = Math.floor(y / CLUSTER_CELL);
    // Khoá gộp 2 int -> 1 số; ±16384 ô là thừa xa cho rig cỡ ad.
    const key = (cx + 16384) * 32768 + (cy + 16384);
    const e = this.map.get(key);
    if (e === undefined) this.map.set(key, { n: 1, sx: x, sy: y });
    else { e.n++; e.sx += x; e.sy += y; }
  }

  /** "n@(x,y)" của TOP_CLUSTERS ô đông nhất. */
  top(): string {
    const all = Array.from(this.map.values()).sort((a, b) => b.n - a.n).slice(0, TOP_CLUSTERS);
    if (all.length === 0) return '-';
    return all.map((e) => `${e.n}@(${(e.sx / e.n).toFixed(1)},${(e.sy / e.n).toFixed(1)})`).join(' ');
  }
}

/**
 * Quét pool 1 lượt, trả về các dòng log đã format. CHỈ ĐỌC pool + params.
 * @param ip params của ĐƯỜNG INTEGRATE đang chạy — lấy đúng sdf/segments/occ/snapshot mà solver dùng, không dựng lại.
 * @param mouths ảnh chụp 4 hộp hút (JarColumns.diag()); null = bỏ phần `[mouth]`.
 */
export function probeStatic(pool: GrainParticlePool, ip: IntegrateParams,
                            mouths: readonly JarColumnDiag[] | null = null): string[] {
  const n = pool.count;
  if (n === 0) return ['[probe] pool rỗng'];

  const pos = pool.positions, vel = pool.velocities, gh = pool.ghost, cid = pool.colorIds;
  const sdf = ip.sdf, segs = ip.segments;
  const thr = thrOf(sdf);
  // Biên "coi như đang tựa": dải tường + 1 bán kính hạt nữa cho sai số resolve.
  const restBand = thr + sdf.radiusLocal;

  const count: Record<Bucket, number> = {
    wall: 0, ring: 0, occIn: 0, occDil: 0, occRest: 0, pile: 0, ghost: 0, float: 0,
  };
  const clus: Record<Bucket, Clusters> = {
    wall: new Clusters(), ring: new Clusters(), occIn: new Clusters(), occDil: new Clusters(),
    occRest: new Clusters(), pile: new Clusters(), ghost: new Clusters(), float: new Clusters(),
  };

  const hasOcc = ip.hasOcc !== 0;
  const occ = ip.occ, raw = ip.occSnapshotRaw, dil = ip.occSnapshot;
  const invCell = hasOcc ? 1 / occ.occCellPixels : 0;

  // Bán kính hạt world (đồng nhất trong ad này; lấy hạt 0 làm mốc, phòng 0 thì rơi về radiusLocal).
  const rw = pool.radii[0] > 1e-6 ? pool.radii[0] : sdf.radiusLocal;
  const near = new NeighborLookup(pos, n, rw * 2);
  const supLo = rw * 0.4, supHi = rw * 2.4, supDx = rw * 1.6;

  let still = 0;
  let occInGridStill = 0;

  // --- giỏ HỘP HÚT (2026-08-25) — xem khối "PHẦN 3" ở đầu file ---
  const mn = mouths !== null ? mouths.length : 0;
  const mAll = new Int32Array(mn);      // MỌI hạt trong hộp (không lọc |v|)
  const mStill = new Int32Array(mn);    // hạt đứng im trong hộp
  const mWrong = new Int32Array(mn);    // đứng im + KHÁC MÀU head -> hộp không nhận, đúng luật
  const mNoRoom = new Int32Array(mn);   // đứng im + đúng màu nhưng cột HẾT CHỖ (đầy/chờ clip đóng)
  const mSame = new Int32Array(mn);     // đứng im + đúng màu + CÒN CHỖ -> BẤT THƯỜNG, lẽ ra bị hút ngay step sau
  const mNoJar = new Int32Array(mn);    // đứng im + cột đã hết lọ
  const mClus: Clusters[] = [];
  for (let k = 0; k < mn; k++) mClus.push(new Clusters());

  for (let i = 0; i < n; i++) {
    const gx = pos[i * 2], gy = pos[i * 2 + 1];
    // Hộp hút xét TRƯỚC bộ lọc |v|: cần biết cả hạt đang CHẠY QUA hộp, nếu không thì "0 hạt trong hộp" không
    // phân biệt được "hộp đặt sai chỗ" với "hộp đúng chỗ nhưng hạt qua nhanh".
    let mi = -1;
    if (mouths !== null) {
      for (let k = 0; k < mn; k++) {
        const bx = mouths[k].mouth;
        if (gx >= bx.minX && gx <= bx.maxX && gy >= bx.minY && gy <= bx.maxY) { mi = k; break; }
      }
      if (mi >= 0) mAll[mi]++;
    }

    const vx = vel[i * 2], vy = vel[i * 2 + 1];
    if (vx * vx + vy * vy >= V_STILL * V_STILL) continue;
    still++;

    const wx = gx, wy = gy;
    if (mi >= 0) {
      const d = mouths![mi];
      mStill[mi]++;
      mClus[mi].add(wx, wy);
      if (d.colorId < 0) mNoJar[mi]++;
      else if (d.colorId !== cid[i]) mWrong[mi]++;
      else if (d.room <= 0) mNoRoom[mi]++;
      else mSame[mi]++;
    }
    let b: Bucket = 'float';

    // --- occupancy xét TRƯỚC: đây là nghi phạm chính và giỏ occ* nói được nhiều nhất ---
    if (hasOcc) {
      const relX = wx - occ.worldOriginX, relY = wy - occ.worldOriginY;
      const px = occ.invRow0X * relX + occ.invRow0Y * relY;
      const col = colOfPx(occ, px);
      const sPy = scrollPyOf(occ, col);
      colOccBounds(occ, col, _bounds);
      const oyMin = revealOyMin(occ, col);
      const ox = Math.floor(px * invCell);
      const oy = Math.floor((occ.invRow1X * relX + occ.invRow1Y * relY - sPy) * invCell);

      if (ox >= 0 && ox < occ.occWidth && oy >= 0 && oy < occ.occHeight) {
        occInGridStill++;
        const inRaw = occAt(raw, occ, ox, oy, _bounds.oxMin, _bounds.oxMax, oyMin);
        const inDil = occAt(dil, occ, ox, oy, _bounds.oxMin, _bounds.oxMax, oyMin);
        // py TĂNG = xuống dưới tranh (py=0 là ĐỈNH) -> ô "ngay dưới" là oy+1.
        const belowRaw = occAt(raw, occ, ox, oy + 1, _bounds.oxMin, _bounds.oxMax, oyMin);
        if (inRaw) b = 'occIn';
        else if (inDil) b = 'occDil';
        else if (belowRaw) b = 'occRest';
      }
    }

    // --- rig: chỉ xét khi occupancy KHÔNG giữ ---
    if (b === 'float') {
      xformPoint(sdf.worldToLocal, wx, wy, _lp);
      const d = distToSpine(sdf, _lp.x, _lp.y);
      if (Math.abs(d - sdf.rOut) <= restBand || d <= sdf.rIn + restBand) {
        b = 'ring';
      } else {
        const lim = restBand * restBand;
        for (let s = 0; s < sdf.segmentCount; s++) {
          const o = s * 4;
          if (distSqToSeg(_lp.x, _lp.y, segs[o], segs[o + 1], segs[o + 2], segs[o + 3]) <= lim) { b = 'wall'; break; }
        }
      }
    }

    // --- đụn cát: hạt khác đỡ ngay dưới. Xét SAU rig/occ vì tựa tường là lời giải thích mạnh hơn. ---
    if (b === 'float' && near.supportedBelow(wx, wy, supDx, supLo, supHi)) b = 'pile';

    // ghost ĐÈ mọi giỏ: hạt ghost bỏ qua occupancy, nó mà đứng im là bug đường ghost bất kể đứng ở đâu.
    if (gh[i] !== 0) b = 'ghost';

    count[b]++;
    clus[b].add(wx, wy);
  }

  const pct = (v: number): string => `${((v / n) * 100).toFixed(1)}%`;
  const lines: string[] = [];
  lines.push(`[probe] pool=${n} tinh=${still} (${pct(still)}) | hasOcc=${hasOcc ? 1 : 0} ` +
             `occGrid=${hasOcc ? `${occ.occWidth}x${occ.occHeight} dilate=${occ.dilateCells}` : '-'} ` +
             `tinh-trong-luoi-occ=${occInGridStill}`);
  for (const b of BUCKETS) {
    if (count[b] === 0) continue;
    lines.push(`[probe]   ${padR(b, 7)} ${padL(String(count[b]), 5)}  ${clus[b].top()}`);
  }
  if (count.float === 0 && count.occDil === 0 && count.occIn === 0 && count.ghost === 0) {
    lines.push('[probe]   => KHONG co hat tinh bat thuong: moi hat dung im deu dang tua rig hoac mat tranh.');
  }

  if (mouths !== null && mn > 0) {
    let tAll = 0, tStill = 0, tWrong = 0, tNoRoom = 0, tSame = 0, tNoJar = 0;
    for (let k = 0; k < mn; k++) {
      tAll += mAll[k]; tStill += mStill[k]; tWrong += mWrong[k];
      tNoRoom += mNoRoom[k]; tSame += mSame[k]; tNoJar += mNoJar[k];
    }
    lines.push(`[mouth] ${mn} hop hut | trong-hop=${tAll} tinh-trong-hop=${tStill} ` +
               `(khacMau ${tWrong}, hetCho ${tNoRoom}, dungMau-conCho ${tSame}, hetLo ${tNoJar})`);
    for (let k = 0; k < mn; k++) {
      const d = mouths[k];
      lines.push(`[mouth]   cot${k} x[${d.mouth.minX.toFixed(2)},${d.mouth.maxX.toFixed(2)}] ` +
                 `y[${d.mouth.minY.toFixed(2)},${d.mouth.maxY.toFixed(2)}] ` +
                 `head=${d.colorName}(cid=${d.colorId}) room=${d.room} daRoiSan=${d.cleared} | ` +
                 `trong-hop=${padL(String(mAll[k]), 4)} tinh=${padL(String(mStill[k]), 4)} ` +
                 `(khacMau ${mWrong[k]}, hetCho ${mNoRoom[k]}, dungMau ${mSame[k]}, hetLo ${mNoJar[k]})  ` +
                 mClus[k].top());
    }
    if (tStill === 0) {
      lines.push('[mouth]   => KHONG co hat nao dung im trong hop hut: gia thuyet "ket vi nam trong hop hut" SAI ' +
                 'cho lan quet nay — doi chieu toa do hat ket that voi khoang x/y in o tren.');
    } else if (tSame > 0) {
      lines.push('[mouth]   => CO hat DUNG MAU + con cho van dung im trong hop: day la BUG that (le ra bi hut ' +
                 'ngay step sau) — soi harvestJar/colorId, khong phai chuyen config.');
    } else {
      lines.push('[mouth]   => hat tinh trong hop deu la khacMau/hetCho/hetLo: dung LUAT nguon, nhung nhin ra ' +
                 'ngoai chinh la "hat ket giua khong trung roi bien mat khong roi". Sua bang mouth{} trong ' +
                 'board-layout.txt (ha offsetY/thu nho h de hop khong om cho hat nghi) hoac cho hat khac mau ' +
                 'khong dung lai duoc o do.');
    }
  }
  return lines;
}

// ==================================================================== StallTracker — bắt "khựng" NGẮN, mỗi step
//
// ỨNG VIÊN đọc từ code (chưa có số đo — tracker này để đo): ccd.ts kẹp VỊ TRÍ hạt nhanh về điểm chạm (không đụng v)
// -> finalize thấy |corr| to -> giết tới absorbCapMul·|corr|/dt = 2·0.12·30 = 7.2 world/s mỗi lần. Gate CCD lọc theo
// vận tốc TƯƠNG ĐỐI > ccdGate·r/dt = 7.2 world/s với giả định "cột cát rơi là co-moving" — nhưng emit là CONE ±45°
// tốc 20 (2 hạt cùng túi lệch nhau tới ~28 world/s) nên gate lọt thường xuyên NGAY TRONG TÚI. Khựng kiểu đó dài
// 3-10 step rồi rơi tiếp, KHÔNG đứng vĩnh viễn -> tiêu chí "đứng >= 20 frame" của lần đo headless trước bỏ sót.
//
// Chạy MỖI SIM STEP (AdRoot.simStep, NGAY SAU solver.step, TRƯỚC harvest để index còn khớp ccdDiag/predicted).
// 2 loại sự kiện, mỗi index:
//   STALL — |v| tụt còn < STALL_KEEP·|v_trước| trong 1 step, khi đang chạy >= STALL_MIN_V
//   PIN   — vị trí bất động >= PIN_STEPS step liên tiếp (KHÔNG lọc |v|), nhắc lại mỗi PIN_REPEAT_STEPS nếu còn
// Mỗi dòng `[pin]` in kèm chứng cứ để quy tầng:
//   ccd=E/S/C   cờ CCD của step đó (early-out / có quét / bị KẸP)
//   corr, vn    |pos - posPredicted| finalize thấy, và thành phần v dọc corr (âm = finalize đã giết phần này)
//   sdf(thr)    khoảng cách LOCAL tới tường SDF gần nhất (vành trong/ngoài/segment) so với dải thr
//   occ5        số ô tranh RAW đặc trong 5x5 quanh hạt ('-' = ngoài lưới occ)
//   nb2r, co    số hạt khác trong 2r · số hạt trùng tâm
// ĐỌC: STALL có ccd=C + sdf>>thr + occ5=0 => đúng chuỗi CCD->finalize. STALL có ccd=E mà |vn| lớn => contact push
// (intruderBias) thay vì CCD. PIN với nb2r=0 + occ5=0 + sdf>>thr => lơ lửng thật ngoài mọi thứ đã biết.
// Dòng tổng `[pin] steps=..` có histogram độ dài run bất động đã KẾT THÚC — đây là số nói khựng kéo dài bao lâu.

/** Bất động >= số step này = PIN. 3 step @30Hz = 0.1s. */
const PIN_STEPS = 3;
/** Còn bất động thì nhắc lại mỗi chừng này step (1s) — hạt kẹt vĩnh viễn không được im lặng sau dòng đầu. */
const PIN_REPEAT_STEPS = 30;
/** Dịch chuyển/step dưới mức này (theo bán kính) = "bất động". 0.25r ≈ 0.03 world ≈ 0.9 world/s. */
const STILL_STEP_R = 0.25;
/** STALL = |v| sau step < tỉ lệ này × |v| trước, khi |v| trước >= STALL_MIN_V (world/s). */
const STALL_KEEP = 0.35;
const STALL_MIN_V = 8;
/** Trần dòng chi tiết — túi dày có thể bắn hàng chục sự kiện/step; đếm vẫn đủ, chi tiết chỉ cần mẫu. */
const MAX_EVENTS_PER_STEP = 6;
const MAX_EVENTS_PER_FLUSH = 40;

export class StallTracker {
  private readonly prevPos: Float32Array;
  private readonly prevSpeed: Float32Array;
  private readonly still: Uint16Array;
  private events: string[] = [];
  private steps = 0;
  private stallEv = 0;
  private pinEv = 0;
  private dropped = 0;
  private ccdSwept = 0;
  private ccdClamped = 0;
  /** Run bất động đã KẾT THÚC, theo độ dài step: 3-5 · 6-10 · 11-20 · >20. */
  private readonly runHist = [0, 0, 0, 0];

  constructor(capacity: number) {
    this.prevPos = new Float32Array(capacity * 2);
    this.prevSpeed = new Float32Array(capacity);
    this.still = new Uint16Array(capacity);
  }

  /** Gọi 1 lần/sim step, ngay sau solver.step. `ip` = params integrate đang chạy (lấy sdf/occ/dt từ đó). */
  tick(solver: SandSolver, ip: IntegrateParams, tSec: number): void {
    const pool = solver.pool;
    const n = pool.count;
    const pos = pool.positions, vel = pool.velocities;
    const diag = solver.ccdDiag;
    const rw = pool.radii[0] > 1e-6 ? pool.radii[0] : ip.sdf.radiusLocal;
    const stillEps = STILL_STEP_R * rw;
    const eps2 = stillEps * stillEps;
    const dt = ip.dt;
    this.steps++;
    let perStep = 0;

    for (let i = 0; i < n; i++) {
      const i2 = i * 2;
      const x = pos[i2], y = pos[i2 + 1];
      const dx = x - this.prevPos[i2], dy = y - this.prevPos[i2 + 1];
      const d2 = dx * dx + dy * dy;
      const sp = Math.sqrt(vel[i2] * vel[i2] + vel[i2 + 1] * vel[i2 + 1]);
      const prevSp = this.prevSpeed[i];
      if (diag !== null) {
        const f = diag[i];
        if (f === CCD_DIAG_CLAMPED) this.ccdClamped++; else if (f === CCD_DIAG_SWEPT) this.ccdSwept++;
      }

      let kind: 'STALL' | 'PIN' | null = null;
      if (d2 < eps2) {
        const s = this.still[i] + 1;
        this.still[i] = s > 65000 ? 65000 : s;
        if (s === PIN_STEPS || (s > PIN_STEPS && s % PIN_REPEAT_STEPS === 0)) kind = 'PIN';
      } else {
        const s = this.still[i];
        if (s >= PIN_STEPS) this.runHist[s <= 5 ? 0 : (s <= 10 ? 1 : (s <= 20 ? 2 : 3))]++;
        this.still[i] = 0;
      }
      // Index vừa bị swap-remove (killBelowY/harvest): prevPos/prevSpeed thuộc hạt KHÁC -> dịch chuyển to bất
      // thường so với v trước -> không được tính STALL (PIN tự an toàn vì run bị reset về 0).
      const lim = prevSp * dt * 1.5 + stillEps;
      const plausible = d2 <= lim * lim;
      if (kind === null && plausible && prevSp >= STALL_MIN_V && sp < STALL_KEEP * prevSp) kind = 'STALL';

      if (kind !== null) {
        if (kind === 'STALL') this.stallEv++; else this.pinEv++;
        if (perStep < MAX_EVENTS_PER_STEP && this.events.length < MAX_EVENTS_PER_FLUSH) {
          perStep++;
          this.events.push(this.describe(kind, i, solver, ip, tSec, prevSp, sp, rw));
        } else {
          this.dropped++;
        }
      }
      this.prevPos[i2] = x; this.prevPos[i2 + 1] = y;
      this.prevSpeed[i] = sp;
    }
  }

  /** Dòng tổng + các dòng sự kiện gom từ lần flush trước; reset bộ đếm. Gọi cùng nhịp với probeStatic. */
  flush(): string[] {
    const st = Math.max(1, this.steps);
    const h = this.runHist;
    const lines: string[] = [
      `[pin] steps=${this.steps} stall=${this.stallEv} pinned=${this.pinEv} ` +
      `ccd/step S=${(this.ccdSwept / st).toFixed(1)} C=${(this.ccdClamped / st).toFixed(1)} ` +
      `run-bat-dong(step) 3-5:${h[0]} 6-10:${h[1]} 11-20:${h[2]} >20:${h[3]} bo-qua=${this.dropped}`,
    ];
    for (let k = 0; k < this.events.length; k++) lines.push(this.events[k]);
    this.events = [];
    this.steps = 0; this.stallEv = 0; this.pinEv = 0; this.dropped = 0;
    this.ccdSwept = 0; this.ccdClamped = 0;
    h[0] = 0; h[1] = 0; h[2] = 0; h[3] = 0;
    return lines;
  }

  private describe(kind: string, i: number, solver: SandSolver, ip: IntegrateParams, tSec: number,
                   prevSp: number, sp: number, rw: number): string {
    const pool = solver.pool;
    const pos = pool.positions, vel = pool.velocities;
    const i2 = i * 2;
    const x = pos[i2], y = pos[i2 + 1];

    const diag = solver.ccdDiag;
    const ccd = diag === null ? '-' : (diag[i] === CCD_DIAG_CLAMPED ? 'C' : (diag[i] === CCD_DIAG_SWEPT ? 'S' : 'E'));

    // corr đúng phép finalize dùng (frictionPosMu=0 -> fd=0). vn âm = finalize đã giết phần v này.
    const pr = solver.predicted;
    const cx = x - pr[i2], cy = y - pr[i2 + 1];
    const cl = Math.sqrt(cx * cx + cy * cy);
    const vn = cl > 1e-9 ? (vel[i2] * cx + vel[i2 + 1] * cy) / cl : 0;

    // SDF gần nhất (local): vành trong/ngoài stadium + mọi segment.
    const sdf = ip.sdf;
    xformPoint(sdf.worldToLocal, x, y, _lp);
    const dSpine = distToSpine(sdf, _lp.x, _lp.y);
    let dSdf = Math.min(Math.abs(dSpine - sdf.rOut), Math.abs(dSpine - sdf.rIn));
    const segs = ip.segments;
    for (let s = 0; s < sdf.segmentCount; s++) {
      const o = s * 4;
      const d = Math.sqrt(distSqToSeg(_lp.x, _lp.y, segs[o], segs[o + 1], segs[o + 2], segs[o + 3]));
      if (d < dSdf) dSdf = d;
    }
    const thr = thrOf(sdf);

    // Ô tranh RAW đặc trong 5x5 quanh hạt — cùng phép map cột/scroll/reveal như probeStatic.
    let occ5 = '-';
    if (ip.hasOcc !== 0) {
      const occ = ip.occ, raw = ip.occSnapshotRaw;
      const invCell = 1 / occ.occCellPixels;
      const relX = x - occ.worldOriginX, relY = y - occ.worldOriginY;
      const px = occ.invRow0X * relX + occ.invRow0Y * relY;
      const col = colOfPx(occ, px);
      const sPy = scrollPyOf(occ, col);
      colOccBounds(occ, col, _bounds);
      const oyMin = revealOyMin(occ, col);
      const ox = Math.floor(px * invCell);
      const oy = Math.floor((occ.invRow1X * relX + occ.invRow1Y * relY - sPy) * invCell);
      if (ox >= 0 && ox < occ.occWidth && oy >= 0 && oy < occ.occHeight) {
        let cnt = 0;
        for (let j = -2; j <= 2; j++) {
          for (let k = -2; k <= 2; k++) {
            if (occAt(raw, occ, ox + k, oy + j, _bounds.oxMin, _bounds.oxMax, oyMin)) cnt++;
          }
        }
        occ5 = `${cnt}/25`;
      }
    }

    const ec = occEjectDiag.perGrainCode !== null && i < occEjectDiag.perGrainCode.length
      ? occEjectDiag.perGrainCode[i] : 0;
    const est = occEjectDiag.perGrainStep !== null && i < occEjectDiag.perGrainStep.length
      ? occEjectDiag.perGrainStep[i] : 0;
    const epx = occEjectDiag.perGrainPushX !== null && i < occEjectDiag.perGrainPushX.length
      ? occEjectDiag.perGrainPushX[i] : 0;
    const epy = occEjectDiag.perGrainPushY !== null && i < occEjectDiag.perGrainPushY.length
      ? occEjectDiag.perGrainPushY[i] : 0;

    // Hàng xóm trong 2r + trùng tâm — brute force, chỉ chạy cho vài sự kiện/step nên rẻ.
    const n = pool.count;
    const r2 = (2 * rw) * (2 * rw);
    let nb = 0, co = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const ddx = pos[j * 2] - x, ddy = pos[j * 2 + 1] - y;
      const dd = ddx * ddx + ddy * ddy;
      if (dd < r2) nb++;
      if (dd < 1e-8) co++;
    }

    return `[pin] ${kind} t=${tSec.toFixed(2)} #${i} @(${x.toFixed(2)},${y.toFixed(2)}) ` +
           `v ${prevSp.toFixed(1)}->${sp.toFixed(1)} still=${this.still[i]} ccd=${ccd} ` +
           `corr=${cl.toFixed(3)} vn=${vn.toFixed(1)} sdf=${dSdf.toFixed(2)}(thr ${thr.toFixed(2)}) ` +
           `occ5=${occ5} nb2r=${nb} co=${co} ghost=${pool.ghost[i]}` +
           // Cú đẩy thoát của resolveOccupancy cho CHÍNH hạt này ở step vừa rồi (mảng theo hạt, không phải biến
           // toàn cục). `chua-goi` = resolveOccupancy KHÔNG hề chạy cho hạt này -> bước đi bị vứt ở chỗ khác.
           ` | eject=${OCC_EJECT_NAME[ec] ?? ec} push=(${epx.toFixed(2)},${epy.toFixed(2)}) step=${est.toFixed(4)}`;
  }
}

// ==================================================================== PixelProbe — "hạt" thật ra là PIXEL TRANH?
//
// ĐÍNH CHÍNH 2026-08-25 (user): triệu chứng thật là "hạt KẸT giữa không trung -> sau <30s BIẾN MẤT (không rơi) ->
// swipe thì HIỆN LẠI đúng vị trí cũ -> lại biến mất". Hạt pool không làm được chuyện "hiện lại đúng vị trí"; thứ có
// toạ độ cố định là PIXEL TRANH. Đo headless (so model vs texture mỗi 15 frame, 80s, 7 nét): texture luôn khớp
// model (0 ghost pixel, 0 ô tàng hình), nhưng có 27 ô HELD CÔ LẬP — 1 pixel mờ 0.8 đứng một mình giữa vùng đã rỗng,
// sống 15-293 frame rồi Held->Empty (alpha 0). Nhiều ô ở hàng ĐÁY tranh (world y≈16) = đúng chỗ túi hạt rơi ra
// -> nhìn như 1 hạt trong dòng rơi dừng lại rồi tan. Vì sao cô lập: ô bị cào LẠI muộn trong nét (SwipeBatch.append
// tombstone + arc mới -> xếp cuối thứ tự drain) hoặc KHÁC MÀU hàng xóm (convertGroupAt gom BFS cùng màu bỏ nó lại).
// Ca "hiện lại" headless CHƯA tái hiện; đường duy nhất làm pixel sáng lại là revert Held->Solid (restoreVisualCell)
// -> ghi cả nó. Probe này để USER chơi thật 1 lượt qua sink là có đủ 3 mốc.
//
// Mỗi lần quét (cùng nhịp staticProbePeriod) phân loại ô cơ chế:
//   ghostPixel     — model Empty mà texture còn alpha>0        => desync texture (chưa từng thấy)
//   invisibleSolid — model Solid/Held mà alpha=0 (gốc >0)       => desync ngược (chưa từng thấy)
//   isolatedHeld   — Held, 8 hàng xóm đều Empty                 => ★ "hạt kẹt" nghi chính
//   isolatedSolid  — Solid, 8 hàng xóm đều Empty                => ô sót chưa cào / vừa revert
// In `[pix] NEW ...` khi ô vào giỏ, `[pix] END ... sau Xs -> state/alpha` khi rời, `[pix] REVERT n=.. (px,py)..`.

type PixKind = 'ghostPixel' | 'invisibleSolid' | 'isolatedHeld' | 'isolatedSolid';
interface PixOpen { kind: PixKind; px: number; py: number; wx: number; wy: number; t0: number; a0: number; }
const STATE_NAME = ['Solid', 'Held', 'Empty'];
const MAX_PIX_LINES = 40;

export class PixelProbe {
  private readonly open = new Map<number, PixOpen>();
  private readonly seen = new Set<number>();
  private scans = 0;

  /** Quét toàn lưới cơ chế 1 lượt; trả các dòng log. Gọi cùng nhịp probeStatic. */
  scan(model: PictureCarveModel, tex: PictureTexture, map: PictureMap, host: SandPictureHost, tSec: number): string[] {
    const W = model.width, H = model.height;
    const lines: string[] = [];
    const counts = { ghostPixel: 0, invisibleSolid: 0, isolatedHeld: 0, isolatedSolid: 0 };
    this.seen.clear();
    this.scans++;

    // ĐẾM THÔ, KHÔNG LỌC CÔ LẬP: ô Held = ô đã swipe mà CHƯA tan -> đứng im trên tranh. Bộ lọc isolated bên dưới
    // chỉ bắt ô LẺ, nên một CỤM Held kẹt (đúng thứ user thấy: "rất nhiều hạt đứng im" ở một chỗ) lọt sạch.
    let heldTotal = 0;
    let solidTotal = 0;
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const state = model.stateAt(px, py) as number;
        if (state === 1) heldTotal++; else if (state === 0) solidTotal++;
        const a = tex.liveAlphaAt(px, py), ba = tex.baseAlphaAt(px, py);
        let kind: PixKind | null = null;
        if (state === 2) { if (a > 0) kind = 'ghostPixel'; }
        else if (ba > 0 && a === 0) kind = 'invisibleSolid';
        else if (state === 1 && this.isolated(model, px, py)) kind = 'isolatedHeld';
        else if (state === 0 && ba > 0 && this.isolated(model, px, py)) kind = 'isolatedSolid';
        if (kind === null) continue;
        counts[kind]++;
        const key = py * W + px;
        this.seen.add(key);
        const o = this.open.get(key);
        if (o === undefined) {
          map.cellToWorld(px, py, _lp);
          this.open.set(key, { kind, px, py, wx: _lp.x, wy: _lp.y, t0: tSec, a0: a });
          if (lines.length < MAX_PIX_LINES) {
            lines.push(`[pix] NEW ${kind} cell(${px},${py}) world(${_lp.x.toFixed(2)},${_lp.y.toFixed(2)}) a=${a} t=${tSec.toFixed(1)}`);
          }
        } else if (o.kind !== kind) {
          if (lines.length < MAX_PIX_LINES) {
            lines.push(`[pix] CHANGE ${o.kind}->${kind} cell(${px},${py}) sau ${(tSec - o.t0).toFixed(1)}s a=${a}`);
          }
          o.kind = kind; o.t0 = tSec; o.a0 = a;
        }
      }
    }
    for (const [key, o] of this.open) {
      if (this.seen.has(key)) continue;
      this.open.delete(key);
      if (lines.length < MAX_PIX_LINES) {
        const st = model.stateAt(o.px, o.py) as number;
        lines.push(`[pix] END ${o.kind} cell(${o.px},${o.py}) world(${o.wx.toFixed(2)},${o.wy.toFixed(2)}) ` +
                   `sau ${(tSec - o.t0).toFixed(1)}s -> ${STATE_NAME[st] ?? st} a=${tex.liveAlphaAt(o.px, o.py)}`);
      }
    }
    const rv = host.revertDiag;
    if (rv.length > 0) {
      let s = '';
      for (let k = 0; k < Math.min(rv.length, 12); k++) s += ` (${rv[k] % W},${(rv[k] / W) | 0})`;
      lines.push(`[pix] REVERT n=${rv.length}${s}${rv.length > 12 ? ' ...' : ''}`);
      rv.length = 0;
    }
    lines.unshift(`[pix] scan#${this.scans} t=${tSec.toFixed(1)} ghostPixel=${counts.ghostPixel} invisibleSolid=${counts.invisibleSolid} ` +
                  `isolatedHeld=${counts.isolatedHeld} isolatedSolid=${counts.isolatedSolid} dang-theo-doi=${this.open.size}` +
                  ` | HELD-tong=${heldTotal} Solid-tong=${solidTotal}`);
    return lines;
  }

  private isolated(model: PictureCarveModel, px: number, py: number): boolean {
    const W = model.width, H = model.height;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const x = px + dx, y = py + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        if ((model.stateAt(x, y) as number) !== 2) return false;
      }
    }
    return true;
  }
}

// ==================================================================== probePoint — phím P: "chỗ đó CÓ GÌ"
//
// VÌ SAO CÓ CÁI NÀY (2026-08-25): user mô tả bug bằng HAI sự kiện quan sát, và mọi probe trước đều trả lời sai câu:
//   (1) hạt đứng im ở MỌI PHA — cào · rơi · trượt funnel · trên conveyor;
//   (2) hạt đứng im KHÔNG phản ứng va chạm — hạt khác ĐI XUYÊN QUA như thể nó không tồn tại.
// (2) là ràng buộc mạnh nhất: mọi giả thuyết "hạt bị GIỮ lại" đều SAI, vì hạt bị giữ vẫn nằm trong pool + lưới
// neighbor nên hạt khác PHẢI đè lên nó. probeStatic/PixelProbe/StallTracker đều đi hỏi "CÁI GÌ ĐANG GIỮ NÓ" ⇒ hỏi
// nhầm câu ⇒ báo sạch trong khi bug vẫn còn nguyên.
//
// Hàm này hỏi ĐÚNG câu: tại toạ độ user chỉ, cái đang HIỆN RA có mặt trong đường VA CHẠM không.
//
// Cách nó tránh tự lừa mình: đo cùng một chỗ bằng HAI đường độc lập rồi ĐỐI CHIẾU.
//   (A) BRUTE-FORCE quét thẳng pool — sự thật "có hạt ở đó không", không đi qua lưới.
//   (B) QUERY LƯỚI lặp NGUYÊN VĂN contactAccumulate (cùng rowSpan · cùng ring · cùng ô) — "ai TỒN TẠI với hạt khác".
// A thấy mà B không thấy = CHỨNG CỨ TRỰC TIẾP cho (2), và chỉ thẳng tầng hỏng là lưới/indexing, không phải vật lý.
//
// Mỗi hạt in thêm 2 cờ tự-kiểm của lưới:
//   oCell   ô suy TỪ VỊ TRÍ vs `cellIndex[i]` mà build đã ghi. LỆCH = hạt bị KẸP về ô biên (neighborGrid.ts, trần
//           MAX_DIM=512) ⇒ entry của nó nằm ở ô KHÁC chỗ nó đứng ⇒ hạt bên cạnh query không bao giờ thấy nó ⇒ xuyên
//           qua. Ứng viên khớp (2) mà không cần thêm giả thuyết nào.
//   inSpan  chính index i có nằm trong dải entryIdx của ô nó đáng lẽ thuộc về không.
//
// (C) quét SCENE GRAPH quanh điểm: nếu thứ đứng im KHÔNG phải hạt solver thì nó là một node đang bật — liệt kê tên
// ra thay vì đoán nó thuộc pool VFX nào.
//
// ĐỌC KẾT QUẢ:
//   hạt nào `luoi=THIEU`  = đúng thủ phạm của (2); xem `oCell`/`inSpan` để biết bị kẹp hay indexing sai.
//   A rỗng + C có node    = thứ đứng im KHÔNG phải hạt cát mà là node vẽ (đọc tên node ra là biết pool nào).
//   A và B khớp hết       = tại điểm đó lưới LÀNH -> bấm P lại ĐÚNG LÚC đang thấy hạt đứng im.

/** Đếm hạt trong bán kính r quanh (wx,wy) — brute-force, không qua lưới. NaN toạ độ -> 0. */
export function countGrainsNear(pool: GrainParticlePool, wx: number, wy: number, r: number): number {
  if (Number.isNaN(wx) || Number.isNaN(wy)) return 0;
  const n = pool.count, pos = pool.positions, r2 = r * r;
  let c = 0;
  for (let i = 0; i < n; i++) {
    const dx = pos[i * 2] - wx, dy = pos[i * 2 + 1] - wy;
    if (dx * dx + dy * dy <= r2) c++;
  }
  return c;
}

/** Bán kính quét mặc định quanh điểm bấm (world). ~2 đường kính hạt. */
const POINT_R_DEFAULT = 1.5;
/** Trần số hạt / node in ra cho 1 lần bấm — bấm giữa đụn cát có thể trúng hàng trăm. */
const POINT_MAX_LIST = 24;
/** Bán kính quét node scene = bội của bán kính hạt (node VFX to hơn hạt nhiều). */
const POINT_NODE_R_MUL = 3;

const _pspan: Span = { begin: 0, end: 0 };

/** Đường dẫn node để đọc ra biết nó thuộc pool nào (fly_ / shard_ / puff_ ...). Cắt bớt cho gọn. */
function nodePath(n: Node, depth: number): string {
  let s = n.name;
  let p: Node | null = n.parent;
  for (let k = 0; k < depth && p !== null; k++) { s = p.name + '/' + s; p = p.parent; }
  return s;
}

/** Gom node ĐANG BẬT có world position nằm trong bán kính r quanh (wx,wy). Đệ quy có chặn độ sâu + trần số. */
function collectNodesNear(root: Node, wx: number, wy: number, r: number,
                          out: { path: string; x: number; y: number; z: number; d: number }[],
                          depth: number): void {
  if (depth > 12 || out.length > 400) return;
  const kids = root.children;
  for (let k = 0; k < kids.length; k++) {
    const c = kids[k];
    if (!c.activeInHierarchy) continue;      // node tắt thì không vẽ ra -> không phải thứ user đang thấy
    const wp = c.worldPosition;
    const dx = wp.x - wx, dy = wp.y - wy;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d <= r) out.push({ path: nodePath(c, 3), x: wp.x, y: wp.y, z: wp.z, d });
    collectNodesNear(c, wx, wy, r, out, depth + 1);
  }
}

/**
 * Chọc vào 1 điểm world: in ra chỗ đó có gì, và thứ ở đó có TỒN TẠI với hệ va chạm không.
 *
 * @param solver    solver mode A đang chạy — cần `cellGrid` + `gridBuffers` của step VỪA xong, nên gọi SAU solver.step.
 * @param sceneRoot gốc để quét node (null = bỏ mục C).
 */
export function probePoint(wx: number, wy: number, solver: SandSolver, ip: IntegrateParams,
                           sceneRoot: Node | null, tSec: number,
                           radius: number = POINT_R_DEFAULT): string[] {
  const lines: string[] = [];
  const pool = solver.pool;
  const n = pool.count;
  const pos = pool.positions, vel = pool.velocities, rad = pool.radii, cid = pool.colorIds;
  const gh = pool.ghost, dj = pool.directJar, car = pool.carried;
  const R = radius > 0 ? radius : POINT_R_DEFAULT;

  lines.push(`[P] t=${tSec.toFixed(2)} @(${wx.toFixed(2)},${wy.toFixed(2)}) R=${R.toFixed(2)} pool=${n}`);

  // ---------- (A) BRUTE-FORCE: sự thật, không đi qua lưới ----------
  const hits: number[] = [];
  const R2 = R * R;
  for (let i = 0; i < n; i++) {
    const dx = pos[i * 2] - wx, dy = pos[i * 2 + 1] - wy;
    if (dx * dx + dy * dy <= R2) hits.push(i);
  }

  // ---------- (B) QUERY LƯỚI: lặp NGUYÊN VĂN contactAccumulate tại điểm này ----------
  const g = solver.cellGrid;
  const buf = solver.gridBuffers;
  const found: Record<number, boolean> = {};
  let qCount = 0;
  const gridOk = g !== undefined && g !== null && g.width > 0 && g.cellSize > 0;
  if (gridOk) {
    const cgx = Math.floor(wx / g.cellSize), cgy = Math.floor(wy / g.cellSize);
    for (let dy = -g.ring; dy <= g.ring; dy++) {
      if (!rowSpan(g, buf.cellStart, cgy + dy, cgx - g.ring, cgx + g.ring, _pspan)) continue;
      for (let e = _pspan.begin; e < _pspan.end; e++) { found[buf.entryIdx[e]] = true; qCount++; }
    }
    lines.push(`[P] luoi: ${g.width}x${g.height} cell=${g.cellSize.toFixed(3)} ring=${g.ring} ` +
               `min=(${g.minCellX},${g.minCellY}) | query tra ve ${qCount} entry`);
  } else {
    lines.push('[P] luoi: CHUA BUILD (width=0) -> khong hat nao va cham duoc');
  }

  // ---------- ĐỐI CHIẾU A vs B ----------
  let missing = 0;
  for (let k = 0; k < hits.length; k++) if (found[hits[k]] !== true) missing++;
  lines.push(`[P] brute-force=${hits.length} hat trong R | luoi thay=${hits.length - missing} | ` +
             `THIEU=${missing}${missing > 0 ? '  <<< HAT VO HINH VOI VA CHAM (khop trieu chung 2)' : ''}`);

  const lim = hits.length < POINT_MAX_LIST ? hits.length : POINT_MAX_LIST;
  for (let k = 0; k < lim; k++) {
    const i = hits[k];
    const x = pos[i * 2], y = pos[i * 2 + 1];
    const vx = vel[i * 2], vy = vel[i * 2 + 1];
    // ô suy TỪ VỊ TRÍ vs ô mà build đã ghi -> lệch = bị kẹp về biên (trần MAX_DIM).
    let oCell = '-';
    let inSpan = '-';
    if (gridOk) {
      const cx = cellOf(x, g.cellSize), cy = cellOf(y, g.cellSize);
      const rx = cx - g.minCellX, ry = cy - g.minCellY;
      const want = (rx >= 0 && rx < g.width && ry >= 0 && ry < g.height) ? ry * g.width + rx : -1;
      const got = buf.cellIndex[i];
      oCell = want === got ? `ok(${got})` : `LECH want=${want} got=${got}`;
      if (want >= 0 && rowSpan(g, buf.cellStart, cy, cx, cx, _pspan)) {
        let seen = false;
        for (let e = _pspan.begin; e < _pspan.end; e++) if (buf.entryIdx[e] === i) { seen = true; break; }
        inSpan = seen ? 'co' : 'KHONG';
      } else {
        inSpan = 'o-ngoai-luoi';
      }
    }
    const sp = Math.sqrt(vx * vx + vy * vy);
    lines.push(`[P]   #${i} @(${x.toFixed(2)},${y.toFixed(2)}) |v|=${sp.toFixed(2)} ` +
               `r=${rad[i].toFixed(3)} mau=${cid[i]} carried=${car[i]} ghost=${gh[i]} direct=${dj[i]} ` +
               `luoi=${found[i] === true ? 'co' : 'THIEU'} oCell=${oCell} inSpan=${inSpan}`);
  }
  if (hits.length > lim) lines.push(`[P]   ... con ${hits.length - lim} hat nua (an bot)`);

  // ---------- occupancy + tường tại CHÍNH điểm bấm ----------
  if (ip.hasOcc !== 0) {
    const occ = ip.occ;
    const relX = wx - occ.worldOriginX, relY = wy - occ.worldOriginY;
    const px = occ.invRow0X * relX + occ.invRow0Y * relY;
    const col = colOfPx(occ, px);
    const sPy = scrollPyOf(occ, col);
    colOccBounds(occ, col, _bounds);
    const oyMin = revealOyMin(occ, col);
    const iv = 1 / occ.occCellPixels;
    const ox = Math.floor(px * iv);
    const oy = Math.floor((occ.invRow1X * relX + occ.invRow1Y * relY - sPy) * iv);
    const inG = ox >= 0 && ox < occ.occWidth && oy >= 0 && oy < occ.occHeight;
    const raw = inG && occAt(ip.occSnapshotRaw, occ, ox, oy, _bounds.oxMin, _bounds.oxMax, oyMin);
    const dil = inG && occAt(ip.occSnapshot, occ, ox, oy, _bounds.oxMin, _bounds.oxMax, oyMin);
    lines.push(`[P] tranh: o=(${ox},${oy}) cot=${col} trong-luoi=${inG ? 1 : 0} ` +
               `RAW=${raw ? 1 : 0} DILATE=${dil ? 1 : 0}`);
  }
  xformPoint(ip.sdf.worldToLocal, wx, wy, _lp);
  lines.push(`[P] sdf: local=(${_lp.x.toFixed(2)},${_lp.y.toFixed(2)}) ` +
             `d-spine=${distToSpine(ip.sdf, _lp.x, _lp.y).toFixed(3)} rIn=${ip.sdf.rIn.toFixed(2)} ` +
             `rOut=${ip.sdf.rOut.toFixed(2)} thr=${thrOf(ip.sdf).toFixed(3)}`);

  // ---------- (C) node scene đang bật quanh điểm ----------
  if (sceneRoot !== null) {
    const nodes: { path: string; x: number; y: number; z: number; d: number }[] = [];
    collectNodesNear(sceneRoot, wx, wy, R * POINT_NODE_R_MUL, nodes, 0);
    nodes.sort((a, b) => a.d - b.d);
    lines.push(`[P] node dang bat trong ${(R * POINT_NODE_R_MUL).toFixed(2)}: ${nodes.length}`);
    const nl = nodes.length < POINT_MAX_LIST ? nodes.length : POINT_MAX_LIST;
    for (let k = 0; k < nl; k++) {
      const q = nodes[k];
      lines.push(`[P]   ${padR(q.path, 34)} @(${q.x.toFixed(2)},${q.y.toFixed(2)},${q.z.toFixed(2)}) ` +
                 `d=${q.d.toFixed(2)}`);
    }
    if (nodes.length > nl) lines.push(`[P]   ... con ${nodes.length - nl} node nua (an bot)`);
  }

  return lines;
}

/** Nửa cạnh cửa sổ ô tranh in ra quanh con trỏ khi bấm P. 6 -> lưới 13x13 ô. */
const POINT_WIN = 6;

/**
 * Ảnh chụp ô TRANH quanh con trỏ: trạng thái model + alpha texture, dạng lưới ký tự đọc bằng mắt.
 *   `#` Solid (chưa cào) · `o` Held (đã cào, CHƯA tan — đây là thứ đứng im) · `.` Empty (đã tan) · `X` lệch model/texture
 * Cần nó vì `PixelProbe` chỉ bắt ô Held CÔ LẬP (8 hàng xóm đều Empty) nên một CỤM Held kẹt lọt lưới hoàn toàn.
 */
export function probePictureWindow(wx: number, wy: number, model: PictureCarveModel,
                                   tex: PictureTexture, ip: IntegrateParams): string[] {
  const lines: string[] = [];
  if (ip.hasOcc === 0) return lines;
  const occ = ip.occ;
  const relX = wx - occ.worldOriginX, relY = wy - occ.worldOriginY;
  const pxf = occ.invRow0X * relX + occ.invRow0Y * relY;
  const col = colOfPx(occ, pxf);
  const pyf = occ.invRow1X * relX + occ.invRow1Y * relY - scrollPyOf(occ, col);
  const cx = Math.floor(pxf), cy = Math.floor(pyf);

  let solid = 0, held = 0, empty = 0, mismatch = 0;
  lines.push(`[P] tranh quanh con tro: tam o=(${cx},${cy})  # Solid · o HELD(dung im) · . Empty · X lech`);
  for (let dy = -POINT_WIN; dy <= POINT_WIN; dy++) {
    let row = '';
    for (let dx = -POINT_WIN; dx <= POINT_WIN; dx++) {
      const px = cx + dx, py = cy + dy;
      const s = model.stateAt(px, py) as number;
      if (s < 0) { row += ' '; continue; }
      const a = tex.liveAlphaAt(px, py), ba = tex.baseAlphaAt(px, py);
      if (s === 2) { if (a > 0) { row += 'X'; mismatch++; } else { row += '.'; empty++; } }
      else if (s === 1) { if (ba > 0 && a === 0) { row += 'X'; mismatch++; } else { row += 'o'; held++; } }
      else { if (ba > 0 && a === 0) { row += 'X'; mismatch++; } else { row += '#'; solid++; } }
    }
    lines.push(`[P]   ${row}`);
  }
  lines.push(`[P] cua so: Solid=${solid} HELD=${held} Empty=${empty} lech=${mismatch}` +
             (held > 0 ? '  <<< CO O HELD KET TAI DAY' : ''));
  return lines;
}
