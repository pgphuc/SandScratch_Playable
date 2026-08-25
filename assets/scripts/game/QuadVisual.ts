// Quad world-space tô 1 màu — dùng cho phần TRANG TRÍ/PLACEHOLDER: thân lọ, nút CTA, chấm hand-hint.
//
// Vì sao không Sprite/Graphics: cả cảnh chạy pipeline 3D (MeshRenderer + camera ortho). Thêm Canvas + camera UI
// chỉ để vẽ vài hình chữ nhật là thêm 1 render pass và 1 hệ toạ độ thứ hai phải đồng bộ.
//
// Vì sao `effectName` chứ không phải asset: `builtin-unlit` nằm sẵn trong engine registry, tra theo TÊN nên
// KHÔNG cần uuid nào cả — đúng luật "không bịa uuid" của docs/cocos-conventions.md.
//
// ⚠ ĐÂY LÀ PLACEHOLDER. Nút CTA thật là 1 PNG ĐÃ IN SẴN CHỮ ("PLAY NOW", art PENDING_USER trong scenario.json);
// lọ thật cần model/atlas từ Unity. Thay art sau chỉ cần set `texture` — không phải sửa layout.

import { Color, Material, Mesh, MeshRenderer, Node, Texture2D, primitives, utils } from 'cc';

let unlitOpaque: Material | null = null;
let unlitTransparent: Material | null = null;

function baseMaterial(transparent: boolean): Material {
  const cached = transparent ? unlitTransparent : unlitOpaque;
  if (cached !== null) return cached;
  const m = new Material();
  // builtin-unlit: technique 0 = opaque, 1 = transparent.
  m.initialize({ effectName: 'builtin-unlit', technique: transparent ? 1 : 0 });
  if (transparent) unlitTransparent = m; else unlitOpaque = m;
  return m;
}

function quadMesh(w: number, h: number): Mesh {
  const hx = w * 0.5, hy = h * 0.5;
  const geom: primitives.IGeometry = {
    positions: [-hx, -hy, 0, hx, -hy, 0, hx, hy, 0, -hx, hy, 0],
    uvs: [0, 1, 1, 1, 1, 0, 0, 0],
    indices: [0, 1, 2, 0, 2, 3],
    minPos: { x: -hx, y: -hy, z: 0 },
    maxPos: { x: hx, y: hy, z: 0 },
  };
  return utils.MeshUtils.createMesh(geom);
}

/** Mesh cầu bán kính 0.5 dùng chung — caller scale node để ra cỡ mong muốn. */
let sphere05: Mesh | null = null;

/**
 * Gắn 1 hình CẦU đường kính `d` (world) vào `node`, tô `color` phẳng (unlit).
 *
 * Dùng cho hạt visual bay vào lọ: nguồn `JarGrainVisual.cs` cho prefab là "1 GO + Renderer — SpriteRenderer
 * HOẶC MeshRenderer sphere", và dặn thẳng "mesh sphere phải dùng material UNLIT để màu PHẲNG như cát (material
 * lit bị ánh sáng scene làm lệch màu)" — đúng cảnh này: unlit + ortho + không đèn.
 *
 * segments = 8: hạt bay to cỡ 0.4 world trong 0.38s, thêm mặt chỉ tốn vertex chứ mắt không đọc ra.
 */
export function attachSphere(node: Node, d: number, color: Color): MeshRenderer {
  if (sphere05 === null) sphere05 = utils.MeshUtils.createMesh(primitives.sphere(0.5, { segments: 8 }));
  const mr = node.getComponent(MeshRenderer) ?? node.addComponent(MeshRenderer)!;
  mr.mesh = sphere05;
  mr.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
  mr.receiveShadow = MeshRenderer.ShadowReceivingMode.OFF;
  // OPAQUE: hạt cát đục, và pass opaque ghi depth nên hạt che nhau đúng mà không phải sort.
  mr.material = baseMaterial(false);
  mr.getMaterialInstance(0)?.setProperty('mainColor', color);
  node.setScale(d, d, d);
  return mr;
}

/**
 * Gắn 1 quad `w × h` (world) vào `node`, tô `color`. `texture` != null -> nhân thêm texture.
 * Trả về MeshRenderer để caller đổi màu/texture sau.
 */
export function attachQuad(node: Node, w: number, h: number, color: Color,
                           texture: Texture2D | null = null, transparent = true): MeshRenderer {
  const mr = node.getComponent(MeshRenderer) ?? node.addComponent(MeshRenderer)!;
  mr.mesh = quadMesh(w, h);
  mr.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
  mr.receiveShadow = MeshRenderer.ShadowReceivingMode.OFF;
  mr.material = baseMaterial(transparent);

  const mi = mr.getMaterialInstance(0);
  if (mi !== null) {
    if (texture !== null) {
      mi.recompileShaders({ USE_TEXTURE: true });
      mi.setProperty('mainTexture', texture);
    }
    mi.setProperty('mainColor', color);
  }
  return mr;
}
