// Cài `PictureHost` — seam duy nhất giữa ConversionFront (engine-agnostic) và lớp Cocos.
// Nó nắm 3 việc mà solver CỐ Ý không biết:
//   (1) ánh xạ cell tranh <-> world           -> uỷ cho PictureMap
//   (2) hình của tranh (mờ/xoá/sáng lại ô)    -> uỷ cho PictureTexture
//   (3) 3 HÀNG CHỜ túi vuốt (swipe / thin / auto) + pool túi
//
// Phần (3) là port từ Unity `PictureColliderBuilder.cs` (vùng "SWIPE BATCH" + "DẢI MỎNG TỰ TAN"). `EnqueueThinStripBatch`
// và `IsThinAt`/`SolidRun` dịch 1:1 — kể cả chi tiết 4 TRỤC (ngang · dọc · chéo ↘ · chéo ↗) và arc = độ sâu BFS.
//
// LỆCH CÓ CHỦ Ý so với nguồn:
//  · Nguồn log cảnh báo khi hàng chờ closed-batch vượt 8 (MaxQueuedBatches) và KHÔNG thả túi. Giữ nguyên hành vi
//    (không thả), nhưng cảnh báo đổi thành đếm `queueOverflowCount` để P6 đọc số thay vì đọc log webview.
//  · Level 0001 KHÔNG scroll (viewportHeight == height == 200, columnCount == 1) -> `isCellRevealed` luôn true và
//    `revealVersion` đứng yên. Seam vẫn giữ ĐÚNG hình dạng để level scroll dùng lại được, KHÔNG cắt đi.

import { PictureCarveModel, PictureCellState } from '../solver/carveModel';
import { SwipeBatch, SwipeBatchChannel, type TakenCell } from '../solver/swipeBatch';
import type { PictureHost } from '../solver/conversionFront';
import type { V2 } from '../solver/sdfWalls';
import { PictureMap } from './PictureMap';
import { PictureTexture } from './PictureTexture';

const NX4 = [1, -1, 0, 0];
const NY4 = [0, 0, 1, -1];
// 4 TRỤC đo bề dày. 4 chứ không 2: brush TRÒN cắt ra dải CHÉO, mà dải chéo thì run ngang lẫn dọc đều dài
// (~N/sinθ) nên đo 2 trục sẽ báo "dày" và bỏ sót đúng loại hay kẹt nhất. (Nguyên văn lý do của nguồn.)
const AXIS_X = [1, 0, 1, 1];
const AXIS_Y = [0, 1, 1, -1];

/** Ngưỡng cảnh báo hàng chờ (nguồn: MaxQueuedBatches). Vượt = ĐẾM, không thả túi (thả = cát biến mất). */
const MAX_QUEUED_BATCHES = 8;

export interface SandPictureHostConfig {
  slabCells: number;            // swipeBatchSlabCells
  thinStripCells: number;       // swipeBatchThinStripCells — 0 = TẮT dải-mỏng-tự-tan
  thinStripMaxCells: number;    // swipeBatchThinStripMaxCells — trần flood theo sợi
  spawnClearanceMargin: number;
}

export class SandPictureHost implements PictureHost {
  readonly model: PictureCarveModel;
  readonly map: PictureMap;
  readonly tex: PictureTexture;

  spawnClearanceMargin: number;

  private readonly cfg: SandPictureHostConfig;

  // --- 3 hàng chờ + pool túi ---
  private openBatch: SwipeBatch | null = null;
  private readonly closedBatches: SwipeBatch[] = [];
  private readonly thinBatches: SwipeBatch[] = [];
  private readonly autoBatches: SwipeBatch[] = [];
  private readonly batchPool: SwipeBatch[] = [];

  /** Số lần hàng chờ closed vượt MAX_QUEUED_BATCHES — P6 đọc số này thay vì đọc log. */
  queueOverflowCount = 0;

  // --- reveal (level scroll). Level không scroll -> đứng yên. ---
  private revealVersionValue = 0;

  // --- scratch cho EnqueueThinStripBatch: cấp 1 lần, 0 alloc sau lần đầu (đúng nguồn) ---
  private readonly thinSeeds: number[] = [];
  private readonly thinDepth: number[] = [];
  private readonly thinSeen = new Set<number>();
  private readonly thinBfs: number[] = [];
  private thinBfsHead = 0;
  /** Ô vừa carve trong lượt hiện tại -> DimCarvedVisual. */
  private readonly carveScratch: number[] = [];

  constructor(model: PictureCarveModel, map: PictureMap, tex: PictureTexture, cfg: SandPictureHostConfig) {
    this.model = model;
    this.map = map;
    this.tex = tex;
    this.cfg = cfg;
    this.spawnClearanceMargin = cfg.spawnClearanceMargin;
  }

  // ======================================================================== (1) toạ độ

  pictureCellToWorld(cx: number, cy: number, out: V2): V2 {
    return this.map.cellToWorld(cx, cy, out);
  }

  picturePixelWorldSize(): number {
    return this.map.pixelSize;
  }

  pictureDownWorldDir(out: V2): V2 {
    return this.map.downWorldDir(out);
  }

  // ======================================================================== (2) hình

  eraseVisualCell(px: number, py: number): void {
    this.tex.erase(px, py);
  }

  restoreVisualCell(px: number, py: number, orderT: number): void {
    this.tex.restore(px, py, orderT);
  }

  /** Ô đã cào nhưng chưa tan -> mờ 0.8 (nguồn: DimCarvedVisual). Gọi sau mỗi lượt carve. */
  private dimCarvedVisual(): void {
    const w = this.model.width;
    for (let k = 0; k < this.carveScratch.length; k++) {
      const i = this.carveScratch[k];
      this.tex.dim(i % w, (i / w) | 0);
    }
    this.carveScratch.length = 0;
  }

  // ======================================================================== reveal (scroll)

  /**
   * Level 0001 không scroll -> luôn true. Level scroll: ô còn nằm TRÊN cửa sổ thì chưa lộ, cào nó = visual erase
   * rơi vào vùng chưa bake = no-op, rồi lúc cột tụt bake tô lại từ data -> pixel hiện lại trong khi model đã
   * Held/Empty -> KHÔNG cào lại được = KẸT VĨNH VIỄN. Đó là lý do guard này tồn tại, không phải tối ưu.
   */
  isCellRevealed(px: number, py: number): boolean {
    const occ = this.model;
    if (px < 0 || py < 0 || px >= occ.width || py >= occ.height) return false;
    return true;
  }

  get revealVersion(): number { return this.revealVersionValue; }

  /** Level scroll gọi khi tranh lộ thêm hàng -> front re-arm auto-swipe. Level không scroll không ai gọi. */
  bumpRevealVersion(): void { this.revealVersionValue++; }

  // ======================================================================== (3) hàng chờ túi

  get hasOpenBatch(): boolean { return this.openBatch !== null; }
  get hasClosedBatch(): boolean { return this.closedBatches.length > 0; }
  get hasThinBatch(): boolean { return this.thinBatches.length > 0; }
  get hasAutoBatch(): boolean { return this.autoBatches.length > 0; }

  tryDequeueClosedBatch(): SwipeBatch | null { return this.closedBatches.shift() ?? null; }
  tryDequeueThinBatch(): SwipeBatch | null { return this.thinBatches.shift() ?? null; }
  tryDequeueAutoBatch(): SwipeBatch | null { return this.autoBatches.shift() ?? null; }

  /** Front trả túi đã drain xong -> về pool. KHÔNG reset ở đây: reset lúc LẤY ra (cần width lúc đó). */
  releaseBatch(batch: SwipeBatch): void {
    this.batchPool.push(batch);
  }

  private takeBatch(): SwipeBatch {
    const b = this.batchPool.pop() ?? new SwipeBatch();
    b.reset(this.model.width);
    return b;
  }

  /** Ô bỏ cuộc được xếp lại thành túi MỚI của đúng kênh cũ (RETRY — không revert). */
  enqueueRetryBatch(cells: readonly number[], channel: SwipeBatchChannel): void {
    if (cells.length === 0) return;
    const b = this.takeBatch();
    b.markNoRevert();
    for (let k = 0; k < cells.length; k++) {
      const i = cells[k];
      if (i >= 0) b.append(i, 0);
    }
    if (b.isEmpty) { this.batchPool.push(b); return; }
    b.closeAndOrder(this.cfg.slabCells);
    this.queueForChannel(channel).push(b);
  }

  private queueForChannel(channel: SwipeBatchChannel): SwipeBatch[] {
    if (channel === SwipeBatchChannel.Thin) return this.thinBatches;
    if (channel === SwipeBatchChannel.Auto) return this.autoBatches;
    return this.closedBatches;
  }

  // ======================================================================== SWIPE của ngón tay

  /**
   * Ngón tay đi qua ô (px,py) với `strokeArc` = quãng đường đã đi (đơn vị Ô). Mở túi nếu chưa có.
   * `brushRadius` theo Ô cơ chế. Trả số ô VỪA chuyển Solid->Held.
   */
  carveAt(px: number, py: number, brushRadius: number, strokeArc: number): number {
    if (this.openBatch === null) this.openBatch = this.takeBatch();
    const batch = this.openBatch;
    const before = this.carveScratch.length;
    this.model.carveBrush(px, py, brushRadius, this.carveScratch,
                          (cx, cy) => this.isCellRevealed(cx, cy));
    for (let k = before; k < this.carveScratch.length; k++) {
      batch.append(this.carveScratch[k], strokeArc);
    }
    const carved = this.carveScratch.length - before;
    this.dimCarvedVisual();
    return carved;
  }

  /** Nhấc ngón -> đóng túi, xếp vào hàng chờ kênh Swipe. */
  closeStroke(): void {
    const b = this.openBatch;
    this.openBatch = null;
    if (b === null) return;
    if (b.isEmpty) { this.batchPool.push(b); return; }
    b.closeAndOrder(this.cfg.slabCells);
    if (this.closedBatches.length >= MAX_QUEUED_BATCHES) this.queueOverflowCount++;
    // KHÔNG thả túi dù quá tải: thả = cell Held không ai tan = MẤT CÁT (nguồn ghi rõ sau khi gỡ legacy wave).
    this.closedBatches.push(b);
  }

  // ======================================================================== auto-swipe theo màu

  /** Gạt nốt mọi ô Solid của 1 màu. Trả số ô THỰC SỰ cào được. Túi auto BẮT BUỘC no-revert. */
  carveAllRemainingOfColor(colorId: number): number {
    const before = this.carveScratch.length;
    this.model.carveAllRemainingOfColor(colorId, this.carveScratch,
                                        (cx, cy) => this.isCellRevealed(cx, cy));
    const carved = this.carveScratch.length - before;
    if (carved === 0) return 0;

    const b = this.takeBatch();
    // Túi auto revert -> revertVersion tăng -> tầng trên re-arm auto-swipe -> cào lại đúng ô đó -> revert lại
    // = NHẤP NHÁY VÔ HẠN. Đây là cái bẫy ghi ở SwipeBatch.revertOnFinish.
    b.markNoRevert();
    for (let k = before; k < this.carveScratch.length; k++) b.append(this.carveScratch[k], 0);
    this.dimCarvedVisual();
    b.closeAndOrder(this.cfg.slabCells);
    this.autoBatches.push(b);
    return carved;
  }

  // ======================================================================== DẢI MỎNG TỰ TAN

  /**
   * Port 1:1 `PictureColliderBuilder.EnqueueThinStripBatch`. Tìm dải Solid DÍNH vào tập ô vừa tan mà BỀ DÀY
   * <= thinStripCells, cào chúng và xếp thành túi mới ở hàng chờ Thin để tan luôn. Trả số ô đã gom.
   *
   * VÌ SAO dải mỏng phải tan: bề dày < THÂN HẠT (2.34 ô) thì hạt hoặc xuyên qua (SweepBlocked quét ĐIỂM tâm)
   * hoặc đậu lên trên nằm lỳ. Knob `dilateCells` chữa vế xuyên nhưng làm vế kẹt TỆ HƠN (dải dày ảo ra 3 ô =
   * càng dễ đậu) => 2 vế ngược chiều trên cùng 1 knob => lever đúng nằm ở lớp CARVE, không phải solver.
   */
  enqueueThinStripBatch(convertedCells: readonly number[]): number {
    const thin = this.cfg.thinStripCells;
    const cap = this.cfg.thinStripMaxCells;
    if (thin <= 0 || cap <= 0 || convertedCells.length === 0) return 0;

    const w = this.model.width;
    this.thinSeeds.length = 0;
    this.thinDepth.length = 0;
    this.thinSeen.clear();
    this.thinBfs.length = 0;
    this.thinBfsHead = 0;

    // HẠT GIỐNG = ô Solid-mỏng kề (8 hướng) một ô nào đó của túi vừa tan. Túi đã tan nên ô của nó là Empty ->
    // viền của nó chính là mặt cắt mới sinh ra, đúng nơi dải mỏng xuất hiện.
    for (let k = 0; k < convertedCells.length; k++) {
      const i = convertedCells[k];
      if (i < 0) continue;
      const bx = i % w, by = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          this.tryPushThin(bx + dx, by + dy, 0, w, thin, cap);
        }
    }

    // FLOOD theo dải liên thông: dải sót thường là SỢI DÀI, chỉ tan khúc sát vệt cào thì lần sau vẫn kẹt.
    // Hàng đợi mang INDEX trong thinSeeds (không phải cell index) -> tra được độ sâu của ô đang mở rộng.
    while (this.thinBfsHead < this.thinBfs.length && this.thinSeeds.length < cap) {
      const idx = this.thinBfs[this.thinBfsHead++];
      const i = this.thinSeeds[idx];
      const depth = this.thinDepth[idx];
      const cx = i % w, cy = (i / w) | 0;
      for (let d = 0; d < 4; d++) this.tryPushThin(cx + NX4[d], cy + NY4[d], depth + 1, w, thin, cap);
    }

    // CÀO + nạp túi. arc = độ sâu BFS -> closeAndOrder chia lát theo khoảng cách tới vệt vừa cào = dải tan LAN RA
    // từ chỗ ngón tay vừa đi qua.
    const batch = this.takeBatch();
    batch.markNoRevert();   // BẮT BUỘC: revert -> lượt sau lại thấy mỏng -> cào lại = nhấp nháy vô hạn
    let carved = 0;
    for (let k = 0; k < this.thinSeeds.length; k++) {
      const i = this.thinSeeds[k];
      const px = i % w, py = (i / w) | 0;
      if (!this.model.carveCell(px, py)) continue;   // băng / không còn Solid -> bỏ
      this.carveScratch.push(i);
      batch.append(i, this.thinDepth[k]);
      carved++;
    }
    if (carved === 0) { this.batchPool.push(batch); return 0; }

    this.dimCarvedVisual();                          // cùng path visual với carveAt (alpha 0.8)
    batch.closeAndOrder(this.cfg.slabCells);
    this.thinBatches.push(batch);                    // hàng chờ RIÊNG -> tan song song, không xếp sau túi swipe
    return carved;
  }

  /**
   * Ứng viên dải mỏng: trong biên, đang SOLID, chưa gom, và BỀ DÀY <= thin.
   * Ô băng KHÔNG vào (carveCell sẽ bỏ qua, gom vào chỉ tổ đẻ ô rỗng trong túi).
   */
  private tryPushThin(px: number, py: number, depth: number, w: number, thin: number, cap: number): void {
    if (this.thinSeeds.length >= cap) return;
    if (px < 0 || py < 0 || px >= w || py >= this.model.height) return;
    if (this.model.stateAt(px, py) !== PictureCellState.Solid) return;
    if (this.model.isFrozen(px, py)) return;
    if (!this.isCellRevealed(px, py)) return;        // trong dải chặn / cột đang tụt -> không cào được
    const i = py * w + px;
    if (this.thinSeen.has(i)) return;
    this.thinSeen.add(i);
    if (!this.isThinAt(px, py, thin)) return;
    this.thinSeeds.push(i);
    this.thinDepth.push(depth);
    this.thinBfs.push(this.thinSeeds.length - 1);
  }

  /**
   * BỀ DÀY tại (px,py) = min qua 4 TRỤC của (run âm + run dương + 1). Thân tranh = mọi ô còn SOLID (băng tính là
   * thân — nó là vật cản thật của hạt). Quét kẹp ở thin+1 mỗi phía -> chi phí O(8·thin), bounded.
   */
  private isThinAt(px: number, py: number, thin: number): boolean {
    for (let a = 0; a < 4; a++) {
      const ax = AXIS_X[a], ay = AXIS_Y[a];
      const run = 1 + this.solidRun(px, py, ax, ay, thin + 1) + this.solidRun(px, py, -ax, -ay, thin + 1);
      if (run <= thin) return true;
    }
    return false;
  }

  /** Số ô SOLID liên tiếp từ (px,py) theo hướng (sx,sy), KHÔNG kể ô gốc, dừng ở cap. */
  private solidRun(px: number, py: number, sx: number, sy: number, cap: number): number {
    for (let d = 1; d <= cap; d++) {
      if (this.model.stateAt(px + sx * d, py + sy * d) !== PictureCellState.Solid) return d - 1;
    }
    return cap;
  }
}

/** Buffer TakenCell tái dùng — front gọi tryTakeNext trong vòng drain, không được cấp phát ở đó. */
export function takenCell(): TakenCell {
  return { px: 0, py: 0, cellIndex: 0 };
}
