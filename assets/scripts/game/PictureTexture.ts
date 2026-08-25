// Lớp HÌNH của tranh: 1 Texture2D RGBA8 cỡ đúng lưới pixel VIEW. Solver làm việc trên lưới CƠ CHẾ, thô hơn.
// Đây là chỗ cài `eraseVisualCell` / `restoreVisualCell` của interface PictureHost.
//
// ⚠ HAI LƯỚI, ĐỪNG LẪN (số thật của Release Level 0001):
//   · lưới CƠ CHẾ  = pixelLevelData 200×200 — carve model, occupancy, hạt đều tính trên lưới này.
//   · lưới VIEW    = pixelViewData  400×400 — texture hiển thị.
//   -> viewScale = 400/200 = 2. MỘT ô cơ chế = khối 2×2 pixel view. Mọi hàm public dưới đây nhận toạ độ
//      CƠ CHẾ và tự tô cả khối (đúng ResolveViewScale() của PictureColliderBuilder bên Unity).
//   Trộn 2 lưới là lỗi im lặng: hình lệch đúng 2× mà code vẫn chạy.
//
// VÌ SAO 1 TEXTURE chứ không phải N sprite: 400×400 = 160 000 pixel. Mỗi ô 1 node/sprite là chết ngay trên
// webview. 1 texture = 1 draw call, cào ô = ghi vài byte.
//
// BA MỨC HIỂN THỊ của 1 ô (khớp nguồn Unity):
//   Solid  -> màu gốc, alpha gốc
//   Held   -> `dim()`  = alpha × 0.8 (DimCarvedVisual: đã thuộc quyền người chơi nhưng CHƯA tan)
//   Empty  -> `erase()` = alpha 0
//   revert Held->Solid -> `restore()` theo SÓNG NGƯỢC (swipeBatchRevertStyle = "WaveBack", 0.25s)

import { Texture2D, ImageAsset } from 'cc';

const RGBA_STRIDE = 4;
/** DimCarvedVisual bên Unity: ô đã cào nhưng chưa tan mờ còn 0.8 alpha. */
export const HELD_ALPHA_MUL = 0.8;

export class PictureTexture {
  /** Lưới VIEW (texture). */
  readonly viewWidth: number;
  readonly viewHeight: number;
  /** Lưới CƠ CHẾ (carve model). */
  readonly mechWidth: number;
  readonly mechHeight: number;
  /** viewWidth / mechWidth. Luôn >= 1, số nguyên. */
  readonly viewScale: number;

  readonly texture: Texture2D;

  /** Màu GỐC lưới view (không bao giờ đổi) — nguồn để restore. */
  private readonly base: Uint8Array;
  /** Màu ĐANG hiển thị. Upload lên GPU khi dirty. */
  private readonly live: Uint8Array;

  /** Ô CƠ CHẾ đang chờ sáng lại: mechIndex -> giây còn lại. Map vì số ô chờ nhỏ (1 túi vuốt). */
  private readonly pendingRestore = new Map<number, number>();

  private dirty = false;
  private readonly revertDuration: number;

  /**
   * @param colorsHex `pixelViewData.colors.items` — màu lưới VIEW, hàng-trước (vy × viewWidth + vx),
   *   dạng "#RRGGBB" / "#RRGGBBAA". Phần tử rỗng = pixel trống.
   */
  constructor(mechWidth: number, mechHeight: number, viewWidth: number, viewHeight: number,
              colorsHex: readonly string[], revertDuration: number) {
    this.mechWidth = mechWidth | 0;
    this.mechHeight = mechHeight | 0;
    this.viewWidth = viewWidth | 0;
    this.viewHeight = viewHeight | 0;
    this.revertDuration = revertDuration;

    const sx = Math.max(1, Math.round(this.viewWidth / this.mechWidth));
    const sy = Math.max(1, Math.round(this.viewHeight / this.mechHeight));
    // Nguồn dùng MỘT hệ số cho cả 2 trục (ResolveViewScale trả 1 số). Lệch 2 trục = data sai, lấy min để không
    // đọc ngoài biên, và đây là chỗ ĐÁNG nổ ở P6 nếu level khác có tỉ lệ lạ.
    this.viewScale = Math.min(sx, sy);

    const n = this.viewWidth * this.viewHeight;
    this.base = new Uint8Array(n * RGBA_STRIDE);
    this.live = new Uint8Array(n * RGBA_STRIDE);

    const count = Math.min(n, colorsHex.length);
    for (let i = 0; i < count; i++) writeHex(this.base, i * RGBA_STRIDE, colorsHex[i]);
    // colorsHex NGẮN hơn n: xảy ra thật với 6 level scroll bị cụt pixelViewData (__truncated ở IR). Phần thiếu để
    // alpha 0 thay vì bịa màu — thiếu hình thì thấy ngay, còn bịa thì lặng lẽ sai.
    this.live.set(this.base);

    const img = new ImageAsset({
      _data: this.live,
      width: this.viewWidth,
      height: this.viewHeight,
      format: Texture2D.PixelFormat.RGBA8888,
      _compressed: false,
    });
    this.texture = new Texture2D();
    this.texture.image = img;
    // Tranh là pixel-art: NEAREST, không mipmap. Bilinear làm mép ô cào nhoè thành nửa alpha.
    this.texture.setFilters(Texture2D.Filter.NEAREST, Texture2D.Filter.NEAREST);
    this.texture.setMipFilter(Texture2D.Filter.NONE);
    this.texture.setWrapMode(Texture2D.WrapMode.CLAMP_TO_EDGE, Texture2D.WrapMode.CLAMP_TO_EDGE);
  }

  /** (1/w, 1/h, w, h) lưới VIEW — đúng thứ tự uniform `mainTexTexelSize` của sand-surface.effect. */
  texelSize(): [number, number, number, number] {
    return [1 / this.viewWidth, 1 / this.viewHeight, this.viewWidth, this.viewHeight];
  }

  private inMech(px: number, py: number): boolean {
    return px >= 0 && py >= 0 && px < this.mechWidth && py < this.mechHeight;
  }

  /** Áp `fn` lên từng pixel VIEW của khối thuộc ô CƠ CHẾ (px,py). */
  private forBlock(px: number, py: number, fn: (off: number) => void): void {
    if (!this.inMech(px, py)) return;
    const s = this.viewScale;
    const vx0 = px * s, vy0 = py * s;
    for (let dy = 0; dy < s; dy++) {
      const row = (vy0 + dy) * this.viewWidth;
      if (vy0 + dy >= this.viewHeight) break;
      for (let dx = 0; dx < s; dx++) {
        const vx = vx0 + dx;
        if (vx >= this.viewWidth) break;
        fn((row + vx) * RGBA_STRIDE);
      }
    }
    this.dirty = true;
  }

  /** Solid -> Held: mờ còn HELD_ALPHA_MUL alpha GỐC (không phải alpha hiện tại — gọi 2 lần không mờ gấp đôi). */
  dim(px: number, py: number): void {
    const b = this.base;
    this.forBlock(px, py, (o) => {
      this.live[o] = b[o];
      this.live[o + 1] = b[o + 1];
      this.live[o + 2] = b[o + 2];
      this.live[o + 3] = (b[o + 3] * HELD_ALPHA_MUL) | 0;
    });
    this.pendingRestore.delete(py * this.mechWidth + px);
  }

  /** Held -> Empty: ô tan, tắt alpha. */
  erase(px: number, py: number): void {
    this.forBlock(px, py, (o) => { this.live[o + 3] = 0; });
    this.pendingRestore.delete(py * this.mechWidth + px);
  }

  /**
   * Held -> Solid (bỏ cuộc): xếp lịch sáng lại theo SÓNG NGƯỢC hướng vuốt.
   * `orderT` ∈ [0,1] = vị trí ô trong thứ tự drain -> ô cào SAU sáng TRƯỚC: delay = (1 − orderT) × duration.
   */
  restore(px: number, py: number, orderT: number): void {
    if (!this.inMech(px, py)) return;
    const t = orderT < 0 ? 0 : orderT > 1 ? 1 : orderT;
    const delay = (1 - t) * this.revertDuration;
    if (delay <= 0) { this.applyRestore(px, py); return; }
    this.pendingRestore.set(py * this.mechWidth + px, delay);
  }

  private applyRestore(px: number, py: number): void {
    const b = this.base;
    this.forBlock(px, py, (o) => {
      this.live[o] = b[o];
      this.live[o + 1] = b[o + 1];
      this.live[o + 2] = b[o + 2];
      this.live[o + 3] = b[o + 3];
    });
  }

  /** Gọi mỗi frame. Đẩy hàng chờ sáng + upload nếu có đổi. */
  update(dt: number): void {
    if (this.pendingRestore.size > 0) {
      // Xoá trong lúc duyệt Map là hợp lệ ở JS (entry đã duyệt không quay lại) -> không cần mảng phụ.
      for (const [i, remain] of this.pendingRestore) {
        const left = remain - dt;
        if (left <= 0) {
          this.applyRestore(i % this.mechWidth, (i / this.mechWidth) | 0);
          this.pendingRestore.delete(i);
        } else {
          this.pendingRestore.set(i, left);
        }
      }
    }
    if (this.dirty) {
      // TODO P6-perf: upload TRỌN 400×400×4 = 640 KB mỗi frame-dirty. Nếu P6 đo thấy đây là điểm nóng thì đổi
      // sang copyBuffersToTexture theo dirty-rect (carve model đã có consumeOccDirtyRect để lấy rect).
      this.texture.uploadData(this.live);
      this.dirty = false;
    }
  }

  /** Reset về tranh nguyên vẹn — dùng khi ScenarioRunner replay. */
  resetAll(): void {
    this.live.set(this.base);
    this.pendingRestore.clear();
    this.dirty = true;
  }

  /**
   * Màu GỐC của ô CƠ CHẾ (đọc pixel view đầu khối) -> hạt mang màu ô nó sinh ra.
   * Trả 0..1 để nhồi thẳng vào vertex color.
   */
  baseColorInto(px: number, py: number, out: { r: number; g: number; b: number; a: number }): void {
    if (!this.inMech(px, py)) { out.r = out.g = out.b = out.a = 0; return; }
    const s = this.viewScale;
    const o = ((py * s) * this.viewWidth + px * s) * RGBA_STRIDE;
    out.r = this.base[o] / 255;
    out.g = this.base[o + 1] / 255;
    out.b = this.base[o + 2] / 255;
    out.a = this.base[o + 3] / 255;
  }

  /** CHẨN ĐOÁN (StaticProbe.PixelProbe): alpha LỚN NHẤT đang hiển thị trong khối view của ô cơ chế. -1 = ngoài biên. */
  liveAlphaAt(px: number, py: number): number {
    if (!this.inMech(px, py)) return -1;
    const s = this.viewScale;
    let a = 0;
    for (let dy = 0; dy < s; dy++) {
      const vy = py * s + dy;
      if (vy >= this.viewHeight) break;
      for (let dx = 0; dx < s; dx++) {
        const vx = px * s + dx;
        if (vx >= this.viewWidth) break;
        const v = this.live[(vy * this.viewWidth + vx) * RGBA_STRIDE + 3];
        if (v > a) a = v;
      }
    }
    return a;
  }

  /** CHẨN ĐOÁN: alpha GỐC (pixel đầu khối) của ô cơ chế. -1 = ngoài biên. */
  baseAlphaAt(px: number, py: number): number {
    if (!this.inMech(px, py)) return -1;
    const s = this.viewScale;
    return this.base[((py * s) * this.viewWidth + px * s) * RGBA_STRIDE + 3];
  }
}

/** "#RRGGBB" hoặc "#RRGGBBAA" (chấp cả không dấu #) -> ghi 4 byte. Chuỗi lạ = pixel trống, KHÔNG throw. */
function writeHex(dst: Uint8Array, off: number, hex: string | null | undefined): void {
  if (!hex) return;
  const s = hex.charCodeAt(0) === 35 ? hex.slice(1) : hex;
  if (s.length !== 6 && s.length !== 8) return;
  const v = parseInt(s, 16);
  if (!Number.isFinite(v)) return;
  if (s.length === 6) {
    dst[off] = (v >>> 16) & 0xff;
    dst[off + 1] = (v >>> 8) & 0xff;
    dst[off + 2] = v & 0xff;
    dst[off + 3] = 255;
  } else {
    dst[off] = (v >>> 24) & 0xff;
    dst[off + 1] = (v >>> 16) & 0xff;
    dst[off + 2] = (v >>> 8) & 0xff;
    dst[off + 3] = v & 0xff;
  }
}
