// PORT Mode A — nguồn: ir/code/!_Game_SDK/SandFlow/Flow/Grain/GrainNeighborGrid.cs (239 dòng).
// Lưới ROW-MAJOR (KHÔNG phải hash-bucket): index ô = (cy-minCell.y)*width + (cx-minCell.x) -> 3 ô liền nhau của 1 hàng
// là 1 DẢI LIÊN TỤC trong entryIdx. Query (2*ring+1)² = (2*ring+1) dải, 0 hash, 0 nhánh lọc.
// Nguồn ghi rõ: lưới KHÔNG bit-identical với đường hashmap cũ (hashmap ĐẾM ĐÔI khi 2/9 ô đụng math.hash) ->
// chân lý verify = BRUTE-FORCE THEO ĐỊNH NGHĨA Ô, không so với hashmap. Test parity dựng đúng theo đó.

export const MAX_DIM = 512;        // trần mỗi chiều (ô). Hạt ngoài trần bị KẸP về ô biên (an toàn: consumer test khoảng cách).
export const MAX_SUBDIV = 4;       // trần subdiv m (cellSize = 2r/m)
export const TALLY_SLACK = 1.1;    // slack của Tally bên nguồn (dùng cho quadrant-sleep — cơ chế KHÔNG port; giữ hằng để grid parity)
export const MAX_CELLS = MAX_DIM * MAX_DIM;

/** Hình học lưới — build job ghi 1 lần, consumer đọc 1 lần đầu vòng. */
export interface GrainCellGrid {
  minCellX: number;
  minCellY: number;
  width: number;     // 0 = lưới rỗng/chưa build -> mọi rowSpan trả false
  height: number;
  cellSize: number;  // cạnh ô THẬT = cellSize gốc / subdiv (KHÔNG phải 2r của đường hashmap)
  ring: number;      // số dải mỗi phía cho consumer R = 2r
  ringSlack: number; // ring cho Tally (R = 2r * TALLY_SLACK)
}

export function cellOf(p: number, cellSize: number): number {
  return Math.floor(p / cellSize);
}

/** Kết quả dải [begin,end) — trả về qua object tái dùng để không cấp phát trong vòng update. */
export interface Span { begin: number; end: number; }

/** Dải entry của ĐOẠN ô [x0..x1] trên hàng cy (đã kẹp về trong lưới). false = đoạn rỗng/ngoài lưới. */
export function rowSpan(g: GrainCellGrid, cellStart: Int32Array, cy: number, x0: number, x1: number, out: Span): boolean {
  out.begin = 0;
  out.end = 0;
  if (g.width <= 0 || g.height <= 0) return false;
  const ry = cy - g.minCellY;
  if (ry < 0 || ry >= g.height) return false;
  let a = x0 - g.minCellX;
  let b = x1 - g.minCellX;
  if (a < 0) a = 0;
  if (b >= g.width) b = g.width - 1;
  if (a > b) return false;
  const rowBase = ry * g.width;
  out.begin = cellStart[rowBase + a];
  out.end = cellStart[rowBase + b + 1];   // b = width-1 -> trỏ đầu hàng sau; prefix-sum đơn điệu toàn mảng nên đúng
  return out.end > out.begin;
}

/** Bộ nhớ lưới cấp 1 lần (thay NativeArray Persistent bên nguồn). */
export class GrainNeighborGridBuffers {
  cellIndex: Int32Array;
  cellStart: Int32Array;
  cursor: Int32Array;
  entryIdx: Int32Array;
  grid: GrainCellGrid = { minCellX: 0, minCellY: 0, width: 0, height: 0, cellSize: 0, ring: 1, ringSlack: 1 };

  constructor(maxParticles: number, maxCells: number = MAX_CELLS) {
    this.cellIndex = new Int32Array(maxParticles);
    this.cellStart = new Int32Array(maxCells + 1);
    this.cursor = new Int32Array(maxCells);
    this.entryIdx = new Int32Array(maxParticles);
  }
}

/**
 * Build lưới row-major cho [0..count). Port của GrainNeighborGridBuildJob (IJob TUẦN TỰ, 4 lượt, không atomic).
 * cellSize = cellSize GỐC 2r; hàm tự chia cho subdiv.
 */
export function buildNeighborGrid(
  buf: GrainNeighborGridBuffers, positions: Float32Array, count: number,
  cellSize: number, subdiv: number, maxDim: number = MAX_DIM,
): GrainCellGrid {
  const m = Math.min(Math.max(subdiv | 0, 1), MAX_SUBDIV);
  const cell = cellSize / m;
  const ring = m;
  // m=1 -> 1 = giữ NGUYÊN query cũ của Tally (kể cả nợ "phủ 2r < 2.2r", để m=1 là rollback sạch).
  const ringSlack = m === 1 ? 1 : Math.ceil(TALLY_SLACK * m);
  const g = buf.grid;
  g.cellSize = cell;
  g.ring = ring;
  g.ringSlack = ringSlack;

  if (count <= 0) {
    g.minCellX = 0; g.minCellY = 0; g.width = 0; g.height = 0;   // width=0 -> rowSpan luôn false
    return g;
  }

  // (1) AABP ô.
  let loX = cellOf(positions[0], cell), loY = cellOf(positions[1], cell);
  let hiX = loX, hiY = loY;
  for (let i = 1; i < count; i++) {
    const cx = cellOf(positions[i * 2], cell);
    const cy = cellOf(positions[i * 2 + 1], cell);
    if (cx < loX) loX = cx; else if (cx > hiX) hiX = cx;
    if (cy < loY) loY = cy; else if (cy > hiY) hiY = cy;
  }
  const w = Math.min(hiX - loX + 1, maxDim);
  const h = Math.min(hiY - loY + 1, maxDim);
  g.minCellX = loX; g.minCellY = loY; g.width = w; g.height = h;

  // (2) clear ĐÚNG phần dùng (chi phí ∝ ô THẬT, không ∝ trần).
  const nCells = w * h;
  const cellStart = buf.cellStart, cursor = buf.cursor, cellIndex = buf.cellIndex, entryIdx = buf.entryIdx;
  for (let b = 0; b <= nCells; b++) cellStart[b] = 0;

  // (3) đếm vào ô b+1 -> prefix-sum tại chỗ. Hạt ngoài trần -> KẸP về ô biên.
  const hiInX = loX + w - 1, hiInY = loY + h - 1;
  for (let i = 0; i < count; i++) {
    let cx = cellOf(positions[i * 2], cell);
    let cy = cellOf(positions[i * 2 + 1], cell);
    if (cx < loX) cx = loX; else if (cx > hiInX) cx = hiInX;
    if (cy < loY) cy = loY; else if (cy > hiInY) cy = hiInY;
    const ci = (cy - loY) * w + (cx - loX);
    cellIndex[i] = ci;
    cellStart[ci + 1]++;
  }
  for (let b = 0; b < nCells; b++) {
    const s = cellStart[b] + cellStart[b + 1];
    cellStart[b + 1] = s;
    cursor[b] = cellStart[b];
  }
  // (4) fill.
  for (let i = 0; i < count; i++) {
    const ci = cellIndex[i];
    entryIdx[cursor[ci]++] = i;
  }
  return g;
}
