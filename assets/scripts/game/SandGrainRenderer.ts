// Renderer hạt cát: MỘT dynamic mesh gộp = MỘT draw call cho toàn bộ ~6000 hạt.
//
// VÌ SAO KHÔNG instancing / KHÔNG 1 node mỗi hạt: bản Unity dùng GPU instancing (UNITY_INSTANCING) — trên webview
// bị throttle thì instancing per-grain vẫn tốn 1 draw call/batch nhỏ và Cocos không có đường instancing tiện cho
// pool động. `docs/cocos-conventions.md` chốt: "Solver dạng hạt: 1 dynamic mesh gộp (1 draw call)".
//
// HỢP ĐỒNG ATTRIBUTE (khớp CHÍNH XÁC grain-instanced-3d.effect sau khi sửa ở P4b):
//   a_position  vec3  = TÂM hạt (world), GIỐNG NHAU cho cả 4 đỉnh của quad. Kiêm luôn seed Hash13 — đúng vai trò
//                       cột dịch chuyển của UNITY_MATRIX_M bên Unity, nên jitter sáng/tối + tilt normal khớp nguồn.
//   a_texCoord  vec2  = góc quad ±1 (mask tròn + normal bán cầu). HẰNG SỐ -> dựng 1 lần, không ghi lại mỗi frame.
//   a_texCoord1 vec2  = (radius world, 0). Shader nhân grainScale vào đây -> grainScale vẫn là knob material LIVE.
//   a_color     vec4  = màu per-hạt (thay UNITY_INSTANCING _Color).
//
// ⚠ Vì `a_position` là tâm chứ không phải góc quad, mesh KHÔNG có hình nếu quên `a_texCoord1` — 4 đỉnh trùng nhau
//   thành tam giác suy biến. Đó là lý do radius nằm ở attribute chứ không phải uniform.
//
// KHÔNG CẤP PHÁT trong vòng update: mọi buffer cấp 1 lần theo capacity; view subarray chỉ dựng lại khi `count` ĐỔI.

import { Component, Mesh, MeshRenderer, Material, utils, gfx, primitives, _decorator } from 'cc';
import type { GrainParticlePool } from '../solver/pool';

const { ccclass, property } = _decorator;

const VERTS_PER_QUAD = 4;
const INDICES_PER_QUAD = 6;
/** Uint16 index -> trần 65535 đỉnh = 16383 hạt. Pool cap của ad này (~6256) nằm dưới xa. */
const MAX_QUADS_U16 = 16383;

@ccclass('SandGrainRenderer')
export class SandGrainRenderer extends Component {
  @property({ type: Material, tooltip: 'grain-instanced-3d.effect (grainyLook=true) hoặc -flat' })
  grainMaterial: Material | null = null;

  private capacity = 0;
  private mesh: Mesh | null = null;
  private renderer: MeshRenderer | null = null;

  // Buffer đầy đủ theo capacity — cấp 1 LẦN.
  private positions!: Float32Array;   // 3 float / đỉnh
  private uvs!: Float32Array;         // 2 float / đỉnh — HẰNG SỐ
  private colors!: Float32Array;      // 4 float / đỉnh
  private radii!: Float32Array;       // 2 float / đỉnh (x = radius)
  private indices!: Uint16Array;      // 6 / quad — HẰNG SỐ

  // View cắt theo count hiện hành. Dựng lại CHỈ khi count đổi -> vòng update không cấp phát.
  private viewCount = -1;
  private geom: primitives.IDynamicGeometry | null = null;
  private radiusAttr!: gfx.Attribute;

  /** Palette colorId -> RGBA (4 float 0..1). Do LevelLoad dựng từ pixelLevelData. */
  private palette: Float32Array = new Float32Array(0);

  /**
   * @param capacity trần số hạt = grainPoolCapacity(). Vượt MAX_QUADS_U16 sẽ throw thay vì lặng lẽ vẽ thiếu.
   * @param palette  colorId -> rgba, stride 4.
   */
  init(capacity: number, palette: Float32Array): void {
    const cap = capacity | 0;
    if (cap > MAX_QUADS_U16) {
      throw new Error(`SandGrainRenderer: capacity ${cap} vượt trần index Uint16 (${MAX_QUADS_U16} hạt). ` +
                      `Đổi sang indices32 hoặc chia 2 submesh trước khi tăng pool.`);
    }
    this.capacity = cap;
    this.palette = palette;

    const verts = cap * VERTS_PER_QUAD;
    this.positions = new Float32Array(verts * 3);
    this.uvs = new Float32Array(verts * 2);
    this.colors = new Float32Array(verts * 4);
    this.radii = new Float32Array(verts * 2);
    this.indices = new Uint16Array(cap * INDICES_PER_QUAD);

    // --- 2 buffer HẰNG SỐ: góc quad + index. Dựng 1 lần rồi không bao giờ ghi lại. ---
    for (let q = 0; q < cap; q++) {
      const v = q * VERTS_PER_QUAD;
      // Thứ tự góc: (-1,-1) (1,-1) (1,1) (-1,1) — CCW nhìn từ +Z, khớp cullMode none của effect nên chiều nào
      // cũng vẽ, nhưng giữ CCW để nếu sau này bật cull back thì không mất hình.
      this.uvs[(v + 0) * 2] = -1; this.uvs[(v + 0) * 2 + 1] = -1;
      this.uvs[(v + 1) * 2] = 1;  this.uvs[(v + 1) * 2 + 1] = -1;
      this.uvs[(v + 2) * 2] = 1;  this.uvs[(v + 2) * 2 + 1] = 1;
      this.uvs[(v + 3) * 2] = -1; this.uvs[(v + 3) * 2 + 1] = 1;

      const o = q * INDICES_PER_QUAD;
      this.indices[o] = v; this.indices[o + 1] = v + 1; this.indices[o + 2] = v + 2;
      this.indices[o + 3] = v; this.indices[o + 4] = v + 2; this.indices[o + 5] = v + 3;
    }

    this.radiusAttr = new gfx.Attribute(gfx.AttributeName.ATTR_TEX_COORD1, gfx.Format.RG32F);

    this.renderer = this.getComponent(MeshRenderer) ?? this.addComponent(MeshRenderer)!;
    if (this.grainMaterial !== null) this.renderer.material = this.grainMaterial;
    // Hạt tự sáng theo công thức trong effect (không đọc đèn scene) -> tắt shadow cho khỏi tốn pass.
    this.renderer.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
    this.renderer.receiveShadow = MeshRenderer.ShadowReceivingMode.OFF;
  }

  /**
   * Đổ pool hiện tại vào mesh. Gọi 1 lần/frame RENDER (không phải mỗi sim step — sim chạy 30Hz, render 60fps;
   * vẽ lại theo sim step là ghi 2 lần cho cùng 1 hình).
   */
  syncFromPool(pool: GrainParticlePool): void {
    if (this.capacity === 0 || this.renderer === null) return;
    const n = Math.min(pool.count, this.capacity);

    const pos = pool.positions, rad = pool.radii, cid = pool.colorIds;
    const P = this.positions, C = this.colors, R = this.radii;
    const pal = this.palette;
    const palCount = (pal.length / 4) | 0;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (let i = 0; i < n; i++) {
      const x = pos[i * 2], y = pos[i * 2 + 1];
      const r = rad[i];

      // colorId ngoài palette -> trắng đục thay vì đọc ngoài mảng. Thấy hạt trắng ở P6 = palette thiếu màu, KHÔNG
      // phải lỗi solver — đó là chỉ dấu có ích, nên không im lặng clamp về màu 0.
      let cr = 1, cg = 1, cb = 1, ca = 1;
      const c = cid[i];
      if (c >= 0 && c < palCount) {
        const po = c * 4;
        cr = pal[po]; cg = pal[po + 1]; cb = pal[po + 2]; ca = pal[po + 3];
      }

      const v = i * VERTS_PER_QUAD;
      for (let k = 0; k < VERTS_PER_QUAD; k++) {
        const vk = v + k;
        // TÂM hạt, giống nhau cả 4 đỉnh: vừa là vị trí (góc dựng trong VS) vừa là seed Hash13.
        P[vk * 3] = x; P[vk * 3 + 1] = y; P[vk * 3 + 2] = 0;
        C[vk * 4] = cr; C[vk * 4 + 1] = cg; C[vk * 4 + 2] = cb; C[vk * 4 + 3] = ca;
        R[vk * 2] = r; R[vk * 2 + 1] = 0;
      }

      if (x - r < minX) minX = x - r;
      if (x + r > maxX) maxX = x + r;
      if (y - r < minY) minY = y - r;
      if (y + r > maxY) maxY = y + r;
    }

    if (n === 0) {
      // Mesh rỗng: KHÔNG updateSubMesh với 0 đỉnh (một số backend coi là lỗi) — ẩn renderer là đủ và rẻ hơn.
      this.renderer.enabled = false;
      return;
    }
    this.renderer.enabled = true;

    if (n !== this.viewCount) this.rebuildViews(n);
    const g = this.geom!;
    g.minPos = { x: minX, y: minY, z: -0.5 };
    g.maxPos = { x: maxX, y: maxY, z: 0.5 };

    if (this.mesh === null) {
      this.mesh = utils.MeshUtils.createDynamicMesh(0, g, undefined, {
        maxSubMeshes: 1,
        maxSubMeshVertices: this.capacity * VERTS_PER_QUAD,
        maxSubMeshIndices: this.capacity * INDICES_PER_QUAD,
      });
      this.renderer.mesh = this.mesh;
    } else {
      this.mesh.updateSubMesh(0, g);
    }
  }

  /** Cắt view theo count. Chỉ chạy khi count ĐỔI -> không cấp phát ở frame ổn định. */
  private rebuildViews(n: number): void {
    this.viewCount = n;
    const verts = n * VERTS_PER_QUAD;
    this.geom = {
      positions: this.positions.subarray(0, verts * 3),
      uvs: this.uvs.subarray(0, verts * 2),
      colors: this.colors.subarray(0, verts * 4),
      customAttributes: [{ attr: this.radiusAttr, values: this.radii.subarray(0, verts * 2) }],
      indices16: this.indices.subarray(0, n * INDICES_PER_QUAD),
    };
  }
}
