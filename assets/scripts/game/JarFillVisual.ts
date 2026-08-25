// MỰC CÁT DÂNG TRONG HỘP + KHÓI KHI NHẬN CÁT — port `SmokeEffect.cs` (Sand Drop Visualize).
//
// NGUỒN LÀM GÌ: `SmokeEffect.PlayAtProgress(progress)` được `JarAnim` gọi mỗi lần lọ nhận cát, và nó làm ĐÚNG
// HAI việc:
//   (1) `SetupFill(progress)` — nâng `fillMesh` (và cả gốc particle) lên `progress * fillRange` theo trục Y
//       local. Đây mới là thứ nhìn thấy rõ nhất: MỨC CÁT trong hộp dâng dần theo % đầy.
//   (2) `mainFx.Play()` — bắn cụm khói ở đúng mặt cát đó; `smokeFxs[].main.startColor` nhuộm theo màu lọ.
// Số nguồn: `fillRange = 2` (override trên prefab `Objects/Main Box`; bản prefab `Effect - Fill` đứng riêng để 0).
//
// ĐÂY LÀ `recode`, KHÔNG PHẢI CONVERT 1:1 — đúng giỏ manifest (`conversion-manifest.md` §63: "smoke effect tint
// theo màu lọ" = recode, fidelity JarAnim ĐẦY ĐỦ). Cụ thể chỗ lệch, ghi thẳng để P6 parity không đo nhầm:
//   · Nguồn dùng 3 ParticleSystem (mainFx + 2 smokeFxs) với curve/burst riêng. Ở đây là POOL QUAD tự viết:
//     mỗi puff = 1 quad unlit bay lên, to dần, mờ dần. Không ai đọc được sự khác nhau trong 15-30s của ad, mà
//     đổi lại không phải kéo cả module particle + 3 texture vào budget size của P5.
//   · `fillRange = 2` của nguồn nằm trong hệ local của prefab `Effect - Fill` (có scale riêng), KHÔNG quy thẳng
//     sang world của cảnh này được. Nên `range` ở đây là NÚM CHỈNH TAY trong board-layout.txt, mặc định đặt
//     theo tỉ lệ khung lọ; chỉnh bằng mắt rồi chốt.
//
// MẶT CÁT VẼ Ở ĐÂU: quad nằm NGAY TRƯỚC mặt trước hộp (mặt trước đã được BoxVisual ghim vào z của node lọ), tức
// local z nhỏ dương. Nguồn để fillMesh nằm TRONG hộp vì camera 3D nhìn xiên thấy được ruột; cảnh này ortho nhìn
// thẳng nên đặt trong ruột là bị panel trước che sạch.

import { Color, MeshRenderer, Node, Vec3 } from 'cc';
import { attachQuad } from './QuadVisual';

/** Núm chỉnh — khối "fill" trong assets/resources/data/board-layout.txt. */
export interface JarFillTuning {
  enabled: boolean;
  /** Bề ngang/cao mặt cát (world). */
  w: number;
  h: number;
  /** Vị trí mặt cát lúc progress = 0, so với tâm node lọ (world). */
  dx: number;
  dy: number;
  /** Nhích ra trước mặt hộp bao nhiêu (world). Quá nhỏ = z-fight với panel hộp. */
  dz: number;
  /** Quãng mặt cát dâng khi progress đi từ 0 -> 1 (world). Nguồn: fillRange = 2 (hệ local prefab). */
  range: number;
  smoke: boolean;
  /** Giãn cách tối thiểu giữa 2 lần bắn khói (giây) — lọ nhận hạt mỗi sim step, không throttle là khói đặc kín. */
  smokeEvery: number;
  /** Số puff mỗi lần bắn. */
  smokeCount: number;
  smokeSize: number;
  smokeLife: number;
  /** Tốc độ bay lên (world/giây). */
  smokeRise: number;
  /** Tản ngang tối đa (world). */
  smokeSpread: number;
}

export const JAR_FILL_DEFAULT: JarFillTuning = {
  enabled: true,
  w: 2.4, h: 0.42, dx: 0, dy: -0.95, dz: 0.06, range: 1.7,
  smoke: true, smokeEvery: 0.18, smokeCount: 2, smokeSize: 0.55,
  smokeLife: 0.55, smokeRise: 1.6, smokeSpread: 0.8,
};

interface Puff {
  node: Node;
  mr: MeshRenderer;
  x: number; y: number;
  vx: number;
  t: number;   // giây còn lại; <= 0 = rảnh
}

const _c = new Color();

export class JarFillVisual {
  private readonly fill: Node;
  private readonly puffs: Puff[] = [];
  private readonly color = new Color();
  private cooldown = 0;
  private progress = 0;

  /**
   * @param jar node LỌ (không phải node hộp) — mọi số trong tuning đo so với tâm node này.
   * @param rgb màu lọ; < 0 = không map được -> dùng trắng.
   */
  constructor(private readonly jar: Node, private readonly t: JarFillTuning, rgb: number) {
    if (rgb >= 0) this.color.set((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255, 255);
    else this.color.set(255, 255, 255, 255);

    this.fill = new Node('JarFill');
    this.fill.setParent(jar);
    this.fill.setPosition(t.dx, t.dy, t.dz);
    attachQuad(this.fill, t.w, t.h, this.color, null, false);
    this.fill.active = false;   // chưa nhận hạt nào thì hộp rỗng, không vẽ mặt cát

    if (!t.smoke) return;
    const cap = Math.max(1, Math.floor(t.smokeCount) * 3);   // 3 lứa cùng lúc là quá đủ với smokeLife ngắn
    for (let i = 0; i < cap; i++) {
      const n = new Node(`puff_${i}`);
      n.setParent(jar);
      n.active = false;
      const mr = attachQuad(n, t.smokeSize, t.smokeSize, this.color, null, true);
      this.puffs.push({ node: n, mr, x: 0, y: 0, vx: 0, t: 0 });
    }
  }

  /**
   * Cập nhật mức cát. `ratio` = ColorJar.fillRatio (0..1).
   * Nguồn gọi SetupFill mỗi lần nhận, không tween — mức cát nhảy từng nấc theo lượt hút, và vì lượt hút dày
   * (mỗi sim step) nên mắt đọc thành dâng liên tục.
   */
  setProgress(ratio: number): void {
    if (!this.t.enabled) return;
    this.progress = ratio < 0 ? 0 : (ratio > 1 ? 1 : ratio);
    this.fill.active = this.progress > 0;
    this.fill.setPosition(this.t.dx, this.t.dy + this.progress * this.t.range, this.t.dz);
  }

  /** Lọ vừa nhận cát -> bắn khói ở đúng mặt cát (nguồn: mainFx.Play() trong PlayAtProgress). */
  puff(): void {
    if (!this.t.enabled || !this.t.smoke || this.cooldown > 0) return;
    this.cooldown = this.t.smokeEvery;
    const y0 = this.t.dy + this.progress * this.t.range;
    let spawned = 0;
    for (const p of this.puffs) {
      if (spawned >= this.t.smokeCount) break;
      if (p.t > 0) continue;
      spawned++;
      p.t = this.t.smokeLife;
      p.x = this.t.dx + (Math.random() * 2 - 1) * this.t.w * 0.4;
      p.y = y0;
      p.vx = (Math.random() * 2 - 1) * this.t.smokeSpread;
      p.node.active = true;
      p.node.setPosition(p.x, p.y, this.t.dz);
      p.node.setScale(0.6, 0.6, 1);
    }
  }

  /** Chạy theo FRAME (ColorJar.update). Trang trí thuần -> dùng dt thật, không bám nhịp sim 30Hz. */
  tick(dt: number): void {
    if (this.cooldown > 0) this.cooldown -= dt;
    if (this.puffs.length === 0) return;
    const life = this.t.smokeLife > 0 ? this.t.smokeLife : 1;
    for (const p of this.puffs) {
      if (p.t <= 0) continue;
      p.t -= dt;
      if (p.t <= 0) { p.node.active = false; continue; }
      const u = 1 - p.t / life;                     // 0 -> 1 theo đời puff
      p.x += p.vx * dt;
      p.y += this.t.smokeRise * dt;
      p.node.setPosition(p.x, p.y, this.t.dz);
      const s = 0.6 + u * 0.9;                      // to dần
      p.node.setScale(s, s, 1);
      _c.set(this.color.r, this.color.g, this.color.b, Math.round(255 * (1 - u) * 0.75));
      p.mr.getMaterialInstance(0)?.setProperty('mainColor', _c);
    }
  }

  /** ScenarioRunner replay. */
  reset(): void {
    this.progress = 0;
    this.cooldown = 0;
    this.fill.active = false;
    this.fill.setPosition(this.t.dx, this.t.dy, this.t.dz);
    for (const p of this.puffs) { p.t = 0; p.node.active = false; }
  }
}

/** Vị trí mặt cát hiện tại theo world — để tầng khác (nếu cần) bắn VFX đúng chỗ. */
export function fillSurfaceWorld(jar: Node, t: JarFillTuning, ratio: number, out: Vec3): Vec3 {
  const w = jar.worldPosition;
  return out.set(w.x + t.dx, w.y + t.dy + ratio * t.range, w.z + t.dz);
}
