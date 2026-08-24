// WAVEFRONT convert tranh -> hạt — port của Flow/Carve/ConversionFront.cs (881 LOC).
//
// Mỗi ĐỢT (waveInterval) lấy cell kế tiếp theo THỨ TỰ TÚI (lát dọc đường vuốt, trong lát py cao trước) -> gom
// CONNECTED-COMPONENT cùng màu ≤ maxGroupSize -> centroid -> 1 SandEmitRequest -> convertCell từng cell.
//
// ============ CÁI GÌ KHÔNG PORT VÀ VÌ SAO ============
//  · Toàn bộ API BOOSTER (CollectRadiusRegion · BlastConvertCells · EmitBlastGrain · BlastEmitVelocity ·
//    BeginBlastRun/EndBlastRun · BlastGhostReleaseY): manifest xếp cụm booster vào giỏ `drop`.
//  · Legacy wave: nguồn đã tự gỡ 2026-07-30 (túi là đường convert duy nhất).
//  · Diag/profiler marker + log.
//
// ============ SEAM ============
// Nguồn đọc `PictureColliderBuilder` (MonoBehaviour 1264 LOC) cho 3 nhóm việc rất khác nhau: (a) map picture-space
// -> world, (b) xoá/khôi phục pixel HIỂN THỊ, (c) hàng chờ túi + luật reveal của scroll. Chỉ (a) và (c) là logic;
// (b) là việc của renderer. Ở đây cả ba đi qua interface `PictureHost` để phần Cocos cài — solver KHÔNG biết Cocos.
//
// ============ LỆCH CÓ CHỦ Ý ============
//  · `UnityEngine.Random` -> hàm `rng()` tiêm được (mặc định Math.random). Nguồn chỉ dùng random cho JITTER
//    (cone vận tốc emit + de-coincidence khi spawn fallback) nên phân phối khớp là đủ; KHÔNG cần cùng dãy số.
//    Đây là chỗ thứ hai (sau escape-guard) mà parity P6 phải đo bằng số liệu hành vi.

import { PictureCarveModel, PictureCellState } from './carveModel';
import { SwipeBatch, SwipeBatchChannel, AutoSwipeGhostMode, type TakenCell } from './swipeBatch';
import { v2, type V2 } from './sdfWalls';

/** 1 lệnh emit hạt gửi xuống backend cát. `ghostReleaseY` = NaN nghĩa là KHÔNG ghost. */
export interface SandEmitRequest {
  colorId: number;
  carriedCount: number;
  x: number; y: number;
  vx: number; vy: number;
  ghostReleaseY: number;
}

/** Knob đọc từ ir/tuning.json (GrainTuningConfig). Tên giữ theo nguồn để tra ngược được. */
export interface ConversionFrontConfig {
  waveInterval: number;             // giây giữa 2 đợt
  maxGroupSize: number;             // trần số cell 1 nhóm BFS
  swipeBatchDrainSpeed: number;     // ô/giây — ngân sách drain
  emitSpeed: number;
  emitConeHalfAngleDeg: number;
  grainParticleRadius: number;
  grainSpawnClearanceRings: number;
  autoSwipeGhostMode: AutoSwipeGhostMode;
  /** Số pixel Solid CÒN LẠI CỦA MỘT MÀU mà dưới ngưỡng thì tự gạt nốt màu đó. 0 = TẮT. */
  autoSwipeRemainingThreshold: number;
}

/**
 * Seam sang tầng Cocos. Tên giữ theo nguồn.
 *
 * ⚠ `pictureCellToWorld` nhận toạ độ cell THỰC (float) chứ không chỉ int: clearance search truyền tâm occ-cell
 * (x.5) và ghost release truyền `bottomRow + 1`.
 */
export interface PictureHost {
  pictureCellToWorld(cx: number, cy: number, out: V2): V2;
  /** Cỡ 1 pixel tranh theo world. <= 1e-6 = map suy biến. */
  picturePixelWorldSize(): number;
  /** Hướng "xuôi trọng lực" của tranh trong world (py tăng). */
  pictureDownWorldDir(out: V2): V2;
  spawnClearanceMargin: number;

  eraseVisualCell(px: number, py: number): void;
  restoreVisualCell(px: number, py: number, orderT: number): void;

  /** Level SCROLL: ô chưa lộ thì không cào/không nổ được. Level không scroll -> luôn true. */
  isCellRevealed(px: number, py: number): boolean;
  /** Counter ĐƠN ĐIỆU của host, tăng khi tranh lộ thêm hàng -> front re-arm auto-swipe. */
  readonly revealVersion: number;

  readonly hasOpenBatch: boolean;
  readonly hasClosedBatch: boolean;
  readonly hasThinBatch: boolean;
  readonly hasAutoBatch: boolean;
  tryDequeueClosedBatch(): SwipeBatch | null;
  tryDequeueThinBatch(): SwipeBatch | null;
  tryDequeueAutoBatch(): SwipeBatch | null;
  releaseBatch(batch: SwipeBatch): void;
  enqueueRetryBatch(cells: readonly number[], channel: SwipeBatchChannel): void;
  /** Quét dải Solid mỏng hơn thân hạt dính vào tập ô vừa tan -> cào + nạp túi kênh Thin. Trả số pixel gom. */
  enqueueThinStripBatch(convertedCells: readonly number[]): number;
  /** Gạt nốt mọi ô Solid của 1 màu (đã lọc theo luật reveal). Trả số ô thực sự cào được. */
  carveAllRemainingOfColor(colorId: number): number;
}

export interface SandFlowBackend {
  acceptSand(req: SandEmitRequest): void;
}

const NX = [1, -1, 0, 0];
const NY = [0, 0, 1, -1];

export class ConversionFront {
  private readonly config: ConversionFrontConfig;
  private readonly host: PictureHost;
  private readonly backend: SandFlowBackend;
  private readonly rng: () => number;

  private running = false;

  /**
   * PAUSE emit (nguồn: booster nam châm). Booster đã drop -> luôn false ở ad này, nhưng seam giữ nguyên vì nó
   * đổi hành vi thật: auto-swipe VẪN chạy khi pause (carve Solid->Held an toàn), chỉ convert/emit dừng.
   */
  paused = false;

  private waveAccum = 0;
  private readonly autoSwipedColors = new Set<number>();
  private revertVersionSeen = 0;
  private revealVersionSeen = 0;

  // 3 KÊNH, 3 túi, 3 ngân sách RIÊNG (cùng tốc độ) -> chạy song song, không kênh nào đợi kênh kia.
  private activeBatch: SwipeBatch | null = null;
  private batchDrainAccum = 0;
  private activeThinBatch: SwipeBatch | null = null;
  private thinDrainAccum = 0;
  private activeAutoBatch: SwipeBatch | null = null;
  private autoDrainAccum = 0;

  // Hàng Solid THẤP NHẤT, chốt 1 LẦN mỗi lát drain kênh AUTO = mốc nhả ghost cho mọi nhóm trong lát.
  // ⚠ Hoist vì bottomSolidRowIndex -> ensureEscapeOpt -> rebuild O(W·H) khi trường bẩn, mà chính convertCell trong
  // vòng drain làm bẩn nó MỖI Ô -> hỏi per-nhóm = mỗi nhóm 1 lượt quét cả lưới.
  // AN TOÀN: tranh chỉ TAN chứ không mọc -> hàng Solid thấp nhất chỉ CAO dần -> mốc chốt sớm luôn <= mốc đúng ->
  // hạt giữ ghost LÂU hơn cần, KHÔNG BAO GIỜ nhả sớm vào giữa thân tranh.
  private autoGhostBottomRow = -1;

  // Buffer tái dùng — vòng update KHÔNG cấp phát.
  private readonly group: number[] = [];
  private readonly visited = new Set<number>();
  private readonly bfs: number[] = [];
  private readonly sliceConverted: number[] = [];
  /** Occ-cell đã CẤP làm điểm spawn trong ĐỢT hiện tại — chống 2 nhóm cùng wave chọn TRÙNG 1 cell hở
   *  ("nổ chồng hạt": 2 hạt spawn cùng điểm -> depenetration văng mạnh). Key = oy*2^32+ox. Clear mỗi wave. */
  private readonly usedSpawnCells = new Set<number>();
  private readonly taken: TakenCell = { px: -1, py: -1, cellIndex: -1 };
  private readonly losOriginPix: V2 = v2();
  private readonly tmpWorld: V2 = v2();
  private readonly tmpDown: V2 = v2();

  // Diag: tỉ lệ spawn phải rơi về nhánh fallback (LOS bác hết ring). Cao = hố hẹp hơn thân hạt.
  spawnFallbackCount = 0;
  spawnTotalCount = 0;
  spawnGhostCount = 0;

  constructor(model: PictureCarveModel, host: PictureHost, backend: SandFlowBackend,
              config: ConversionFrontConfig, rng: () => number = Math.random) {
    this.model = model;
    this.host = host;
    this.backend = backend;
    this.config = config;
    this.rng = rng;
  }

  private model: PictureCarveModel;

  /** Bật front sau khi model + host đã build. Reset đồng hồ đợt + guard auto-swipe. */
  begin(): void {
    this.autoSwipedColors.clear();
    this.waveAccum = 0;
    this.activeBatch = null;
    this.activeThinBatch = null;
    this.activeAutoBatch = null;
    this.batchDrainAccum = 0;
    this.thinDrainAccum = 0;
    this.autoDrainAccum = 0;
    this.autoGhostBottomRow = -1;
    this.spawnFallbackCount = 0;
    this.spawnTotalCount = 0;
    this.spawnGhostCount = 0;
    this.revertVersionSeen = 0;   // model mới -> revertVersion về 0
    // revealVersion KHÔNG reset theo level (counter đơn điệu của host) -> đồng bộ mốc hiện tại, đừng gán 0.
    this.revealVersionSeen = this.host.revealVersion;
    this.paused = false;
    this.running = true;
  }

  /** Tắt front (teardown level). Thả cả 3 túi: chúng giữ index picture-local của model CŨ. */
  stopFront(): void {
    this.running = false;
    this.paused = false;
    this.releaseBatchSlot('batch');
    this.releaseBatchSlot('thin');
    this.releaseBatchSlot('auto');
    this.autoGhostBottomRow = -1;
  }

  get isRunning(): boolean { return this.running; }

  // ==================================================================== tick

  /** 1 nhịp. `dt` = giây trôi qua. */
  tick(dt: number): void {
    if (!this.running) return;
    const model = this.model;

    // RE-ARM auto-swipe khi tranh vừa MỌC LẠI Solid do revert: guard 1-lần/level của bản cũ dựa trên tiền đề
    // "Solid chỉ giảm". Có revert thì tiền đề đó SAI -> auto-swipe đã cháy sẽ không bao giờ dọn phần mọc lại =
    // level không thắng được. So mốc revertVersion (chỉ tăng) là đủ, không cần theo dõi từng ô.
    if (model.revertVersion !== this.revertVersionSeen) {
      this.revertVersionSeen = model.revertVersion;
      this.autoSwipedColors.clear();
    }
    // RE-ARM khi tranh vừa LỘ THÊM ô cào được (level SCROLL). Cùng dạng lập luận: guard 1-lần/màu dựa trên tiền đề
    // "gạt 1 phát là hết màu đó", sai khi có ô bị chặn vì chưa lộ.
    if (this.host.revealVersion !== this.revealVersionSeen) {
      this.revealVersionSeen = this.host.revealVersion;
      this.autoSwipedColors.clear();
    }

    this.tickAutoSwipe();

    if (this.paused) return;   // pause EMIT — auto-swipe ở trên KHÔNG bị chặn

    // ĐỒNG HỒ DRAIN theo TỐC ĐỘ (ô/giây), cộng MỖI FRAME chứ không mỗi đợt -> túi to tan lâu hơn túi nhỏ đúng tỉ
    // lệ, và tốc độ không đổi khi waveInterval đổi. Không có việc để tan -> KHÔNG cộng, tránh dồn ngân sách trong
    // lúc rảnh rồi xả 1 phát khi túi mới đóng.
    // ⚠ SWIPE/THIN: KHÔNG cộng khi còn túi MỞ — lúc đó gate dưới chặn drain, cộng tiếp = dồn rồi xả 1 phát lúc
    //   nhả tay (đúng cái spike mà túi sinh ra để tránh).
    // ⚠ AUTO: cộng KỂ CẢ khi tay còn xuống — luồng RIÊNG, không thuộc nhịp vuốt nên chẳng có spike nào để hãm.
    const drainStep = Math.max(0, this.config.swipeBatchDrainSpeed) * dt;
    if (this.activeAutoBatch !== null || this.host.hasAutoBatch) this.autoDrainAccum += drainStep;
    if (!this.host.hasOpenBatch) {
      if (this.activeBatch !== null || this.host.hasClosedBatch) this.batchDrainAccum += drainStep;
      if (this.activeThinBatch !== null || this.host.hasThinBatch) this.thinDrainAccum += drainStep;
    }

    this.waveAccum += dt;
    if (this.waveAccum < this.config.waveInterval) return;
    this.waveAccum = 0;

    const cap = Math.max(1, this.config.maxGroupSize);
    this.usedSpawnCells.clear();   // mỗi wave cấp lại từ đầu (chỉ cần chống trùng GIỮA các nhóm cùng wave)

    // Đồng bộ escape LẠC QUAN (gate tan của túi) ĐÚNG 1 lần/wave. PHẢI ở NGOÀI vòng drain: convertCell bẩn cờ mỗi
    // ô -> để lọt vào trong = quét lại O(W·H) mỗi ô.
    // ⚠ KHÔNG gọi beginConvertWave: sau khi gỡ legacy wave, front không đọc trường escape chặt nữa -> quét nó mỗi
    // đợt là O(W·H) thuần lỗ.
    model.syncEscapeOptimistic();

    // GATE TÚI: còn túi ĐANG MỞ -> kênh SWIPE + THIN không convert, chờ túi đóng (mở gate ra là bùng 1 đợt to =
    // đúng thứ túi định tránh). ⚠ Gate theo TÚI MỞ, KHÔNG theo "ngón tay còn xuống": túi đóng giữa nét (brush ra
    // khỏi tranh) PHẢI tan ngay dù tay còn giữ.
    // ⚠ Kênh AUTO NGOÀI gate này: tập ô của nó rời hẳn tập ô của nét đang vuốt (auto chỉ carve Solid, ô trong túi
    // người chơi đã Held) nên chờ nhau chỉ tổ treo việc tới lúc nhả tay.
    if (!this.host.hasOpenBatch) {
      this.drainChannel(cap, 'batch', SwipeBatchChannel.Swipe);
      this.drainChannel(cap, 'thin', SwipeBatchChannel.Thin);
    }
    this.drainChannel(cap, 'auto', SwipeBatchChannel.Auto);
  }

  /**
   * AUTO-SWIPE cuối màn: còn ÍT pixel chưa swipe -> gạt nốt 1 phát.
   * Chạy KỂ CẢ khi paused (carve Solid->Held an toàn, convert đợi unpause) nên đặt TRƯỚC pause-gate, và NGOÀI
   * wave-gate -> phản ứng ngay.
   * ⚠ Gạt TỐI ĐA 1 MÀU/frame: nhiều màu cùng tụt dưới ngưỡng mà nổ hết 1 lần = đẻ N túi cùng lúc, chạm trần hàng
   * chờ. Auto-swipe chạy mỗi frame nên các màu còn lại đi ở frame kế, không mất gì.
   * ⚠ Luật PER-MÀU BAO luôn luật tổng cũ: tổng <= N thì MỌI màu đều <= N -> vẫn gạt sạch tranh như trước.
   */
  private tickAutoSwipe(): void {
    const threshold = this.config.autoSwipeRemainingThreshold;
    if (threshold <= 0) return;
    const colors = this.model.colorsPresent;
    for (let k = 0; k < colors.length; k++) {
      const colorId = colors[k];
      if (this.autoSwipedColors.has(colorId)) continue;
      const solid = this.model.solidCountOfColor(colorId);
      if (solid <= 0 || solid > threshold) continue;
      const carved = this.host.carveAllRemainingOfColor(colorId);
      // Đánh dấu KỂ CẢ khi gạt được 0 ô (level scroll: cả màu còn nằm trên cửa sổ) — không thì mỗi frame quét lại
      // O(W·H) vô ích. Re-arm đã có revealVersion lo.
      this.autoSwipedColors.add(colorId);
      if (carved <= 0) continue;   // chưa gạt được gì -> nhường lượt frame này cho màu khác
      break;
    }
  }

  // ==================================================================== drain túi

  private slotBatch(slot: 'batch' | 'thin' | 'auto'): SwipeBatch | null {
    return slot === 'batch' ? this.activeBatch : slot === 'thin' ? this.activeThinBatch : this.activeAutoBatch;
  }

  private setSlotBatch(slot: 'batch' | 'thin' | 'auto', b: SwipeBatch | null): void {
    if (slot === 'batch') this.activeBatch = b;
    else if (slot === 'thin') this.activeThinBatch = b;
    else this.activeAutoBatch = b;
  }

  private slotAccum(slot: 'batch' | 'thin' | 'auto'): number {
    return slot === 'batch' ? this.batchDrainAccum : slot === 'thin' ? this.thinDrainAccum : this.autoDrainAccum;
  }

  private setSlotAccum(slot: 'batch' | 'thin' | 'auto', v: number): void {
    if (slot === 'batch') this.batchDrainAccum = v;
    else if (slot === 'thin') this.thinDrainAccum = v;
    else this.autoDrainAccum = v;
  }

  /**
   * Tan MỘT KÊNH túi theo thứ tự đã sắp.
   *
   * NGÂN SÁCH: accum cộng drainSpeed × dt mỗi frame; đợt này tiêu phần NGUYÊN, giữ lại phần thập phân -> tốc độ
   * tan ổn định theo giây, túi dài tan lâu hơn túi ngắn đúng tỉ lệ.
   *
   * ⚠ Ô tới lượt mà không tan được -> vào revertBook rồi ĐI TIẾP, con trỏ KHÔNG lùi: tôn trọng thứ tự vuốt như
   * ĐIỀU KIỆN sẽ làm túi đứng im.
   * ⚠ Ô bị BỎ QUA cũng TRỪ ngân sách. Bản đầu của nguồn chỉ đếm ô convert được -> ô chưa thoát tốn 0 -> cả túi bị
   * chén sạch trong ĐÚNG 1 đợt, ngân sách drain không có tác dụng nào.
   * ⚠ Trừ ngân sách theo SỐ Ô THẬT SỰ TAN, không phải 1/seed: 1 seed kéo theo cả nhóm ≤maxGroupSize ô, tính 1 thì
   * drainSpeed thành "seed/giây" và tốc độ tan nhảy theo maxGroupSize (knob khác hẳn).
   */
  private drainChannel(cap: number, slot: 'batch' | 'thin' | 'auto', channel: SwipeBatchChannel): void {
    let active = this.slotBatch(slot);
    if (active === null) {
      active = channel === SwipeBatchChannel.Auto ? this.host.tryDequeueAutoBatch()
             : channel === SwipeBatchChannel.Thin ? this.host.tryDequeueThinBatch()
             : this.host.tryDequeueClosedBatch();
      if (active === null) return;
      this.setSlotBatch(slot, active);
    }

    const allowance = Math.floor(this.slotAccum(slot));
    if (allowance < 1) return;                    // chưa đủ 1 ô -> frame sau cộng tiếp
    this.setSlotAccum(slot, this.slotAccum(slot) - allowance);

    // GHOST — CHỈ kênh AUTO. Chốt mốc nhả 1 lần cho cả lát.
    const ghostMode = channel === SwipeBatchChannel.Auto ? this.config.autoSwipeGhostMode : AutoSwipeGhostMode.Off;
    this.autoGhostBottomRow = -1;
    if (ghostMode !== AutoSwipeGhostMode.Off) {
      const bottomRow = this.model.bottomSolidRowIndex(0, this.model.width - 1);
      this.autoGhostBottomRow = bottomRow >= 0 ? bottomRow : this.model.height - 1;   // tranh sạch trơn -> mép đáy
    }

    let spent = 0;
    this.sliceConverted.length = 0;
    while (spent < allowance && active.tryTakeNext(this.taken)) {
      const { px, py, cellIndex } = this.taken;
      if (!this.model.canConvertNowOptimistic(px, py)) {
        spent++;
        // Không tan được: đã tan rồi (nhóm BFS bên cạnh ăn kèm), hoặc KHÔNG có đường xuống kể cả khi coi mọi ô vừa
        // cào là đã mở = cào hụt thật -> ứng viên REVERT về Solid khi túi tan xong.
        if (this.model.stateAt(px, py) === PictureCellState.Held) active.markRevertCandidate(cellIndex);
        continue;
      }
      spent += Math.max(1, this.convertGroupAt(px, py, cap, ghostMode));
      this.sliceConverted.push(cellIndex);
    }

    // DẢI MỎNG NGAY TRONG LÁT: seed = ô VỪA tan ở lát này -> dải mỏng lộ ra được cào + nạp túi kênh thin trong cùng
    // frame, tan song song thay vì đợi cả túi swipe xong.
    if (this.sliceConverted.length > 0) this.host.enqueueThinStripBatch(this.sliceConverted);

    if (active.drained) this.finishBatch(slot, channel);
  }

  /**
   * Túi tan xong -> REVERT mọi ô đã bỏ cuộc mà VẪN còn Held: Held->Solid + tô sáng lại.
   * TÚI RETRY (auto-swipe): ô bỏ cuộc KHÔNG revert mà xếp lại thành túi mới. Revert ở đây sẽ bơm revertVersion ->
   * re-arm auto-swipe -> carve lại đúng ô đó -> revert lại = NHẤP NHÁY VÔ HẠN.
   */
  private finishBatch(slot: 'batch' | 'thin' | 'auto', channel: SwipeBatchChannel): void {
    const batch = this.slotBatch(slot);
    if (batch === null) return;
    // LƯỚI AN TOÀN dải mỏng: quét TRƯỚC khi thả túi (release đưa túi về pool -> reset xoá tập ô). Phần LỚN dải đã
    // được gom theo từng lát; lượt này bắt nốt ô chỉ mỏng đi nhờ nhóm BFS tan ở chỗ khác.
    if (batch.cellsView.length > 0) this.host.enqueueThinStripBatch(batch.cellsView);

    const book = batch.revertBook;
    if (!batch.revertOnFinish) {
      // Retry ở lại ĐÚNG kênh vừa đẻ ra nó: ô bỏ cuộc của auto-swipe chính là ô ở góc/khe hẹp — đẩy sang hàng chờ
      // swipe là mất luôn quyền ghost đúng ở tập cần nó nhất.
      if (book.length > 0) this.host.enqueueRetryBatch(book, channel);   // đọc book TRƯỚC khi thả túi về pool
      this.releaseBatchSlot(slot);
      return;
    }
    const w = Math.max(1, this.model.width);
    for (let k = 0; k < book.length; k++) {
      const i = book[k];
      const px = i % w, py = (i / w) | 0;
      if (!this.model.revertCell(px, py)) continue;   // ô đã tan bằng đường khác giữa chừng -> bỏ qua
      // orderT: 0 = ô ĐỊNH tan sớm nhất trong túi -> style sóng sáng chạy NGƯỢC lại phía ngón tay vừa đi qua.
      const orderT = book.length > 1 ? k / (book.length - 1) : 0;
      this.host.restoreVisualCell(px, py, orderT);
    }
    this.releaseBatchSlot(slot);
  }

  // Thả túi của MỘT kênh về pool + ZERO ngân sách kênh đó (không dồn ngân sách trong lúc kênh rảnh).
  private releaseBatchSlot(slot: 'batch' | 'thin' | 'auto'): void {
    const batch = this.slotBatch(slot);
    if (batch === null) return;
    this.host.releaseBatch(batch);
    this.setSlotBatch(slot, null);
    this.setSlotAccum(slot, 0);
  }

  // ==================================================================== convert 1 nhóm

  /**
   * Gom connected-component CÙNG MÀU quanh seed (BFS 4-neighbor, ≤cap) -> emit 1 hạt tại điểm spawn hở với vận tốc
   * hướng-thoát -> convertCell từng cell theo THỨ TỰ BFS. Trả SỐ CELL thật sự convert.
   *
   * ⚠ Luôn `requireEscape = false`: điều kiện tan đã gate Ở TRÊN bằng luật LẠC QUAN.
   * ⚠ carriedCount = SỐ CELL THẬT SỰ convert, KHÔNG phải group.length: BFS không đảm bảo thứ tự bottom-up + nhóm
   *   cắt ở maxGroupSize -> vài cell chưa eligible -> convertCell trả false (đứng Held, chờ wave sau). Đếm
   *   group.length = thổi phồng carried: wave sau convert lại credit LẦN 2 -> Σcarried > Σpixel tranh -> jar
   *   (capacity == pixel) đầy sớm bằng ít grain hơn, grain dư nằm lại trên belt.
   * ⚠ EMIT SAU convert: nhóm đang HELD nghĩa là occupancy còn CHẶN -> emit trước convert = hạt sinh BÊN TRONG vùng
   *   tranh, occupancy đẩy nó trồi lên (đọng chuỗi dọc mép rãnh, không rơi theo gravity).
   */
  private convertGroupAt(px: number, py: number, cap: number, ghostMode: AutoSwipeGhostMode): number {
    const model = this.model;
    const w = model.width;
    const seedColor = model.colorAt(px, py);
    this.collectGroup(px, py, seedColor, cap);
    if (this.group.length === 0) {
      model.convertCell(px, py, false);   // an toàn: bỏ seed lạ khỏi frontier (chống loop), không emit
      return 0;
    }

    // Centroid world (trung bình tâm cell) + centroid pixel-space (cho clearance search).
    let sumX = 0, sumY = 0, sumPixX = 0, sumPixY = 0;
    for (let k = 0; k < this.group.length; k++) {
      const i = this.group[k];
      const cx = i % w, cy = (i / w) | 0;
      this.host.pictureCellToWorld(cx, cy, this.tmpWorld);
      sumX += this.tmpWorld.x; sumY += this.tmpWorld.y;
      sumPixX += cx; sumPixY += cy;
    }
    const n = this.group.length;
    const centroidX = sumX / n, centroidY = sumY / n;
    const centroidPixX = sumPixX / n, centroidPixY = sumPixY / n;

    const vel = this.emitVelocity();

    // anchorPix = ô THẬT SỰ convert (=> Empty) GẦN centroid nhất. Hai vai: gốc line-of-sight, và điểm spawn cuối
    // cùng nếu LOS fail hết. KHÔNG dùng centroid thô: nhóm LÕM -> centroid có thể rơi vào pixel còn Solid/Held.
    let convertedCount = 0;
    let bestD2 = Infinity;
    let anchorPixX = centroidPixX, anchorPixY = centroidPixY;
    for (let k = 0; k < this.group.length; k++) {
      const i = this.group[k];
      const cx = i % w, cy = (i / w) | 0;
      if (model.convertCell(cx, cy, false)) {
        convertedCount++;
        this.host.eraseVisualCell(cx, cy);   // tranh tan dần theo wavefront
        const ddx = cx - centroidPixX, ddy = cy - centroidPixY;
        const d2 = ddx * ddx + ddy * ddy;
        if (d2 < bestD2) { bestD2 = d2; anchorPixX = cx; anchorPixY = cy; }
      }
    }
    if (convertedCount === 0) return 0;

    const spawn = this.findClearSpawnPos(centroidPixX, centroidPixY, centroidX, centroidY, anchorPixX, anchorPixY);
    // GHOST (kênh AUTO): hạt do TỰ TAN được XUYÊN occupancy TRANH (tường khung / belt / cửa VẪN chặn) tới khi rơi
    // thấp hơn hàng Solid cuối.
    // ⚠ THÊM LỰC ĐẨY KHÔNG PHẢI LEVER: vận tốc đâm vào ô occupied bị triệt ở cả J1/J3b/J4 -> hạt không thiếu năng
    //   lượng, nó bị chặn HÌNH HỌC. Đừng đổi sang tăng emitSpeed.
    const wantGhost = ghostMode === AutoSwipeGhostMode.Always
                   || (ghostMode === AutoSwipeGhostMode.TrappedOnly && this.lastSpawnTrapped);
    let ghostReleaseY = NaN;
    if (wantGhost) {
      this.spawnGhostCount++;
      ghostReleaseY = this.ghostReleaseYAtRow(anchorPixX, this.autoGhostBottomRow);
    }
    this.backend.acceptSand({
      colorId: seedColor, carriedCount: convertedCount,
      x: spawn.x, y: spawn.y, vx: vel.x, vy: vel.y, ghostReleaseY,
    });
    return convertedCount;
  }

  /** BFS 4-neighbor gom cell HELD cùng màu quanh seed (≤cap). Điền `group` theo THỨ TỰ BFS. */
  private collectGroup(px: number, py: number, seedColor: number, cap: number): void {
    const model = this.model;
    const w = model.width, h = model.height;
    this.group.length = 0;
    this.visited.clear();
    this.bfs.length = 0;

    const seed = py * w + px;
    this.bfs.push(seed);
    this.visited.add(seed);
    let head = 0;
    while (head < this.bfs.length) {
      const i = this.bfs[head++];
      const cx = i % w, cy = (i / w) | 0;
      if (model.stateAt(cx, cy) !== PictureCellState.Held || model.colorAt(cx, cy) !== seedColor) continue;

      this.group.push(i);
      if (this.group.length >= cap) break;

      for (let d = 0; d < 4; d++) {
        const nx = cx + NX[d], ny = cy + NY[d];
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const ni = ny * w + nx;
        if (this.visited.has(ni)) continue;
        if (model.stateAt(nx, ny) !== PictureCellState.Held || model.colorAt(nx, ny) !== seedColor) continue;
        this.visited.add(ni);
        this.bfs.push(ni);
      }
    }
  }

  // Vận tốc emit = CONE quanh hướng THOÁT: rotate(down, ±emitConeHalfAngleDeg)·emitSpeed -> cụm hạt tản XUỐNG +
  // 2 BÊN, KHÔNG BAO GIỜ ngược hướng down (fan cộng ngang cũ có thể ngóc lên khi fan > emitSpeed).
  private readonly velOut: V2 = v2();
  private emitVelocity(): V2 {
    this.host.pictureDownWorldDir(this.tmpDown);
    const half = this.config.emitConeHalfAngleDeg;
    const ang = (this.rng() * 2 - 1) * half * (Math.PI / 180);
    const cos = Math.cos(ang), sin = Math.sin(ang);
    const dx = this.tmpDown.x, dy = this.tmpDown.y;
    this.velOut.x = (dx * cos - dy * sin) * this.config.emitSpeed;
    this.velOut.y = (dx * sin + dy * cos) * this.config.emitSpeed;
    return this.velOut;
  }

  /** World-y mà hạt ghost NHẢ cờ = ngay DƯỚI hàng bottomRow (trừ 1 bán kính để hạt ra hẳn khỏi thân tranh). */
  private ghostReleaseYAtRow(anchorPx: number, bottomRow: number): number {
    this.host.pictureCellToWorld(anchorPx, bottomRow + 1, this.tmpWorld);
    return this.tmpWorld.y - this.config.grainParticleRadius;
  }

  // ==================================================================== clearance search

  /** true khi lần findClearSpawnPos gần nhất rơi về nhánh fallback = "không có chỗ hở cỡ thân hạt quanh đây". */
  lastSpawnTrapped = false;
  private readonly spawnOut: V2 = v2();

  /**
   * Tìm điểm spawn HỞ quanh centroid nhóm trên OCCUPANCY GRID: quét vòng ra ngoài ≤ grainSpawnClearanceRings
   * occ-cell, ƯU TIÊN hướng thoát (py tăng), chọn tâm occ-cell mà hình tròn (particleRadius·1.25 + margin) nằm
   * TRỌN vùng KHÔNG occupied VÀ có LINE-OF-SIGHT từ anchorPix tới ứng viên.
   *
   * ⚠ Thiếu vế LOS thì ứng viên "hở" có thể nằm BÊN KIA vách tranh -> hạt SINH RA ở phía ngoài = người chơi thấy
   *   y hệt "hạt xuyên tranh".
   * ⚠ LOS fail hết mọi ring -> spawn TẠI anchorPix (ô vừa convert nên chắc chắn Empty): sai lệch tệ nhất 1 ô.
   *   Nhánh teleport dọc py cũ ĐÃ GỠ — cả cột dưới còn đặc thì nó dừng NGOÀI đáy tranh = hạt sinh bên kia vách,
   *   xuyên 11-66 pixel.
   */
  private findClearSpawnPos(centroidPixX: number, centroidPixY: number, centroidWorldX: number,
                            centroidWorldY: number, anchorPixX: number, anchorPixY: number): V2 {
    this.lastSpawnTrapped = false;
    this.losOriginPix.x = anchorPixX;   // gốc LOS = ô vừa convert (Empty chắc chắn), KHÔNG phải centroid thô
    this.losOriginPix.y = anchorPixY;
    this.spawnTotalCount++;             // diag: đếm TRƯỚC mọi early-return để mẫu số khỏi lệch

    const model = this.model;
    const pixWorld = this.host.picturePixelWorldSize();
    if (pixWorld <= 1e-6) {             // map suy biến -> KHÔNG kết luận kẹt (không đo được gì)
      this.spawnOut.x = centroidWorldX; this.spawnOut.y = centroidWorldY;
      return this.spawnOut;
    }
    const occ = model.occCellPixels;
    // Bán kính cần hở: hạt + mép collider + 25% margin (world) -> đổi sang pixel tranh.
    const needPix = (this.config.grainParticleRadius * 1.25 + this.host.spawnClearanceMargin) / pixWorld;

    const cox = clampInt((centroidPixX / occ) | 0, 0, model.occWidth - 1);
    const coy = clampInt((centroidPixY / occ) | 0, 0, model.occHeight - 1);

    const maxRings = this.config.grainSpawnClearanceRings;
    for (let ring = 0; ring <= maxRings; ring++) {
      for (let dy = ring; dy >= -ring; dy--) {           // dy DƯƠNG trước = py tăng = hướng thoát/trọng lực
        if (Math.abs(dy) === ring) {
          for (let a = 0; a <= ring; a++) {              // |dx| nhỏ trước (sát centroid)
            if (this.tryClearCell(cox + a, coy + dy, needPix)) return this.spawnOut;
            if (a > 0 && this.tryClearCell(cox - a, coy + dy, needPix)) return this.spawnOut;
          }
        } else {                                         // 2 cạnh dọc của vòng
          if (this.tryClearCell(cox + ring, coy + dy, needPix)) return this.spawnOut;
          if (this.tryClearCell(cox - ring, coy + dy, needPix)) return this.spawnOut;
        }
      }
    }

    this.spawnFallbackCount++;
    this.lastSpawnTrapped = true;   // không có chỗ hở cỡ thân hạt -> hạt sinh ra bị vây (kênh AUTO bật ghost)
    // DE-COINCIDENCE: 2+ nhóm fail cùng wave -> anchor mỗi nhóm là cell RIÊNG (group disjoint) nên đã cách ≥1
    // pixel, nhưng giữ jitter nhỏ cho chắc: dist~0 làm bước accumulate contact bỏ qua cặp -> kẹt chồng hạt.
    this.host.pictureCellToWorld(anchorPixX, anchorPixY, this.tmpWorld);
    this.spawnOut.x = this.tmpWorld.x + (this.rng() * 0.8 - 0.4) * pixWorld;
    this.spawnOut.y = this.tmpWorld.y + (this.rng() * 0.8 - 0.4) * pixWorld;
    return this.spawnOut;
  }

  /**
   * Occ-cell (ox,oy) làm tâm spawn được không. Thành công -> ghi `spawnOut` + ĐÁNH DẤU cell đã dùng.
   *
   * ⚠ oy < 0 = PHÍA TRÊN ĐỈNH tranh (py=0 là đỉnh). Ứng viên ở đó qua được CẢ HAI cửa một cách rỗng tuếch —
   * isOccupied trả false vì ngoài mảng, LOS bỏ qua mọi sample ngoài biên = coi như thông — nên nó LUÔN thắng khi
   * ring quét tới nhánh dy âm, và hạt sinh ra trong khoảng không TRÊN đỉnh tranh rồi rơi xuống đậu lên đỉnh.
   * Nới biên vốn CHỈ nhằm cho ứng viên DƯỚI đáy (phễu) hợp lệ. Đừng nới lại cả 2 chiều.
   */
  private tryClearCell(ox: number, oy: number, needPix: number): boolean {
    const model = this.model;
    if (ox < 0 || ox >= model.occWidth) return false;
    if (oy < 0) return false;   // xem ⚠ trên
    const key = oy * 4294967296 + ox;
    if (this.usedSpawnCells.has(key)) return false;
    const occ = model.occCellPixels;
    const cx = ox * occ + (occ - 1) * 0.5;   // tâm occ-cell theo pixel-index
    const cy = oy * occ + (occ - 1) * 0.5;
    const x0 = Math.floor((cx - needPix) / occ), x1 = Math.floor((cx + needPix) / occ);
    const y0 = Math.floor((cy - needPix) / occ), y1 = Math.floor((cy + needPix) / occ);
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++)
        if (model.isOccupied(x, y)) return false;
    // LOS trên lưới FINE (lưới mà va chạm hạt THẬT dùng) — occupancy trên là lưới THÔ nên "hở" ở đây KHÔNG bảo đảm
    // cùng phía vách. KHÔNG mark usedSpawnCells khi fail: nhóm sau vẫn được thử ô này (nó có LOS khác).
    if (!this.hasLineOfSight(this.losOriginPix.x, this.losOriginPix.y, cx, cy)) return false;
    this.usedSpawnCells.add(key);
    this.host.pictureCellToWorld(cx, cy, this.tmpWorld);
    this.spawnOut.x = this.tmpWorld.x;
    this.spawnOut.y = this.tmpWorld.y;
    return true;
  }

  /**
   * Có đường thẳng THÔNG (không pixel Solid|Held chắn) từ (fromX,fromY) tới (toX,toY) trên lưới FINE?
   * Lấy mẫu 0.5 pixel/bước, BỎ 2 đầu mút (gốc là ô vừa convert = Empty; đích đã qua check clearance).
   * Ngoài biên tranh = THÔNG (phễu/khoảng trống ngoài tranh).
   */
  private hasLineOfSight(fromX: number, fromY: number, toX: number, toY: number): boolean {
    const model = this.model;
    const dx = toX - fromX, dy = toY - fromY;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-4) return true;
    const steps = Math.ceil(len * 2);
    let lastX = -2147483648, lastY = -2147483648;
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const qx = Math.floor(fromX + dx * t), qy = Math.floor(fromY + dy * t);
      if (qx === lastX && qy === lastY) continue;
      lastX = qx; lastY = qy;
      if (qx < 0 || qy < 0 || qx >= model.width || qy >= model.height) continue;
      if (model.stateAt(qx, qy) !== PictureCellState.Empty) return false;
    }
    return true;
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
