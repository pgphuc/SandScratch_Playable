// THÂN LỌ = mesh hộp thật (SKM_Box) thay cho quad màu placeholder của QuadVisual.
//
// VÌ SAO PHẢI LÀ MESH, không phải sprite: ảnh màu trong `72_Box_Color/<HEX>.png` là ATLAS UV của mesh hộp
// (các mảng panel/viền rời nhau), KHÔNG phải ảnh chụp cái hộp. Dán atlas đó lên quad ra một mớ hình chữ nhật.
//
// MAPPING MÀU (nguồn: !_/Utils/U_Util/Features/GameEnums.cs §GameObjectColorPalette): tên file texture CHÍNH LÀ
// mã hex của GameObjectColor. Level 0001 dùng 3 màu lọ -> Yellow5=FF9900 · Neutral1=F2EDE6 · Neutral8=2E2722.
// Thêm màu = thả thêm PNG cùng tên hex vào assets/resources/box/, KHÔNG phải sửa mã.
//
// ⚠ CHƯA PORT: 4 animation clip của SKM_Box (Idle · Fill · Close · Open_box) và lớp outline/glow HighlightPlus
// (middleware đã DROP). Ở đây hộp đứng YÊN ở bind pose. Tween punch khi hút hạt vẫn là của ColorJar, không đổi.
//
// VÌ SAO material tự dựng chứ không dùng M_Box_Xam.001 của fbx: cả cảnh chạy unlit + camera ortho, không có đèn.
// Material PBR của fbx trong cảnh không đèn sẽ ra đen. `builtin-unlit` tra theo TÊN nên không cần uuid nào.

import { Material, Mesh, MeshRenderer, Node, Prefab, SkinnedMeshRenderer, Texture2D, Vec3, instantiate } from 'cc';
import type { BoxTuning } from './BoardVisual';

/** Material unlit dùng chung cho mọi hộp — 1 instance/màu do getMaterialInstance tách ra. */
let unlitBox: Material | null = null;
function boxMaterial(): Material {
  if (unlitBox !== null) return unlitBox;
  const m = new Material();
  m.initialize({ effectName: 'builtin-unlit', technique: 0 });
  unlitBox = m;
  return m;
}

/** AABB gộp của mọi mesh trong cây, lấy từ mesh.struct (có NGAY, không phải đợi frame như model.worldBounds). */
function localBounds(root: Node, outMin: Vec3, outMax: Vec3): boolean {
  let any = false;
  const walk = (n: Node): void => {
    const mr = n.getComponent(MeshRenderer) ?? n.getComponent(SkinnedMeshRenderer);
    const mesh: Mesh | null = mr !== null ? mr.mesh : null;
    if (mesh !== null && mesh.struct.minPosition !== undefined && mesh.struct.maxPosition !== undefined) {
      const mn = mesh.struct.minPosition, mx = mesh.struct.maxPosition;
      if (!any) { outMin.set(mn.x, mn.y, mn.z); outMax.set(mx.x, mx.y, mx.z); any = true; }
      else {
        outMin.set(Math.min(outMin.x, mn.x), Math.min(outMin.y, mn.y), Math.min(outMin.z, mn.z));
        outMax.set(Math.max(outMax.x, mx.x), Math.max(outMax.y, mx.y), Math.max(outMax.z, mx.z));
      }
    }
    for (const c of n.children) walk(c);
  };
  walk(root);
  return any;
}

const _min = new Vec3();
const _max = new Vec3();

/**
 * Gắn 1 hộp vào `node`, tô bằng `tex`, co cho vừa khung `t.w × t.h` (world) và đặt tâm hộp trùng tâm node.
 * Mọi số hình học lấy từ `t` = khối "box" trong assets/resources/data/board-layout.txt (chỉnh tay được).
 * @returns node hộp vừa tạo, hoặc null nếu prefab không dựng được (caller rơi về quad màu).
 */
export function attachBox(node: Node, prefab: Prefab, tex: Texture2D | null, t: BoxTuning): Node | null {
  const box = instantiate(prefab);
  if (box === null) return null;
  box.name = 'BoxMesh';
  box.setParent(node);

  // --- vật liệu: unlit + atlas màu ---
  const paint = (n: Node): void => {
    const mr = n.getComponent(MeshRenderer) ?? n.getComponent(SkinnedMeshRenderer);
    if (mr !== null) {
      mr.material = boxMaterial();
      mr.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
      mr.receiveShadow = MeshRenderer.ShadowReceivingMode.OFF;
      const mi = mr.getMaterialInstance(0);
      if (mi !== null && tex !== null) {
        mi.recompileShaders({ USE_TEXTURE: true });
        mi.setProperty('mainTexture', tex);
      }
    }
    for (const c of n.children) paint(c);
  };
  paint(box);

  // --- xoay TRƯỚC khi đo: mesh gốc dựng cho camera 3D của Unity, xoay xong thì bề ngang/cao mới là cái cần fit ---
  box.setRotationFromEuler(t.rotX, t.rotY, t.rotZ);

  // --- co cho vừa khung lọ: 1 hệ số ĐỀU cho cả 3 trục, không bóp méo hộp ---
  if (localBounds(box, _min, _max)) {
    const bw = _max.x - _min.x, bh = _max.y - _min.y;
    if (bw > 1e-6 && bh > 1e-6) {
      const s = Math.min(t.w / bw, t.h / bh) * (t.scale > 0 ? t.scale : 1);
      box.setScale(s, s, s);
      // Tâm AABB thường KHÔNG ở gốc mesh (hộp dựng đứng từ mặt đáy) -> kéo về cho tâm trùng tâm node.
      box.setPosition(-(_min.x + _max.x) * 0.5 * s + t.dx, -(_min.y + _max.y) * 0.5 * s + t.dy, 0);
    }
  }
  return box;
}

/** Tên file atlas của 1 màu lọ: hex 6 ký tự HOA, khớp GameObjectColorPalette. */
export function boxTextureName(hex: number): string {
  let s = (hex >>> 0).toString(16).toUpperCase();
  while (s.length < 6) s = '0' + s;
  return s;
}
