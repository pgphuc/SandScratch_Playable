// Mô hình 3-state của TRANH — port của Flow/Carve/PictureCarveModel.cs (718 LOC).
//
// TOẠ ĐỘ picture-local (px,py) trùng PixelLevelData: py=0 ở ĐỈNH, py=Height-1 ở ĐÁY. ĐÁY = cửa thoát,
// nên "xuôi trọng lực" = py TĂNG. (Ngược trục Y của solver — quy đổi là việc của tầng backend, không phải ở đây.)
//
// STATE MACHINE:
//   SOLID = tranh nguyên, còn collider, chưa ai gạt.
//   HELD  = đã gạt (carveCell) nhưng CHƯA thông ra cửa -> VẪN collider (occupancy không đổi khi Solid->Held).
//   EMPTY = đã convert thành hạt (convertCell) -> mở, hết collider.
//
// LUẬT "CÁT CHẢY XUỐNG" — điểm dễ đọc nhầm nhất của file này. Đường thoát CÓ HƯỚNG: mỗi đoạn trượt ngang
// phải trả bằng 1 nhịp rơi, và KHÔNG có hướng LÊN. Bản cũ dùng BFS 4-neighbor vô hướng nên "có đường ra" tính
// cả đường phải TRÈO LÊN qua mép túi -> pixel đáy túi lõm vẫn convert -> đẻ void cụt bẫy hạt.
//
// ⚠ HỆ QUẢ GAMEPLAY, KHÔNG phải bug: vùng tan được từ 1 lỗ thoát là hình NÓN mở LÊN, nửa góc atan(slideCells)
// so với phương ĐỨNG. Vuốt một đường NGANG dài giữa tranh -> chỉ phần trong nón tan; phần xa 2 bên giữ HELD tới
// khi người chơi đào thêm đường xuống. Muốn tranh dễ tan hơn thì NÂNG knob slideCells, ĐỪNG nới luật ở đây.
//
// ⚠ HAI trường escape, đừng lẫn:
//   escape    passable = EMPTY        -> "cát ở đây RA ĐƯỢC BÂY GIỜ"      -> gate convert (isEligible).
//   escapeOpt passable = KHÔNG-SOLID  -> "ô này RỒI SẼ TAN" (HELD coi như đã mở) -> gate SCROLL (bottomSolidRowIndex).
// Cả hai đơn điệu (tập passable chỉ NỞ) nhưng KHÔNG lan incremental được — luật theo HÀNG, không phải bước đơn
// giữa 2 ô kề -> quét lại full khi bẩn, gác bằng ensureEscape/ensureEscapeOpt.

// `enum` không chạy được dưới type-stripping của Node (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX) — dùng const object
// + union type, giữ nguyên giá trị số của PictureCellState.cs (Solid=0 · Held=1 · Empty=2).
export const PictureCellState = {
  Solid: 0,
  Held: 1,
  Empty: 2,
} as const;
export type PictureCellState = (typeof PictureCellState)[keyof typeof PictureCellState];

const INT_MAX = 0x7fffffff;
const MAX_FROZEN_GROUP_ID = 254; // mặt nạ lưu byte groupId+1 -> 255 là giá trị cuối dùng được

export interface OccRect { x: number; y: number; width: number; height: number; }

/** Bộ lọc TỪNG Ô cho carve (luật scroll). Trả false = ô đó không cào, các ô khác của brush VẪN cào. */
export type CanCarveCell = (px: number, py: number) => boolean;

export class PictureCarveModel {
  readonly width: number;
  readonly height: number;

  // Occupancy THÔ cho collider: block occCellPixels² = occupied nếu còn ≥1 cell SOLID|HELD.
  readonly occCellPixels: number;
  readonly occWidth: number;
  readonly occHeight: number;

  private readonly state: Uint8Array;          // [py*width+px] -> PictureCellState
  private readonly colorId: Int32Array;        // colorId gốc của cell painted, -1 = trống
  private readonly escape: Uint8Array;         // EMPTY && cát ở đây đi CHÉO-XUỐNG ra được cửa thoát
  private readonly escapeOpt: Uint8Array;      // KHÔNG-SOLID && nt (coi HELD như đã mở) = "ô này rồi sẽ tan"
  private readonly occCount: Int32Array;       // số cell SOLID|HELD trong mỗi occ-block -> occupied = >0

  // Đếm cell còn SOLID. ⚠ DAO ĐỘNG theo thiết kế: revertCell cộng lại -> KHÔNG dùng làm mốc "xong tranh".
  private solidCountValue = 0;
  private initialSolidCount = 0;
  private readonly solidCountByColor: Int32Array;   // index = colorId, dài = maxColorId+1
  private readonly colorsPresentList: number[] = [];
  // Đếm cell CHƯA TỪNG convert. ĐƠN ĐIỆU GIẢM (Empty là 1 chiều) -> đúng thứ allPixelsSwiped cần.
  private neverConvertedCount = 0;
  private revertVersionValue = 0;

  // DẢI HỌNG: cột hàng-đáy tính là "cửa thoát" = [exitMinPx..exitMaxPx].
  private readonly exitMinPx: number;
  private readonly exitMaxPx: number;

  // HELD đủ điều kiện convert (bước chéo-xuống tới escape-empty / hàng đáy trong dải họng).
  private readonly frontier = new Set<number>();

  // DIRTY-RECT occupancy: bbox OCC-CELL vừa về 0 kể từ consumeOccDirtyRect gần nhất. maxX < minX = sạch.
  private dirtyMinX = INT_MAX; private dirtyMinY = INT_MAX;
  private dirtyMaxX = -INT_MAX; private dirtyMaxY = -INT_MAX;

  // Mặt nạ CHẶN-CÀO song song state: [py*width+px] = groupId+1, 0 = không băng.
  // null = level KHÔNG có hình băng (cấp lazy ở setFrozen) -> level không băng tốn 0 byte.
  private frozen: Uint8Array | null = null;

  // ĐỘ CHÉO: số ô NGANG cát trượt được trên MỖI hàng tụt. 0 = giếng thẳng · 1 = nón 45° · 8 ≈ 83°.
  // Asset live chốt 8 = CỐ Ý nới quá mức vật lý (góc nghỉ thật của cát ~56° so phương đứng), đổi "đúng physics"
  // lấy "tranh tan mượt". Ngân sách nạp lại sau MỖI hàng rơi -> "trượt ngang vô hạn" không biểu diễn được — cố ý.
  private readonly slideCells: number;
  private readonly canDrop: Uint8Array;   // scratch 1 hàng: ô THÔNG này rơi thẳng 1 hàng là thoát?
  private readonly dist: Int32Array;      // scratch 1 hàng: khoảng cách ngang tới ô rơi-được gần nhất CÙNG run

  private escapeDirty = true;
  private escapeOptDirty = true;
  // Occupancy FINE chỉ đổi khi CONVERT (Held->Empty); carve + frozen KHÔNG đổi output "!=Empty".
  private fineOccDirtyFlag = true;

  /**
   * @param paintedColorIds length = width*height (index py*width+px). Giá trị = colorId nếu là pixel tranh,
   *   -1 nếu trống -> cell trống = EMPTY sẵn, cát chảy qua được.
   * @param exitMinPx cột hàng-đáy nhỏ nhất tính là cửa thoát. -1 = full-width.
   * @param exitMaxPx cột hàng-đáy lớn nhất tính là cửa thoát. -1 = full-width.
   * @param slideCells ĐỘ CHÉO đường thoát. Nguồn thật = GrainTuningConfig.GrainEscapeSlideCells (asset live = 8).
   */
  constructor(width: number, height: number, paintedColorIds: ArrayLike<number> | null,
              occCellPixels = 4, exitMinPx = -1, exitMaxPx = -1, slideCells = 8) {
    this.width = width;
    this.height = height;
    this.occCellPixels = Math.max(1, occCellPixels);
    this.occWidth = Math.ceil(width / this.occCellPixels);
    this.occHeight = Math.ceil(height / this.occCellPixels);

    let lo = exitMinPx < 0 ? 0 : clamp(exitMinPx, 0, width - 1);
    let hi = exitMaxPx < 0 ? width - 1 : clamp(exitMaxPx, 0, width - 1);
    if (lo > hi) { lo = 0; hi = width - 1; }
    this.exitMinPx = lo;
    this.exitMaxPx = hi;

    this.slideCells = Math.max(0, slideCells);
    const n = width * height;
    this.state = new Uint8Array(n);
    this.colorId = new Int32Array(n);
    this.escape = new Uint8Array(n);
    this.escapeOpt = new Uint8Array(n);
    this.canDrop = new Uint8Array(width);
    this.dist = new Int32Array(width);
    this.occCount = new Int32Array(this.occWidth * this.occHeight);

    // Pre-scan chốt trần colorId. Tranh trống (maxColorId = -1) -> mảng rỗng, mọi truy vấn trả 0.
    let maxColorId = -1;
    if (paintedColorIds != null) {
      const scanLen = Math.min(paintedColorIds.length, n);
      for (let i = 0; i < scanLen; i++) if (paintedColorIds[i] > maxColorId) maxColorId = paintedColorIds[i];
    }
    this.solidCountByColor = new Int32Array(maxColorId + 1);

    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        const i = py * width + px;
        const c = paintedColorIds != null && i < paintedColorIds.length ? paintedColorIds[i] : -1;
        this.colorId[i] = c;
        if (c >= 0) {
          this.state[i] = PictureCellState.Solid;
          this.occCount[this.occIndex(px, py)]++;
          this.solidCountValue++;
          this.solidCountByColor[c]++;
        } else {
          this.state[i] = PictureCellState.Empty;  // cell trống của tranh = mở sẵn (không collider)
        }
      }
    }
    for (let c = 0; c < this.solidCountByColor.length; c++)
      if (this.solidCountByColor[c] > 0) this.colorsPresentList.push(c);   // tập màu CHỐT lúc build
    this.initialSolidCount = this.solidCountValue;
    this.neverConvertedCount = this.solidCountValue;

    this.fineOccDirtyFlag = true;
    // Lúc build chưa có ô HELD nào -> 2 trường ra kết quả GIỐNG nhau; vẫn tính cả 2 vì chúng rẽ nhánh ngay nhát
    // swipe đầu tiên (carveCell làm bẩn escapeOpt, convertCell làm bẩn escape).
    this.ensureEscape();
    this.ensureEscapeOpt();
  }

  // ==================================================================== read API

  stateAt(px: number, py: number): PictureCellState {
    // state la Uint8Array -> tra `number`. Cast la AN TOAN vi moi luong ghi vao state deu di qua
    // PictureCellState (ctor + carveCell + convertCell + revertCell), khong co cho nao ghi so tho.
    return this.inBounds(px, py)
      ? (this.state[py * this.width + px] as PictureCellState)
      : PictureCellState.Empty;
  }

  colorAt(px: number, py: number): number {
    return this.inBounds(px, py) ? this.colorId[py * this.width + px] : -1;
  }

  /** EMPTY-cell này có đường thoát CHÉO-XUỐNG ra khỏi khung không (luật cát-chảy-xuống)? */
  canEscapeToExit(px: number, py: number): boolean {
    if (!this.inBounds(px, py)) return false;
    this.ensureEscape();
    return this.escape[py * this.width + px] !== 0;
  }

  isOccupied(ox: number, oy: number): boolean {
    return ox >= 0 && ox < this.occWidth && oy >= 0 && oy < this.occHeight
        && this.occCount[oy * this.occWidth + ox] > 0;
  }

  get frontierCount(): number { return this.frontier.size; }

  /** Số cell còn SOLID (chưa swipe). Frozen tính là Solid (chưa cào được). */
  get solidCount(): number { return this.solidCountValue; }

  /** Số cell còn SOLID CỦA RIÊNG 1 MÀU. Cùng luật đếm với solidCount -> chỉ dùng cho ngưỡng auto-swipe. */
  solidCountOfColor(colorId: number): number {
    return colorId >= 0 && colorId < this.solidCountByColor.length ? this.solidCountByColor[colorId] : 0;
  }

  /** colorId CÓ MẶT trong tranh lúc build (tăng dần). Cố định cả level — màu tan hết không biến mất khỏi list. */
  get colorsPresent(): readonly number[] { return this.colorsPresentList; }

  /**
   * Tranh CÓ pixel VÀ đã TAN HẾT thành hạt? Level không có tranh -> luôn false (không boost oan).
   * ⚠ Mốc là CONVERT chứ không phải CARVE, và đọc neverConvertedCount chứ KHÔNG phải solidCount: kể từ khi có
   * revert (Held->Solid), solidCount dao động -> cờ này từng bật-tắt-bật = belt-boost cuối màn giật cấp.
   */
  get allPixelsSwiped(): boolean { return this.initialSolidCount > 0 && this.neverConvertedCount === 0; }

  /** Cell có bị hình băng khoá không -> KHÔNG cào được. Level không có băng -> luôn false. */
  isFrozen(px: number, py: number): boolean {
    return this.frozen !== null && this.inBounds(px, py) && this.frozen[py * this.width + px] !== 0;
  }

  /** NHÓM băng đang khoá cell -> groupId (= chỉ số placement), -1 = cell không băng. */
  frozenGroupAt(px: number, py: number): number {
    if (this.frozen === null || !this.inBounds(px, py)) return -1;
    return this.frozen[py * this.width + px] - 1;
  }

  /**
   * (SCROLL) Hàng py THẤP NHẤT (gần đáy nhất) còn CHẶN trong dải cột [pxMin..pxMax]; -1 khi cả dải đã sạch.
   * "Chặn" = Solid, HOẶC Held CÒN TAN ĐƯỢC (xem blocks).
   *
   * ⚠ b_i KHÔNG đơn điệu tuyệt đối: Held kẹt -> hết kẹt làm 1 ô lật KHÔNG-chặn -> CHẶN, tức b_i có thể TĂNG.
   * Chốt chặn `max(target, scrollRows[col])` bên PictureScrollController gác ca này — ĐỪNG gỡ vì tưởng b_i chỉ giảm.
   *
   * KHÔNG nhận `col`: model sống ở picture-space, không biết k cột. Caller tự quy đổi cột -> dải px.
   */
  bottomSolidRowIndex(pxMin: number, pxMax: number): number {
    this.ensureEscapeOpt();   // blocks() đọc escapeOpt; swipe làm bẩn nó -> quét lại tối đa 1 lần/frame
    const x0 = Math.max(0, pxMin);
    const x1 = Math.min(this.width - 1, pxMax);
    for (let py = this.height - 1; py >= 0; py--) {        // quét TỪ ĐÁY lên -> gặp phát đầu là xong
      const row = py * this.width;
      for (let px = x0; px <= x1; px++) if (this.blocks(row + px)) return py;
    }
    return -1;
  }

  // Ô này có GIỮ cột lại không? Ba vế, mỗi vế một lý do khác nhau:
  //   SOLID                   -> CÓ. Tranh nguyên.
  //   HELD còn tan được       -> CÓ. Tí nữa thành hạt; cột phải đợi, không thì scroll vượt mặt convert và kéo
  //                              collider HELD xuống dưới cửa sổ = tường vô hình + emit ngoài sân.
  //   HELD KẸT CỨNG (túi lõm) -> KHÔNG. Luật cát-chảy-xuống khoá vĩnh viễn -> đợi = kẹt cột vĩnh viễn.
  //   EMPTY                   -> KHÔNG. Hết collider.
  // Dùng escapeOpt chứ KHÔNG phải escape: hỏi "RỒI CÓ TAN KHÔNG", không phải "TAN ĐƯỢC NGAY BÂY GIỜ CHƯA".
  private blocks(i: number): boolean {
    const s = this.state[i];
    if (s === PictureCellState.Solid) return true;
    return s === PictureCellState.Held && this.escapeOpt[i] !== 0;
  }

  /** Bulk-copy occupancy THÔ (1 = occupied, index oy*occWidth+ox) cho va chạm tranh. dst thiếu -> copy tới min. */
  copyOccupancyTo(dst: Uint8Array): void {
    const n = Math.min(this.occCount.length, dst.length);
    for (let i = 0; i < n; i++) dst[i] = this.occCount[i] > 0 ? 1 : 0;
  }

  /** Tranh CÓ convert kể từ lần copyFineOccupancyTo trước? ĐỌC THUẦN, KHÔNG reset. */
  get fineOccDirty(): boolean { return this.fineOccDirtyFlag; }

  /**
   * Bulk-copy occupancy PER-PIXEL (FINE, index py*width+px): 1 nếu còn tranh (Solid|Held), 0 nếu Empty.
   * Khác copyOccupancyTo (occ-BLOCK thô): hạt EMIT tại pixel VỪA convert không bị block thô coi là "trong tranh".
   */
  copyFineOccupancyTo(dst: Uint8Array): void {
    if (!this.fineOccDirtyFlag) return;  // tranh chưa CONVERT kể từ copy trước -> dst còn đúng, khỏi quét O(W·H)
    this.fineOccDirtyFlag = false;
    const n = Math.min(this.state.length, dst.length);
    for (let i = 0; i < n; i++) dst[i] = this.state[i] !== PictureCellState.Empty ? 1 : 0;
  }

  /** Lấy + reset bbox occ-cell vừa mở. false = không đổi. Builder re-tile CHỈ vùng này thay vì full grid. */
  consumeOccDirtyRect(out: OccRect): boolean {
    if (this.dirtyMaxX < this.dirtyMinX) return false;
    out.x = this.dirtyMinX;
    out.y = this.dirtyMinY;
    out.width = this.dirtyMaxX - this.dirtyMinX + 1;
    out.height = this.dirtyMaxY - this.dirtyMinY + 1;
    this.dirtyMinX = this.dirtyMinY = INT_MAX;
    this.dirtyMaxX = this.dirtyMaxY = -INT_MAX;
    return true;
  }

  // ==================================================================== frozen (mặt nạ chặn cào)

  /** Khoá cell vào nhóm groupId (= chỉ số placement). Lưu byte groupId+1 -> trần 254 nhóm/level. */
  setFrozen(px: number, py: number, groupId: number): void {
    if (!this.inBounds(px, py)) return;
    if (groupId < 0 || groupId > MAX_FROZEN_GROUP_ID) {
      throw new RangeError(`setFrozen: groupId ${groupId} ngoài [0,${MAX_FROZEN_GROUP_ID}]`);
    }
    this.frozen ??= new Uint8Array(this.width * this.height);   // cấp lazy
    this.frozen[py * this.width + px] = groupId + 1;
  }

  /**
   * GIẢI BĂNG nhóm groupId — cell của nhóm về cào-được. state KHÔNG đổi (băng chưa bao giờ đổi state)
   * -> KHÔNG cần re-seed connectivity / đụng occupancy / rebuild collider.
   */
  clearFrozenGroup(groupId: number): void {
    if (this.frozen === null || groupId < 0 || groupId > MAX_FROZEN_GROUP_ID) return;
    const mark = groupId + 1;
    for (let i = 0; i < this.frozen.length; i++) if (this.frozen[i] === mark) this.frozen[i] = 0;
  }

  // ==================================================================== carve (swipe -> Solid->Held)

  /**
   * Gạt 1 đĩa tròn tâm (px,py) bán kính r: mọi cell SOLID -> HELD. Held/Empty giữ nguyên.
   * @param newlyHeld (optional) được ĐIỀN index các cell VỪA chuyển Solid->Held -> builder hạ alpha xuống 0.8.
   * @param canCarveCell lọc theo DẤU CHÂN brush chứ không reject theo TÂM: brush có bán kính nên tâm nằm ngoài
   *   vùng cấm vẫn với ngược lên ăn vào vùng cấm.
   */
  carveBrush(px: number, py: number, radius: number,
             newlyHeld: number[] | null = null, canCarveCell: CanCarveCell | null = null): void {
    const r2 = radius * radius;
    for (let oy = -radius; oy <= radius; oy++)
      for (let ox = -radius; ox <= radius; ox++)
        if (ox * ox + oy * oy <= r2) {
          const cx = px + ox, cy = py + oy;
          if (canCarveCell !== null && !canCarveCell(cx, cy)) continue;   // ô bị cấm -> bỏ ô NÀY thôi
          if (this.carveCell(cx, cy)) newlyHeld?.push(cy * this.width + cx);
        }
  }

  /** AUTO-SWIPE: cào NỐT mọi cell Solid còn lại 1 phát (frozen tự bỏ qua, escape/frontier cập nhật như swipe tay). */
  carveAllRemaining(newlyHeld: number[] | null = null, canCarveCell: CanCarveCell | null = null): void {
    for (let py = 0; py < this.height; py++)
      for (let px = 0; px < this.width; px++) {
        if (canCarveCell !== null && !canCarveCell(px, py)) continue;
        if (this.carveCell(px, py)) newlyHeld?.push(py * this.width + px);
      }
  }

  /**
   * AUTO-SWIPE THEO MÀU: như carveAllRemaining nhưng CHỈ cào cell mang colorId.
   *
   * ⚠ canCarveCell BẮT BUỘC ở level SCROLL: cào ô còn nằm TRÊN cửa sổ thì visual erase rơi vào vùng chưa bake
   * = no-op, tới lúc cột tụt thì bake tô lại hàng đó TỪ DATA -> pixel hiện lại nguyên vẹn trong khi model đã
   * Held/Empty -> KHÔNG cào lại được nữa = kẹt vĩnh viễn.
   */
  carveAllRemainingOfColor(colorId: number,
                           newlyHeld: number[] | null = null, canCarveCell: CanCarveCell | null = null): void {
    if (colorId < 0) return;
    for (let py = 0; py < this.height; py++)
      for (let px = 0; px < this.width; px++) {
        const i = py * this.width + px;
        if (this.colorId[i] !== colorId) continue;
        if (canCarveCell !== null && !canCarveCell(px, py)) continue;
        if (this.carveCell(px, py)) newlyHeld?.push(i);
      }
  }

  /**
   * SOLID -> HELD (giải phóng, occupancy KHÔNG đổi -> collider giữ). Rồi kiểm đủ điều kiện convert.
   * Trả true CHỈ KHI vừa chuyển Solid->Held.
   */
  carveCell(px: number, py: number): boolean {
    if (!this.inBounds(px, py)) return false;
    const i = py * this.width + px;
    // FROZEN: cell bị băng khoá -> KHÔNG cào, kể cả re-kiểm frontier. Guard ĐỦ Ở ĐÂY cho cả carveBrush (brush đi
    // XUYÊN hàm này) = 1 nguồn chân lý. Băng chỉ chặn CÀO: cell ở nguyên Solid nên occupancy/convert tự đúng.
    if (this.frozen !== null && this.frozen[i] !== 0) return false;
    if (this.state[i] === PictureCellState.Solid) {
      this.state[i] = PictureCellState.Held;
      this.solidCountValue--;
      this.solidCountByColor[this.colorId[i]]--;   // Solid <=> colorId >= 0 (ctor chỉ set Solid khi c >= 0)
      // Ô vừa hết Solid -> tập KHÔNG-SOLID nở ra -> escapeOpt có thể nối thêm đường. escape KHÔNG đổi: nó chỉ
      // đi qua EMPTY THẬT, mà ô này mới chỉ Held.
      this.escapeOptDirty = true;
      this.checkFrontier(px, py);
      return true;
    }
    if (this.state[i] === PictureCellState.Held) {
      this.checkFrontier(px, py);   // re-kiểm (hàng xóm có thể vừa thông)
    }
    return false;
  }

  // ==================================================================== convert (wavefront -> Held->Empty)

  /**
   * Nhịp quét lại/đợt cho luật CHẶT: gọi ĐÚNG 1 LẦN đầu mỗi đợt, TRƯỚC vòng pop frontier.
   * ⚠ ĐỪNG gộp vào tryPeekFrontierLowest: hàm đó chạy TRONG vòng pop, mà convertCell bẩn cờ MỖI ô -> mỗi vòng
   * quét lại TOÀN LƯỚI O(W·H). Cascade "con nằm TRÊN cha vừa convert" trong đợt không cần quét lại — convertCell
   * đã vá escape[i]=true.
   */
  beginConvertWave(): void { this.ensureEscape(); }

  /**
   * Cell HELD đủ điều kiện convert nhất theo TRỌNG LỰC (py CAO nhất = gần cửa thoát nhất). Peek, KHÔNG bỏ.
   * ⚠ ĐỌC frontier THÔ — caller PHẢI gọi beginConvertWave() đầu wave. Trong wave frontier chỉ CO.
   * @returns index py*width+px, hoặc -1 nếu frontier rỗng.
   */
  tryPeekFrontierLowest(): number {
    let best = -1;
    let bestIdx = -1;
    for (const i of this.frontier) {
      const cy = (i / this.width) | 0;
      if (cy > best) { best = cy; bestIdx = i; }
    }
    return bestIdx;
  }

  /**
   * Convert 1 cell HELD -> EMPTY. Mở occupancy, bật escape, lan escape LOCAL -> kéo Held bước CHÉO-XUỐNG tới
   * được nó vào frontier. BỎ (px,py) khỏi frontier dù convert được hay không (chống loop).
   *
   * ⚠ Cell KHÔNG đủ điều kiện vẫn bị BỎ khỏi frontier -> nó rơi khỏi frontier trong khi vẫn HELD. CHỦ ĐÍCH,
   * không phải leak: lượt quét lại (rebuildEscapeField repairFrontier) nạp nó lại ngay khi nó thoát được. Gate ở
   * tầng peek thay vì ở đây = frontier chỉ phình, KHÔNG bao giờ co.
   *
   * @param requireEscape false thì BỎ điều kiện isEligible — dành cho drain TÚI, nơi điều kiện đã kiểm bằng
   *   luật LẠC QUAN ở tầng trên. ⚠ Nhánh không-gate KHÔNG được vá escape[i]=true: ô này CHƯA chứng minh thoát
   *   được, khai true là nói dối cả trường -> mọi ô NẰM TRÊN nó thành "eligible" oan.
   */
  convertCell(px: number, py: number, requireEscape = true): boolean {
    if (!this.inBounds(px, py)) return false;
    const i = py * this.width + px;
    this.frontier.delete(i);
    if (this.state[i] !== PictureCellState.Held) return false;
    if (requireEscape && !this.isEligible(px, py)) return false;

    this.state[i] = PictureCellState.Empty;
    this.neverConvertedCount--;   // ô này vừa TAN lần đầu (Held->Empty là 1 chiều)
    this.fineOccDirtyFlag = true; // convert là chỗ DUY NHẤT occupancy fine đổi
    if (--this.occCount[this.occIndex(px, py)] === 0)
      this.markOccDirty((px / this.occCellPixels) | 0, (py / this.occCellPixels) | 0);
    // Ô vừa mở CHẮC CHẮN thoát được (isEligible ở trên đã chứng minh) -> vá NGAY 1 ô để convert tiếp được các con
    // NẰM TRÊN nó trong cùng nhóm mà không phải quét lại cả lưới giữa chừng.
    if (requireEscape) this.escape[i] = 1;
    this.escapeDirty = true;
    // escapeOpt KHÔNG đổi: Held lẫn Empty đều là KHÔNG-SOLID -> tập passable của nó y nguyên.
    return true;
  }

  /**
   * (SwipeBatch) Cell tan được theo luật LẠC QUAN không = đang HELD VÀ escapeOpt nói "rồi sẽ thông" (đường xuống
   * được phép đi qua ô HELD, tức qua chỗ ngón tay VỪA cào).
   *
   * ⚠ Khác hẳn luật CHẶT (isEligible, đường chỉ qua EMPTY thật). Lý do: vuốt 1 nét xuống thì CẢ kênh là HELD nên
   * theo luật chặt chỉ đúng ô ĐÁY eligible -> tập chọn chỉ có 1 lớp -> mọi thứ tự vuốt đều vô nghĩa, tranh luôn
   * tan bottom-up. Luật lạc quan mở cả kênh cùng lúc nên thứ tự vuốt mới có việc để làm.
   * ⚠ ĐỌC trường thô — caller PHẢI gọi syncEscapeOptimistic() 1 lần đầu wave.
   */
  canConvertNowOptimistic(px: number, py: number): boolean {
    if (!this.inBounds(px, py)) return false;
    const i = py * this.width + px;
    return this.state[i] === PictureCellState.Held && this.escapeOpt[i] !== 0;
  }

  /** Cặp song sinh của beginConvertWave cho luật lạc quan — gọi ĐÚNG 1 LẦN đầu wave, TRƯỚC vòng drain túi. */
  syncEscapeOptimistic(): void { this.ensureEscapeOpt(); }

  /**
   * REVERT: HELD -> SOLID cho ô túi đã bỏ cuộc (cào hụt, không có đường xuống kể cả theo luật lạc quan).
   * Occupancy KHÔNG đổi (Solid lẫn Held đều chiếm chỗ) nên không đụng dirty-rect/collider.
   *
   * ⚠ solidCount TĂNG lại — CỐ Ý: ô revert LÀ ô người chơi phải cào lại. Cái giá là auto-swipe phải RE-ARM theo
   * revertVersion, nếu không tranh revert sau auto-swipe nằm lại vĩnh viễn (level không thắng được).
   * ⚠ KHÔNG đụng neverConvertedCount: ô revert vốn CHƯA từng convert nên đã được đếm sẵn. Cộng lại = đếm 2 lần
   * cùng 1 ô -> allPixelsSwiped không bao giờ true.
   */
  revertCell(px: number, py: number): boolean {
    if (!this.inBounds(px, py)) return false;
    const i = py * this.width + px;
    if (this.state[i] !== PictureCellState.Held) return false;
    this.state[i] = PictureCellState.Solid;
    this.solidCountValue++;
    this.solidCountByColor[this.colorId[i]]++;   // ô Held vốn đi lên từ Solid -> colorId >= 0
    this.frontier.delete(i);
    // Tập KHÔNG-SOLID CO lại -> đường "rồi sẽ thông" có thể đứt. escape KHÔNG đổi (nó chỉ đi qua EMPTY thật).
    this.escapeOptDirty = true;
    this.revertVersionValue++;
    return true;
  }

  /** Số lần revertCell thành công (chỉ TĂNG) — ConversionFront so mốc này để RE-ARM auto-swipe. */
  get revertVersion(): number { return this.revertVersionValue; }

  // ==================================================================== escape internals

  // Ô này cát ĐI QUA được không? heldPassable = coi HELD như đã mở (trường escapeOpt "rồi sẽ tan").
  private passable(i: number, heldPassable: boolean): boolean {
    const s = this.state[i];
    return s === PictureCellState.Empty || (heldPassable && s === PictureCellState.Held);
  }

  // 2 hàm ensure* là CỔNG DUY NHẤT được đọc trường escape từ API public — chúng gác cờ bẩn. ĐỪNG gọi trong vòng
  // lặp convert: mỗi lần bẩn là quét lại O(W·H), gọi mỗi ô = O(W·H) MỖI Ô.
  private ensureEscape(): void {
    if (!this.escapeDirty) return;
    this.escapeDirty = false;
    this.rebuildEscapeField(this.escape, false, true);
  }

  private ensureEscapeOpt(): void {
    if (!this.escapeOptDirty) return;
    this.escapeOptDirty = false;
    this.rebuildEscapeField(this.escapeOpt, true, false);
  }

  /**
   * Quét TỪ ĐÁY LÊN, mỗi hàng 1 lượt. Ô THÔNG (px,py) thoát được ⟺ trượt NGANG ≤ slideCells ô (qua các ô THÔNG
   * cùng hàng, không xuyên tường) tới được 1 ô "rơi-được" — rơi-được = ô ngay DƯỚI đã thoát (hàng dưới tính XONG
   * rồi nên 1 lượt là đủ, không cần lặp tới hội tụ), hoặc đang ở hàng đáy trong dải họng.
   * O(W·H) tổng: slideCells nằm TRONG lượt quét ngang (slideRow = distance-transform chặn ở K), KHÔNG nhân vào
   * độ phức tạp.
   *
   * @param repairFrontier true -> nạp luôn mọi HELD đủ điều kiện vào frontier (CHỈ dùng cho escape). Đây là thứ
   *   khử hẳn class "pixel câm". Chỉ ADD, KHÔNG clear — giữ nguyên cơ chế chống-loop của tầng trên.
   */
  private rebuildEscapeField(dst: Uint8Array, heldPassable: boolean, repairFrontier: boolean): void {
    const { width, height } = this;
    for (let py = height - 1; py >= 0; py--) {
      const row = py * width;
      const below = row + width;
      const bottom = py === height - 1;
      for (let px = 0; px < width; px++) {
        const exits = bottom ? (px >= this.exitMinPx && px <= this.exitMaxPx) : dst[below + px] !== 0;
        this.canDrop[px] = this.passable(row + px, heldPassable) && exits ? 1 : 0;
      }
      this.slideRow(dst, row, heldPassable);
      if (!repairFrontier) continue;
      for (let px = 0; px < width; px++)
        if (this.state[row + px] === PictureCellState.Held && this.isEligible(px, py)) this.frontier.add(row + px);
    }
  }

  // 1 hàng: dst[x] = có ô rơi-được cách ≤ slideCells trong CÙNG run ô-thông. 2 lượt (trái->phải, phải->trái) =
  // distance-transform chặn ở K, O(W). Cắt theo RUN (không cho vượt tường) = chỗ luật này KHÔNG cho cát xuyên
  // qua Solid để tìm đường rơi.
  private slideRow(dst: Uint8Array, row: number, heldPassable: boolean): void {
    const { width } = this;
    let px = 0;
    while (px < width) {
      if (!this.passable(row + px, heldPassable)) { dst[row + px] = 0; px++; continue; }
      const runStart = px;
      while (px < width && this.passable(row + px, heldPassable)) px++;
      const runEnd = px - 1;
      let d = INT_MAX;
      for (let k = runStart; k <= runEnd; k++) {
        d = this.canDrop[k] !== 0 ? 0 : (d === INT_MAX ? INT_MAX : d + 1);
        this.dist[k] = d;
      }
      d = INT_MAX;
      for (let k = runEnd; k >= runStart; k--) {
        d = this.canDrop[k] !== 0 ? 0 : (d === INT_MAX ? INT_MAX : d + 1);
        if (d < this.dist[k]) this.dist[k] = d;
        dst[row + k] = this.dist[k] <= this.slideCells ? 1 : 0;
      }
    }
  }

  // Ô THÔNG (px,py) rơi THẲNG 1 hàng là thoát? Bản standalone của canDrop — isEligible gọi được NGOÀI lượt quét,
  // nơi canDrop đang giữ hàng khác.
  private dropsFrom(px: number, py: number): boolean {
    if (py === this.height - 1) return px >= this.exitMinPx && px <= this.exitMaxPx;
    return this.escape[(py + 1) * this.width + px] !== 0;
  }

  // HELD (px,py) đủ điều kiện convert? = rơi thẳng vào ô đã thoát, HOẶC trượt ngang ≤ slideCells ô (qua ô THÔNG)
  // rồi rơi, HOẶC nằm hàng đáy trong dải họng. KHÔNG có hướng LÊN — cát không trèo lên.
  private isEligible(px: number, py: number): boolean {
    if (py === this.height - 1) return px >= this.exitMinPx && px <= this.exitMaxPx;
    if (this.escape[(py + 1) * this.width + px] !== 0) return true;
    for (let dir = -1; dir <= 1; dir += 2) {
      for (let step = 1; step <= this.slideCells; step++) {
        const x = px + dir * step;
        if (!this.inBounds(x, py)) break;
        if (!this.passable(py * this.width + x, false)) break;   // trượt phải QUA ô thông, không xuyên tường
        if (this.dropsFrom(x, py)) return true;
      }
    }
    return false;
  }

  private checkFrontier(px: number, py: number): void {
    if (this.isEligible(px, py)) this.frontier.add(py * this.width + px);
  }

  // ==================================================================== helpers

  private inBounds(x: number, y: number): boolean {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  private occIndex(px: number, py: number): number {
    return ((py / this.occCellPixels) | 0) * this.occWidth + ((px / this.occCellPixels) | 0);
  }

  // Nới bbox bẩn ôm occ-cell vừa về 0 — consumeOccDirtyRect đọc + reset.
  private markOccDirty(ox: number, oy: number): void {
    if (ox < this.dirtyMinX) this.dirtyMinX = ox;
    if (oy < this.dirtyMinY) this.dirtyMinY = oy;
    if (ox > this.dirtyMaxX) this.dirtyMaxX = ox;
    if (oy > this.dirtyMaxY) this.dirtyMaxY = oy;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
