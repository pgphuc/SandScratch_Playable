// Ánh xạ TOẠ ĐỘ giữa lưới pixel tranh và world Cocos. Đây là cái duy nhất biết cả hai bên, nên mọi chỗ khác
// (host, renderer, occupancy) đọc qua đây — không ai tự nhân pixelSize.
//
// HỆ QUY CHIẾU (chốt ở đây, mọi file khác tuân theo):
//  · Tranh là lưới `width × height` pixel, gốc (0,0) = pixel TRÊN-TRÁI.
//  · +px  -> +X world.  +py -> −Y world (py TĂNG là XUÔI trọng lực, đúng hợp đồng `pictureDownWorldDir`).
//  · Gravity = (0, grainGravityY) với grainGravityY < 0 -> hướng xuôi world = (0,−1). Khớp py.
//  · Toạ độ cell là FLOAT: (0,0) = TÂM pixel trên-trái. Front truyền x.5 (tâm occ-cell) và bottomRow+1 (ghost
//    release) nên KHÔNG được làm tròn ở đây — xem cảnh báo trong interface PictureHost.
//
// Cocos 3.x cũng Y-up như Unity nên trục không đổi dấu; chỉ khác gốc/scale, quy về 2 số originWorld + pixelSize.

import { v2, type V2 } from '../solver/sdfWalls';
import type { GrainOccupancyField } from '../solver/occupancy';

export class PictureMap {
  readonly width: number;
  readonly height: number;
  /** Cỡ 1 pixel tranh theo world. */
  readonly pixelSize: number;
  /** World của TÂM pixel (0,0). */
  readonly originX: number;
  readonly originY: number;

  constructor(width: number, height: number, pixelSize: number, originX: number, originY: number) {
    this.width = width | 0;
    this.height = height | 0;
    this.pixelSize = pixelSize;
    this.originX = originX;
    this.originY = originY;
  }

  /**
   * Dựng map sao cho tranh nằm GIỮA một khung world cho trước, fit theo chiều chật hơn.
   * `viewportRows` < height (level scroll) -> fit theo số hàng NHÌN THẤY, không phải toàn tranh, nếu không tranh
   * scroll sẽ bị thu nhỏ vô cớ.
   */
  static fitCentered(width: number, height: number, frameWidth: number, frameHeight: number,
                     centerX: number, centerY: number, viewportRows: number): PictureMap {
    const rows = viewportRows > 0 && viewportRows < height ? viewportRows : height;
    const pixelSize = Math.min(frameWidth / width, frameHeight / rows);
    // Tâm khung nằm giữa dải [0..rows) -> lùi nửa dải lên trên, rồi lùi nửa pixel để về TÂM pixel (0,0).
    const originX = centerX - (width - 1) * 0.5 * pixelSize;
    const originY = centerY + (rows - 1) * 0.5 * pixelSize;
    return new PictureMap(width, height, pixelSize, originX, originY);
  }

  cellToWorld(cx: number, cy: number, out: V2): V2 {
    out.x = this.originX + cx * this.pixelSize;
    out.y = this.originY - cy * this.pixelSize;
    return out;
  }

  /** Nghịch đảo cellToWorld. Trả cell FLOAT (chưa floor) — caller tự quyết làm tròn. */
  worldToCell(wx: number, wy: number, out: V2): V2 {
    out.x = (wx - this.originX) / this.pixelSize;
    out.y = (this.originY - wy) / this.pixelSize;
    return out;
  }

  downWorldDir(out: V2): V2 {
    out.x = 0;
    out.y = -1;
    return out;
  }

  /** Bounds world của TOÀN tranh (mép ngoài pixel, không phải tâm) — dùng dựng quad hiển thị. */
  worldBounds(): { minX: number; maxX: number; minY: number; maxY: number } {
    const h = this.pixelSize * 0.5;
    return {
      minX: this.originX - h,
      maxX: this.originX + (this.width - 1) * this.pixelSize + h,
      minY: this.originY - (this.height - 1) * this.pixelSize - h,
      maxY: this.originY + h,
    };
  }

  /**
   * Dựng GrainOccupancyField khớp map này. `occCellPixels` LUÔN 1 ở đường Grain (nguồn ép fine per-pixel —
   * xem comment trong occupancy.ts), nên occWidth/occHeight = pictureWidth/Height.
   *
   * 2 hàng invRow là affine NGHỊCH: px = dot(invRow0, p − worldOrigin), py = dot(invRow1, p − worldOrigin).
   * Với map trục-thẳng: invRow0 = (1/s, 0), invRow1 = (0, −1/s).
   */
  makeOccupancyField(tuning: {
    pushStrength: number; maxStep: number; smoothRadius: number; dilateCells: number;
    ejectSearchCells: number; creepWindow: number; creepSpeed: number; creepSlopeMin: number;
    creepLateralMax: number;
  }, colCount: number, viewportRows: number): GrainOccupancyField {
    const inv = 1 / this.pixelSize;
    const k = Math.max(1, Math.min(4, colCount | 0));
    return {
      worldOriginX: this.originX,
      worldOriginY: this.originY,
      invRow0X: inv, invRow0Y: 0,
      invRow1X: 0, invRow1Y: -inv,
      pxAxisWorldX: 1, pxAxisWorldY: 0,
      pyAxisWorldX: 0, pyAxisWorldY: -1,

      occWidth: this.width,
      occHeight: this.height,
      occCellPixels: 1,
      pictureWidth: this.width,
      pictureHeight: this.height,

      pushStrength: tuning.pushStrength,
      maxStep: tuning.maxStep,
      smoothRadius: tuning.smoothRadius,
      dilateCells: tuning.dilateCells,
      // Seal mép X: 0 = KHÔNG seal = bit-identical với nguồn trước feature này. Không bật khi chưa có số parity.
      edgeApronCells: 0,
      ejectSearchCells: tuning.ejectSearchCells,

      creepWindow: tuning.creepWindow,
      creepSpeed: tuning.creepSpeed,
      creepSlopeMin: tuning.creepSlopeMin,
      creepLateralMax: tuning.creepLateralMax,

      colScrollPy: new Float32Array(4),
      colCount: k,
      colWidthPx: this.width / k,
      viewportRows: viewportRows > 0 ? viewportRows : this.height,
    };
  }
}

/** Buffer V2 tái dùng cho code gọi trong vòng update — tránh cấp phát per-frame. */
export const TMP_A: V2 = v2();
export const TMP_B: V2 = v2();
