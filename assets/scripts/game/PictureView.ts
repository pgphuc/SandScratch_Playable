// A3 — VẼ TRANH RA MÀN HÌNH. Trước file này, `PictureTexture` dựng đúng Texture2D nhưng KHÔNG ai bind nó vào
// material, cũng không ai set `mainTexTexelSize` -> chạy ad ra màn hình trống.
//
// 1 quad world-space + material `sand-surface.effect`. Không dùng Sprite/UI: cả cảnh chạy ở pipeline 3D
// (MeshRenderer + camera ortho), trộn 2 pipeline chỉ để vẽ 1 hình chữ nhật là thêm 1 camera + 1 canvas vô ích.
//
// UV — chốt ở đây, đừng đoán lại:
//   `PictureTexture` xếp dữ liệu hàng-trước với hàng 0 = ĐỈNH tranh (py = 0 là đỉnh, hợp đồng của PictureMap).
//   Cocos upload buffer thẳng qua texImage2D, KHÔNG lật Y -> hàng 0 nằm ở v = 0.
//   => đỉnh TRÊN của quad phải mang v = 0, đỉnh DƯỚI mang v = 1. Đó là lý do uv dựng tay chứ không xài
//   `primitives.quad()` (quad builtin cho v = 0 ở ĐÁY, tranh sẽ lộn ngược mà không có gì báo).

import { Component, Material, Mesh, MeshRenderer, Texture2D, Vec4, primitives, utils, _decorator } from 'cc';

const { ccclass, property } = _decorator;

@ccclass('PictureView')
export class PictureView extends Component {
  @property({ type: Material, tooltip: 'material dùng sand-surface.effect' })
  pictureMaterial: Material | null = null;

  private renderer: MeshRenderer | null = null;
  private mesh: Mesh | null = null;

  /**
   * Dựng quad phủ đúng bounds world của tranh rồi bind texture.
   *
   * @param bounds mép NGOÀI pixel (PictureMap.worldBounds()), không phải tâm pixel.
   * @param texelSize (1/w, 1/h, w, h) của lưới VIEW — bắt buộc, shader dò bóng theo texel nên sai số này là
   *        bóng lệch/nhoè chứ không phải lỗi thấy ngay.
   */
  build(bounds: { minX: number; maxX: number; minY: number; maxY: number },
        texture: Texture2D, texelSize: [number, number, number, number]): void {
    const w = bounds.maxX - bounds.minX;
    const h = bounds.maxY - bounds.minY;
    // Node đặt ở TÂM tranh; quad dựng quanh gốc để scale/di chuyển node sau này không phải dựng lại mesh.
    this.node.setWorldPosition((bounds.minX + bounds.maxX) * 0.5, (bounds.minY + bounds.maxY) * 0.5, 0);

    const hx = w * 0.5, hy = h * 0.5;
    const geom: primitives.IGeometry = {
      positions: [
        -hx, -hy, 0,
        hx, -hy, 0,
        hx, hy, 0,
        -hx, hy, 0,
      ],
      uvs: [
        0, 1,   // dưới-trái  -> hàng CUỐI của texture
        1, 1,
        1, 0,   // trên-phải  -> hàng 0 = đỉnh tranh
        0, 0,
      ],
      indices: [0, 1, 2, 0, 2, 3],
      minPos: { x: -hx, y: -hy, z: 0 },
      maxPos: { x: hx, y: hy, z: 0 },
    };
    this.mesh = utils.MeshUtils.createMesh(geom);

    this.renderer = this.getComponent(MeshRenderer) ?? this.addComponent(MeshRenderer)!;
    this.renderer.mesh = this.mesh;
    this.renderer.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
    this.renderer.receiveShadow = MeshRenderer.ShadowReceivingMode.OFF;

    if (this.pictureMaterial === null) {
      console.warn('[PictureView] thiếu material sand-surface — tranh sẽ không hiện.');
      return;
    }
    this.renderer.material = this.pictureMaterial;
    // Ghi qua materialInstance: renderer.material trả về asset DÙNG CHUNG, set property trên đó là sửa asset
    // trong bundle (dính sang mọi renderer khác dùng cùng material).
    const mi = this.renderer.getMaterialInstance(0);
    if (mi === null) return;
    mi.setProperty('mainTexture', texture);
    mi.setProperty('mainTexTexelSize', new Vec4(texelSize[0], texelSize[1], texelSize[2], texelSize[3]));
  }
}
