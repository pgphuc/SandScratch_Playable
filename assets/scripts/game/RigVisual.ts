// Hình khối STAND-IN của rig — khung · phễu · chute · vành băng chuyền.
//
// VÌ SAO CÓ FILE NÀY: rig cho tới giờ chỉ tồn tại dạng SDF va chạm VÔ HÌNH. Người chơi thấy cát nghỉ trên
// phễu mà không thấy phễu -> đọc thành "hạt đứng im giữa không trung" (bug user báo 2026-08-24). Harness
// belt-probe đã bác cả 3 nghi phạm solver (mật độ · occupancy · nghẽn cổ phễu) và chỗ DUY NHẤT có cát đứng
// im offline đúng là đụn nghỉ trên phễu — nên nhiều khả năng đây là bug ART, không phải bug vật lý.
//
// ⚠ ĐÂY LÀ STAND-IN, KHÔNG PHẢI ART THẬT. Art thật là PNG có sẵn trong IR:
//   ir/assets/!_Game_SDK/GameAssets/UIUX/GameBoard/{khung1,khung2,khung3,khungbangchuyen,Bangchuyen2,
//   thanhchan,Background,Arrow}.png
// nhưng CHỖ ĐẶT nằm trong prefab GameBoard (guid b02dc04a02e2320488ba85166c943658, đặt tại
// gameBoardLocalPosition (0.025, 17, 0.2) — xem ir/particles/__Game_SDK_Level_Prefabs_Game_Specifics
// .prefab.yaml:1137) mà P1 CHƯA extract. Có prefab đó thì thay lớp này bằng sprite thật.
//
// VÌ SAO VẼ TỪ SDF chứ không dựng hình riêng: hình vẽ ở đây lấy TỪ CHÍNH dữ liệu va chạm (sdf + segments)
// nên KHÔNG THỂ lệch so với chỗ cát thật sự bị chặn. Dựng hình riêng là đẻ ra nguồn sự thật thứ hai.

import { Color, Mesh, MeshRenderer, Material, Node, primitives, utils } from 'cc';
import { SEG_STRIDE, type GrainSdfField } from '../solver/sdfWalls';
import type { SdfRig } from './SdfBuild';

/** Số đoạn xấp xỉ mỗi nửa cung của vành. 24 đủ tròn ở cỡ màn ad, không tốn vertex. */
const ARC_SEGMENTS = 24;

let unlit: Material | null = null;
function mat(): Material {
  if (unlit !== null) return unlit;
  const m = new Material();
  m.initialize({ effectName: 'builtin-unlit', technique: 0 });
  unlit = m;
  return m;
}

/** local (geometry) -> world, dùng đúng ma trận rig chứ không tự nhân tay. */
function l2w(sdf: GrainSdfField, lx: number, ly: number): [number, number] {
  const m = sdf.localToWorld;
  return [m[0] * lx + m[4] * ly + m[12], m[1] * lx + m[5] * ly + m[13]];
}

/** Gom tam giác vào 1 mesh chung -> 1 draw call cho cả cụm. */
class TriBuf {
  private readonly pos: number[] = [];
  private readonly idx: number[] = [];
  private minX = 1e9; private minY = 1e9; private maxX = -1e9; private maxY = -1e9;

  vert(x: number, y: number, z: number): number {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    if (x < this.minX) this.minX = x;
    if (y < this.minY) this.minY = y;
    if (x > this.maxX) this.maxX = x;
    if (y > this.maxY) this.maxY = y;
    return i;
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  get empty(): boolean { return this.idx.length === 0; }

  build(z: number): Mesh {
    const geom: primitives.IGeometry = {
      positions: this.pos,
      indices: this.idx,
      minPos: { x: this.minX, y: this.minY, z },
      maxPos: { x: this.maxX, y: this.maxY, z },
    };
    return utils.MeshUtils.createMesh(geom);
  }
}

/** Điểm thứ i trên đường bao stadium bán kính `r`, tham số theo chu vi (2 rãnh thẳng + 2 mũ tròn). */
function stadiumPoint(sdf: GrainSdfField, r: number, t: number, out: { x: number; y: number }): void {
  const hb = sdf.halfBody;
  const straight = 2 * hb, arc = Math.PI * r, per = 2 * straight + 2 * arc;
  const s = ((t % 1) + 1) % 1 * per;
  if (s < straight) { out.x = -hb + s; out.y = r; }
  else if (s < straight + arc) {
    const a = (s - straight) / arc * Math.PI;
    out.x = hb + r * Math.sin(a); out.y = r * Math.cos(a);
  } else if (s < 2 * straight + arc) { out.x = hb - (s - straight - arc); out.y = -r; }
  else {
    const a = (s - 2 * straight - arc) / arc * Math.PI;
    out.x = -hb - r * Math.sin(a); out.y = -r * Math.cos(a);
  }
}

/** Dải khép kín giữa 2 đường bao stadium bán kính rA/rB. */
function stadiumBand(buf: TriBuf, sdf: GrainSdfField, rA: number, rB: number, z: number): void {
  const n = ARC_SEGMENTS * 4;
  const a = { x: 0, y: 0 }, b = { x: 0, y: 0 };
  let prevA = -1, prevB = -1, firstA = -1, firstB = -1;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    stadiumPoint(sdf, rA, t, a);
    stadiumPoint(sdf, rB, t, b);
    const wa = l2w(sdf, a.x, a.y), wb = l2w(sdf, b.x, b.y);
    const ia = buf.vert(wa[0], wa[1], z);
    const ib = buf.vert(wb[0], wb[1], z);
    if (prevA >= 0) buf.quad(prevA, ia, ib, prevB);
    else { firstA = ia; firstB = ib; }
    prevA = ia; prevB = ib;
  }
  if (prevA >= 0 && firstA >= 0) buf.quad(prevA, firstA, firstB, prevB);
}

/** 1 đoạn tường (capsule trong SDF) -> 1 quad dày `2·edgeRadius`, dựng ở LOCAL rồi mới đổi ra world. */
function segmentQuad(buf: TriBuf, sdf: GrainSdfField, ax: number, ay: number, bx: number, by: number,
                     half: number, z: number): void {
  let dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  dx /= len; dy /= len;
  const nx = -dy * half, ny = dx * half;
  const p = [
    l2w(sdf, ax - nx, ay - ny), l2w(sdf, bx - nx, by - ny),
    l2w(sdf, bx + nx, by + ny), l2w(sdf, ax + nx, ay + ny),
  ];
  const i0 = buf.vert(p[0][0], p[0][1], z);
  const i1 = buf.vert(p[1][0], p[1][1], z);
  const i2 = buf.vert(p[2][0], p[2][1], z);
  const i3 = buf.vert(p[3][0], p[3][1], z);
  buf.quad(i0, i1, i2, i3);
}

function addMesh(parent: Node, name: string, buf: TriBuf, color: Color, z: number): void {
  if (buf.empty) return;
  const node = new Node(name);
  node.setParent(parent);
  const mr = node.addComponent(MeshRenderer)!;
  mr.mesh = buf.build(z);
  mr.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
  mr.receiveShadow = MeshRenderer.ShadowReceivingMode.OFF;
  mr.material = mat();
  mr.getMaterialInstance(0)?.setProperty('mainColor', color);
}

/**
 * Dựng hình khối stand-in cho rig dưới `parent`. 3 cụm:
 *   · lõi vành  — thân đặc giữa stadium (r < rIn), cát chạy VÒNG QUANH nó
 *   · mép vành  — viền ngoài r > rOut, cho thấy rãnh cát rộng tới đâu
 *   · tường     — mọi segment SDF: 2 cạnh phễu, chute, tường khung
 * `z` nên ở SAU hạt (hạt ở z = 0).
 */
export function buildRigVisual(parent: Node, rig: SdfRig, z: number): Node {
  const root = new Node('RigVisual');
  root.setParent(parent);
  const sdf = rig.sdf;

  // Lõi: từ tâm (r≈0) ra tới rIn. rIn có thể rất bé (0.035) -> vẫn vẽ để rãnh có "trục".
  const core = new TriBuf();
  stadiumBand(core, sdf, 0, sdf.rIn, z);
  addMesh(root, 'BeltCore', core, new Color(70, 74, 86, 255), z);

  // Mép ngoài: dải mỏng ngay ngoài rOut -> nhìn ra ngay lòng máng chạy tới đâu.
  const rim = new TriBuf();
  const rimW = Math.max(sdf.edgeRadius, (sdf.rOut - sdf.rIn) * 0.14);
  stadiumBand(rim, sdf, sdf.rOut, sdf.rOut + rimW, z);
  addMesh(root, 'BeltRim', rim, new Color(52, 56, 66, 255), z);

  // Tường: phễu + chute + khung, lấy THẲNG từ segment SDF nên không thể lệch chỗ cát bị chặn.
  const walls = new TriBuf();
  const half = Math.max(sdf.edgeRadius, 0.01);
  for (let s = 0; s < sdf.segmentCount; s++) {
    const o = s * SEG_STRIDE;
    segmentQuad(walls, sdf, rig.segments[o], rig.segments[o + 1], rig.segments[o + 2], rig.segments[o + 3],
                half, z);
  }
  addMesh(root, 'Walls', walls, new Color(96, 100, 112, 255), z);

  return root;
}
