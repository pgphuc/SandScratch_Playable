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

import type { GrainParticlePool } from '../solver/pool';
import type { IntegrateParams } from '../solver/integrate';
import { thrOf, xformPoint, v2, type GrainSdfField, type V2 } from '../solver/sdfWalls';
import { colOfPx, scrollPyOf, colOccBounds, revealOyMin, occAt, type ColBounds } from '../solver/occupancy';

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
 */
export function probeStatic(pool: GrainParticlePool, ip: IntegrateParams): string[] {
  const n = pool.count;
  if (n === 0) return ['[probe] pool rỗng'];

  const pos = pool.positions, vel = pool.velocities, gh = pool.ghost;
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

  for (let i = 0; i < n; i++) {
    const vx = vel[i * 2], vy = vel[i * 2 + 1];
    if (vx * vx + vy * vy >= V_STILL * V_STILL) continue;
    still++;

    const wx = pos[i * 2], wy = pos[i * 2 + 1];
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
  return lines;
}
