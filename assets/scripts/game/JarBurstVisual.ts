// BURST LÚC LỌ ĐẦY ("merge") — port `JarAnim.PlayEffectMerge` + MMF player `Fb - Merge` trên prefab
// `Sand Drop Visualize/Prefabs/Objects/Main Box.prefab`.
//
// NGUỒN LÀM GÌ khi lọ đầy (đọc thẳng từ prefab, 3 feedback chạy song song):
//   1. `MMF_Events` -> gọi `PlayAnimCollapse()` = PHÁT CLIP CLOSE (nắp đóng sập xuống). Bản Cocos đã có:
//      `ColorJar.onFull -> BoxAnim.close()`.
//   2. `MMF_Particles` -> `Ps - Star Expolosion` (EmitCount = 100, DeclaredDuration = 0.5s), material
//      `Effect Star` texture `Flare02.png`. ĐÂY là mảnh còn thiếu — lọ đầy trước giờ biến mất trơ trọi.
//   3. `MMF_Pause` 0.3s. Rồi `InvokeWhenFeedbackFullyDone` mới cho lọ rời sân.
//      => lọ phải nán lại ~0.5 + 0.3 = 0.8s, không phải 0.45s như bản Cocos trước.
//
// XẤP XỈ CÓ CHỦ Ý (giỏ recode): pool quad có texture thay ParticleSystem — bắn toả tròn, có trọng lực, xoay,
// mờ dần. Không kéo module particle vào budget size P5. Số hạt hạ từ 100 xuống `count` vì ad chỉ cần đọc được
// "lọ nổ tung khi đầy", và 4 lọ có thể đầy sát nhau.
//
// TEXTURE: `assets/resources/fx/flare.png` = copy nguyên `Flare02.png` của nguồn. Thiếu file -> quad trắng
// (vẫn thấy burst, chỉ mất hình cánh sao) chứ không tắt hiệu ứng.

import { Color, MeshRenderer, Node, Texture2D, Vec3 } from 'cc';
import { attachQuad } from './QuadVisual';

/** Núm chỉnh — khối "merge" trong assets/resources/data/board-layout.txt. */
export interface JarMergeTuning {
  enabled: boolean;
  /**
   * Lọ đầy nán lại bao lâu rồi mới rời sân (giây). Nguồn = Particles 0.5 + Pause 0.3 = 0.8 — cũng là thời gian
   * clip Close có để chạy hết. Ngắn quá thì thấy lọ "biến mất" thay vì đóng nắp.
   */
  holdSec: number;
  /** Số mảnh bắn ra. Nguồn EmitCount = 100 (hạ xuống cho ngân sách ad). */
  count: number;
  /** Cỡ 1 mảnh lúc bắn (world) và lúc tàn (nhân với cỡ đầu). */
  size: number;
  sizeEnd: number;
  /** Đời 1 mảnh (giây). Nguồn: DeclaredDuration 0.5. */
  life: number;
  /** Tốc độ bắn ra (world/giây) — mỗi mảnh lấy ngẫu nhiên trong [speed*0.4, speed]. */
  speed: number;
  /** Gia tốc rơi (world/giây²). Âm = rơi xuống. */
  gravity: number;
  /** Tốc độ xoay (độ/giây), ngẫu nhiên ± quanh giá trị này. */
  spin: number;
  /** Pha màu lọ về TRẮNG (0..1) — burst trắng dễ đọc trên nền hộp cùng màu. */
  white: number;
}

export const JAR_MERGE_DEFAULT: JarMergeTuning = {
  enabled: true,
  holdSec: 0.8,
  count: 24,
  size: 0.9, sizeEnd: 0.35,
  life: 0.5,
  speed: 7,
  gravity: -9,
  spin: 220,
  white: 0.35,
};

interface Shard {
  node: Node;
  mr: MeshRenderer;
  x: number; y: number;
  vx: number; vy: number;
  spin: number;
  angle: number;
  t: number;    // giây còn lại; <= 0 = rảnh
  r: number; g: number; b: number;
}

const _c = new Color();
const _p = new Vec3();

export class JarBurstVisual {
  private readonly shards: Shard[] = [];
  private readonly root: Node;

  constructor(parent: Node, private readonly t: JarMergeTuning, tex: Texture2D | null) {
    this.root = new Node('JarBurst');
    this.root.setParent(parent);

    // 2 lứa cùng lúc là đủ: 2 lọ đầy sát nhau vẫn đủ mảnh, lứa thứ 3 thì mắt không phân biệt được nữa.
    const cap = this.t.enabled ? Math.max(1, Math.floor(this.t.count) * 2) : 0;
    for (let i = 0; i < cap; i++) {
      const n = new Node(`shard_${i}`);
      n.setParent(this.root);
      n.active = false;
      const mr = attachQuad(n, this.t.size, this.t.size, Color.WHITE, tex, true);
      this.shards.push({ node: n, mr, x: 0, y: 0, vx: 0, vy: 0, spin: 0, angle: 0, t: 0, r: 255, g: 255, b: 255 });
    }
  }

  /** Lọ vừa đầy — nổ tại chỗ đứng của nó. `color` = màu lọ (được pha trắng theo `white`). */
  play(at: Vec3, color: Color): void {
    if (!this.t.enabled) return;
    const k = this.t.white < 0 ? 0 : (this.t.white > 1 ? 1 : this.t.white);
    const r = Math.round(color.r + (255 - color.r) * k);
    const g = Math.round(color.g + (255 - color.g) * k);
    const b = Math.round(color.b + (255 - color.b) * k);

    let spawned = 0;
    for (const s of this.shards) {
      if (spawned >= this.t.count) break;
      if (s.t > 0) continue;
      spawned++;
      // Toả tròn đều + jitter, tốc độ ngẫu nhiên -> vành nổ dày chứ không phải 1 vòng tròn đơn.
      const a = (spawned / this.t.count) * Math.PI * 2 + Math.random() * 0.6;
      const sp = this.t.speed * (0.4 + Math.random() * 0.6);
      s.x = at.x; s.y = at.y;
      s.vx = Math.cos(a) * sp;
      s.vy = Math.sin(a) * sp;
      s.spin = (Math.random() * 2 - 1) * this.t.spin;
      s.angle = Math.random() * 360;
      s.t = this.t.life;
      s.r = r; s.g = g; s.b = b;
      s.node.active = true;
      s.node.setPosition(_p.set(s.x, s.y, at.z));
      s.node.angle = s.angle;
      s.node.setScale(1, 1, 1);
    }
  }

  /** Chạy theo FRAME. Trang trí thuần -> dt thật, không bám nhịp sim 30Hz. */
  tick(dt: number): void {
    const life = this.t.life > 0 ? this.t.life : 1;
    for (const s of this.shards) {
      if (s.t <= 0) continue;
      s.t -= dt;
      if (s.t <= 0) { s.node.active = false; continue; }
      const u = 1 - s.t / life;                    // 0 -> 1 theo đời mảnh
      s.vy += this.t.gravity * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.angle += s.spin * dt;
      const pos = s.node.position;
      s.node.setPosition(_p.set(s.x, s.y, pos.z));
      s.node.angle = s.angle;
      const sc = 1 + (this.t.sizeEnd / (this.t.size > 0 ? this.t.size : 1) - 1) * u;
      s.node.setScale(sc, sc, 1);
      _c.set(s.r, s.g, s.b, Math.round(255 * Math.min(1, (1 - u) * 2)));
      s.mr.getMaterialInstance(0)?.setProperty('mainColor', _c);
    }
  }

  /** ScenarioRunner replay. */
  reset(): void {
    for (const s of this.shards) { s.t = 0; s.node.active = false; }
  }
}
