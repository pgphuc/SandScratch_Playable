// THÂN LỌ = mesh hộp thật (SKM_Box) thay cho quad màu placeholder của QuadVisual.
//
// VÌ SAO PHẢI LÀ MESH, không phải sprite: ảnh màu trong `72_Box_Color/<HEX>.png` là ATLAS UV của mesh hộp
// (các mảng panel/viền rời nhau), KHÔNG phải ảnh chụp cái hộp. Dán atlas đó lên quad ra một mớ hình chữ nhật.
//
// MAPPING MÀU (nguồn: !_/Utils/U_Util/Features/GameEnums.cs §GameObjectColorPalette): tên file texture CHÍNH LÀ
// mã hex của GameObjectColor. Level 0001 dùng 3 màu lọ -> Yellow5=FF9900 · Neutral1=F2EDE6 · Neutral8=2E2722.
// Thêm màu = thả thêm PNG cùng tên hex vào assets/resources/box/, KHÔNG phải sửa mã.
//
// ANIM: 4 clip (Idle · Fill · Close · Open_box) do game/BoxAnim.ts bấm — file này chỉ DỰNG hộp, không phát gì.
// ⚠ CHƯA PORT: outline/glow HighlightPlus (middleware đã DROP). Tween punch khi hút hạt vẫn là của ColorJar.
//
// VÌ SAO material tự dựng chứ không dùng M_Box_Xam.001 của fbx: cả cảnh chạy unlit + camera ortho, không có đèn.
// Material PBR của fbx trong cảnh không đèn sẽ ra đen. `builtin-unlit` tra theo TÊN nên không cần uuid nào.

import {
  Mat4, Material, Mesh, MeshRenderer, Node, Prefab, SkinnedMeshRenderer, Texture2D, Vec3, instantiate,
} from 'cc';
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

const _min = new Vec3();
const _max = new Vec3();
const _c = new Vec3();
const _m = new Mat4();
const _inv = new Mat4();

/**
 * AABB gộp của mọi mesh trong cây, ĐO TRONG HỆ CỦA `parent` — tức đã tính cả transform của node con LẪN
 * xoay/zScale đang đặt trên `root`. Nguồn số vẫn là mesh.struct (có NGAY, không phải đợi 1 frame như
 * model.worldBounds).
 *
 * ⚠ BẢN TRƯỚC ĐO SAI: nó gộp thẳng mesh.struct.min/max của từng mesh, tức đo TRONG HỆ CỦA MESH — xoay node gốc
 * bao nhiêu độ thì con số cũng không đổi. Hậu quả thật (user báo 2026-08-25): rotX=45 làm hộp dày thêm ~1.8
 * world theo trục Z mà phép fit không hề biết, mặt trước bị ghim sai và ĐUÔI hộp thò về sau tới z ≈ -1.6, chui
 * ra sau art nền (bg_ipad z=-1.2) nên ruột hộp bị nền xanh che.
 * Ở đây lấy world matrix từng node mesh nhân với nghịch đảo world matrix của parent -> ma trận "mesh -> hệ lọ",
 * rồi biến đổi ĐỦ 8 GÓC của AABB mới gộp. Xoay bao nhiêu cũng đo đúng.
 */
function boundsInParent(root: Node, parent: Node, outMin: Vec3, outMax: Vec3): boolean {
  let any = false;
  Mat4.invert(_inv, parent.getWorldMatrix());
  const walk = (n: Node): void => {
    const mr = n.getComponent(MeshRenderer) ?? n.getComponent(SkinnedMeshRenderer);
    const mesh: Mesh | null = mr !== null ? mr.mesh : null;
    if (mesh !== null && mesh.struct.minPosition !== undefined && mesh.struct.maxPosition !== undefined) {
      const mn = mesh.struct.minPosition, mx = mesh.struct.maxPosition;
      Mat4.multiply(_m, _inv, n.getWorldMatrix());
      for (let i = 0; i < 8; i++) {
        _c.set((i & 1) !== 0 ? mx.x : mn.x, (i & 2) !== 0 ? mx.y : mn.y, (i & 4) !== 0 ? mx.z : mn.z);
        Vec3.transformMat4(_c, _c, _m);
        if (!any) { outMin.set(_c); outMax.set(_c); any = true; }
        else {
          outMin.set(Math.min(outMin.x, _c.x), Math.min(outMin.y, _c.y), Math.min(outMin.z, _c.z));
          outMax.set(Math.max(outMax.x, _c.x), Math.max(outMax.y, _c.y), Math.max(outMax.z, _c.z));
        }
      }
    }
    for (const c of n.children) walk(c);
  };
  walk(root);
  return any;
}

/** Số đo hộp SAU khi fit — AdRoot in ra boot log để biết phải đẩy art nền ra sau tới z nào. */
export interface BoxFitInfo {
  /** Bề dày hộp theo trục Z (world). */
  depth: number;
  /** z của MẶT SAU hộp trong hệ lọ (âm = lùi về sau node lọ). Art nền phải nằm SAU số này. */
  backLocalZ: number;
}
let lastFit: BoxFitInfo = { depth: 0, backLocalZ: 0 };
/** Số đo của hộp gắn gần nhất. Mọi hộp dùng chung 1 khối tuning nên 1 mẫu là đủ. */
export function lastBoxFit(): BoxFitInfo { return lastFit; }

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

  // --- ĐO ở đúng tư thế cuối, chỉ thiếu hệ số phóng đều ---
  //
  // Node Cocos xếp world = T · R · S, tức S áp TRƯỚC R. Nên muốn đo đúng thì phải đặt sẵn zScale (phần KHÔNG
  // đều của S) rồi mới đo, còn phần đều `s` thì nhân vào sau — nhân số đo với `s` là chính xác, vì
  // R · (s·diag(1,1,zScale)) = s · (R · diag(1,1,zScale)).
  const zs = t.zScale > 0 ? t.zScale : 1;
  box.setPosition(0, 0, 0);
  box.setRotationFromEuler(t.rotX, t.rotY, t.rotZ);
  box.setScale(1, 1, zs);

  if (boundsInParent(box, node, _min, _max)) {
    const bw = _max.x - _min.x, bh = _max.y - _min.y;
    if (bw > 1e-6 && bh > 1e-6) {
      // co cho vừa khung lọ: 1 hệ số ĐỀU cho X/Y, không bóp méo mặt hộp
      const s = Math.min(t.w / bw, t.h / bh) * (t.scale > 0 ? t.scale : 1);
      box.setScale(s, s, s * zs);
      // MẶT TRƯỚC hộp ghim đúng z của node (cộng t.dz), phần dày còn lại đổ về PHÍA SAU.
      //
      // Vì sao không để tâm hộp trùng z node như X/Y: đây là mesh 3D có bề dày, đặt tâm ở z node thì nửa trước
      // thò lên trước ~1 world — vượt cả Z_CTA (1.0) nên hộp che mất nút CTA (bug user báo 2026-08-24). Lớp z
      // của ad là mặt phẳng 2D xếp chồng, nên vật 3D phải tự khai "mặt trước tôi ở đâu" chứ không dày ra 2 phía.
      box.setPosition(
        -(_min.x + _max.x) * 0.5 * s + t.dx,
        -(_min.y + _max.y) * 0.5 * s + t.dy,
        -_max.z * s + t.dz,
      );
      lastFit = { depth: (_max.z - _min.z) * s, backLocalZ: (_min.z - _max.z) * s + t.dz };
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
