// TÚI cell của MỘT nét vuốt — port của Flow/Carve/SwipeBatch.cs (190 LOC).
//
// Gom cell vừa Solid->Held trong 1 nét rồi ĐÓNG (nhả tay / đủ số nhát không ăn thêm cell nào) -> tầng trên
// (ConversionFront) drain túi theo LÁT dọc ĐƯỜNG ĐI của ngón tay.
//
// THỨ TỰ DRAIN = (lát tăng theo QUÃNG ĐƯỜNG ngón tay, trong lát py CAO trước).
// ⚠ Mốc sắp xếp là ARC (quãng đường tích luỹ của nét lúc ô bị cào), KHÔNG phải phép chiếu lên 1 vector hướng duy
// nhất: nét cong / gấp khúc / chữ S đều bám đúng đường tay đi, còn 1-vector thì sai ngay khi nét đổi hướng.
// Trong cùng lát vẫn py CAO nhất trước để giữ cảm giác trọng lực.
//
// ⚠ Cell = index picture-local (py*width+px) của model ĐANG SỐNG. Teardown level PHẢI thả hết túi: index của
// model cũ áp lên model mới = trỏ sai ô.
// ⚠ Túi được POOL -> luôn đi qua reset() trước khi dùng lại.

/**
 * KÊNH drain — mỗi kênh có hàng chờ + ngân sách riêng nên chạy SONG SONG, không kênh nào đợi kênh kia.
 * · Swipe = nét của người chơi (gate theo túi đang mở).
 * · Auto  = auto-swipe cuối màn + túi RETRY của nó — LUỒNG RIÊNG: không bị gate bởi nét đang vuốt, và là kênh
 *           DUY NHẤT được phép bật cờ GHOST khi hạt sinh ra bị kẹt.
 * · Thin  = dải mỏng tự tan + túi RETRY của nó.
 */
export const SwipeBatchChannel = {
  Swipe: 0,
  Auto: 1,
  Thin: 2,
} as const;
export type SwipeBatchChannel = (typeof SwipeBatchChannel)[keyof typeof SwipeBatchChannel];

/**
 * Luật bật cờ GHOST (xuyên occupancy TRANH tới khi rơi qua hàng Solid cuối) cho hạt do kênh AUTO-SWIPE sinh ra.
 * · Off         = hạt tự tan chịu occupancy như hạt swipe.
 * · TrappedOnly = CHỈ khi không tìm nổi chỗ hở cỡ thân hạt (ca "kẹt góc hẹp").
 * · Always      = MỌI hạt tự tan đều rơi xuyên tranh.
 * Tường khung / belt / cửa VẪN chặn ở cả 3 mức.
 */
export const AutoSwipeGhostMode = {
  Off: 0,
  TrappedOnly: 1,
  Always: 2,
} as const;
export type AutoSwipeGhostMode = (typeof AutoSwipeGhostMode)[keyof typeof AutoSwipeGhostMode];

/** Kết quả tryTakeNext — object TÁI DÙNG ở scope caller, không cấp phát trong vòng drain. */
export interface TakenCell { px: number; py: number; cellIndex: number; }

export class SwipeBatch {
  // Lúc MỞ = thứ tự cào (có thể lẫn tombstone -1); sau closeAndOrder = thứ tự DRAIN, không tombstone.
  private readonly cells: number[] = [];
  // Quãng đường ngón tay (ô) tại lúc cell cùng slot bị cào — SONG SONG cells, luôn cùng độ dài.
  private readonly arcs: number[] = [];
  // cellIndex -> slot hiện hành. CHỈ có nghĩa khi túi đang MỞ (đóng xong clear để khỏi giữ rác).
  private readonly slotOf = new Map<number, number>();
  // Cell tới lượt mà KHÔNG tan được (kể cả theo luật lạc quan) -> revert về Solid khi drain xong. Ghi theo ĐÚNG
  // thứ tự drain -> duyệt ngược danh sách này là ra sóng chạy ngược hướng vuốt.
  private readonly revertBookList: number[] = [];

  private drainCursor = 0;
  private liveCount = 0;      // số cell THẬT (đã trừ tombstone) — count phải là số này, KHÔNG phải cells.length
  private widthValue = 1;     // width của model lúc túi được mở (giải index -> px/py)
  private slabThickness = 1;

  get count(): number { return this.liveCount; }
  get isEmpty(): boolean { return this.liveCount === 0; }
  get drained(): boolean { return this.drainCursor >= this.cells.length; }

  /**
   * Ô bỏ cuộc xử lý thế nào khi drain xong: true = REVERT Held->Solid + sáng lại (túi của NÉT VUỐT)
   * · false = RETRY (xếp lại thành túi mới, thử đợt sau).
   *
   * ⚠ Túi AUTO-SWIPE bắt buộc false. Nó revert thì revertVersion tăng -> tầng trên re-arm auto-swipe -> carve lại
   * đúng ô đó -> revert lại = NHẤP NHÁY VÔ HẠN.
   */
  revertOnFinish = true;

  /** Cell tới lượt mà chưa thoát được — ứng viên revert Held->Solid, THEO thứ tự drain. Đọc-để-quét. */
  get revertBook(): readonly number[] { return this.revertBookList; }

  /**
   * Mọi cell của túi (sau closeAndOrder = đúng thứ tự drain, đã sạch tombstone). Đọc-để-quét, KHÔNG mutate.
   * Dùng cho DẢI MỎNG TỰ TAN: lấy tập ô này làm hạt giống quét quanh viền. Phải đọc TRƯỚC khi túi về pool.
   */
  get cellsView(): readonly number[] { return this.cells; }

  /** Dọn túi để dùng lại (pool). `width` = model.width lúc mở túi. */
  reset(width: number): void {
    this.cells.length = 0;
    this.arcs.length = 0;
    this.slotOf.clear();
    this.revertBookList.length = 0;
    this.drainCursor = 0;
    this.liveCount = 0;
    this.widthValue = Math.max(1, width);
    this.revertOnFinish = true;
  }

  /** Túi này bỏ cuộc thì RETRY chứ không revert (auto-swipe — xem revertOnFinish). */
  markNoRevert(): void { this.revertOnFinish = false; }

  /**
   * Ô này có đang nằm trong túi (còn MỞ) không. Tầng trên hỏi để biết brush còn chồng lên VỆT của chính túi hay đã
   * ra hẳn ngoài — mốc phân biệt "chưa dịch ngón tay" với "ra khỏi tranh" khi quyết định đóng túi.
   * Túi đã đóng luôn trả false (closeAndOrder xoá map) — đúng ý: chỉ túi mở mới đang được bồi.
   */
  contains(cellIndex: number): boolean { return this.slotOf.has(cellIndex); }

  /**
   * Nạp cell vừa Solid->Held vào túi.
   * @param strokeArc quãng đường tích luỹ (ô) của nét tại thời điểm cào — mốc chia lát.
   *   Cell đã có trong túi -> tombstone slot cũ, ô nhận arc MỚI.
   */
  append(cellIndex: number, strokeArc: number): void {
    const old = this.slotOf.get(cellIndex);
    if (old !== undefined) {
      this.cells[old] = -1;   // tombstone slot cũ
      this.liveCount--;
    }
    this.slotOf.set(cellIndex, this.cells.length);
    this.cells.push(cellIndex);
    this.arcs.push(strokeArc);
    this.liveCount++;
  }

  /**
   * ĐÓNG túi: dọn tombstone rồi sắp theo thứ tự DRAIN.
   * @param slabCells độ dày lát tính bằng Ô ngón tay đi được; ≤1 = gần như thuần thứ tự chạm (bám tay nhất,
   *   dễ trông "cắt lát"), lớn = gần thuần trọng lực.
   */
  closeAndOrder(slabCells: number): void {
    this.compact();
    this.slotOf.clear();   // túi đóng -> không còn đè được nữa, đừng giữ map cho tốn
    this.drainCursor = 0;
    if (this.cells.length <= 1) return;

    this.slabThickness = Math.max(1, slabCells);
    const w = this.widthValue;
    const slab = this.slabThickness;
    const arcs = this.arcs;
    const cells = this.cells;

    // Sắp bằng permutation (như nguồn) thay vì sort thẳng cells: arcs phải đi kèm khoá sort.
    const idx = cells.map((_, k) => k);
    idx.sort((a, b) => {
      const sa = Math.floor(arcs[a] / slab);
      const sb = Math.floor(arcs[b] / slab);
      if (sa !== sb) return sa - sb;
      const pya = (cells[a] / w) | 0, pyb = (cells[b] / w) | 0;
      if (pya !== pyb) return pyb - pya;          // py CAO trước = gần cửa thoát = trọng lực
      return cells[a] - cells[b];                 // tie-break theo index -> thứ tự TẤT ĐỊNH
    });
    const permuted = idx.map((k) => cells[k]);
    for (let k = 0; k < permuted.length; k++) cells[k] = permuted[k];
    // arcs hết vai trò sau khi sắp xong (chỉ là khoá sort) -> KHÔNG permute để khỏi tốn 1 vòng nữa.
    this.arcs.length = 0;
  }

  /**
   * Lấy cell kế tiếp theo thứ tự drain + ĐẨY con trỏ. Không peek: cell tới lượt mà chưa tan được thì caller ghi
   * markRevertCandidate, KHÔNG lùi con trỏ — túi luôn tiến, không kẹt vòng lặp.
   * @param out object tái dùng, được ghi khi trả true.
   */
  tryTakeNext(out: TakenCell): boolean {
    // Nguồn đệ quy để nhảy qua tombstone sót (túi bị drain khi chưa close); ở đây dùng vòng lặp — cùng ngữ nghĩa,
    // không rủi ro tràn stack khi túi to toàn tombstone.
    while (!this.drained) {
      const cellIndex = this.cells[this.drainCursor++];
      if (cellIndex < 0) continue;
      out.cellIndex = cellIndex;
      out.px = cellIndex % this.widthValue;
      out.py = (cellIndex / this.widthValue) | 0;
      return true;
    }
    out.px = out.py = out.cellIndex = -1;
    return false;
  }

  /** Cell tới lượt mà không tan được -> ứng viên revert Held->Solid (đọc lúc túi drain xong). */
  markRevertCandidate(cellIndex: number): void { this.revertBookList.push(cellIndex); }

  // Bỏ tombstone, giữ nguyên thứ tự tương đối của phần còn lại. Chạy 1 lần lúc đóng túi.
  private compact(): void {
    if (this.liveCount === this.cells.length) return;
    let w = 0;
    for (let k = 0; k < this.cells.length; k++) {
      if (this.cells[k] < 0) continue;
      this.cells[w] = this.cells[k];
      this.arcs[w] = this.arcs[k];
      w++;
    }
    this.cells.length = w;
    this.arcs.length = w;
  }
}
