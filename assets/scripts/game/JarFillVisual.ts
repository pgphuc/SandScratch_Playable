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
// ĐI THEO ANIM HỘP (2026-08-25): mặt cát bám node SOCKET của xương THÂN hộp (`Box/Spine`, do `BoxAnim.socket()`
// tạo). Ở chế độ baked — chế độ DUY NHẤT chạy được ở đây — transform của node xương ĐỨNG IM (skinning đọc joint
// texture), nên `setParent` vào xương KHÔNG đi theo anim; socket là thứ engine cập nhật từ dữ liệu clip đã nướng.
// Quad vẫn là CON của node LỌ (không phải con của socket) để mọi số tuning giữ nguyên hệ world như trước, và để
// nó không thừa hưởng `rotX=45` của khung hộp lẫn `-90°X` của rig — mặt cát phải luôn quay thẳng vào camera.
// Cái lấy từ socket chỉ là ĐỘ LỆCH so với chỗ xương đứng lúc nghỉ. Cộng thẳng vào toạ độ local hợp lệ vì node lọ
// do AdRoot dựng trần: không xoay, scale 1.
//
// MẶT CÁT VẼ Ở ĐÂU: quad nằm NGAY TRƯỚC mặt trước hộp (mặt trước đã được BoxVisual ghim vào z của node lọ), tức
// local z nhỏ dương. Nguồn để fillMesh nằm TRONG hộp vì camera 3D nhìn xiên thấy được ruột; cảnh này ortho nhìn
// thẳng nên đặt trong ruột là bị panel trước che sạch.

import { Color, MeshRenderer, Node, Texture2D, Vec3 } from 'cc';
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
  /**
   * Alpha ĐỈNH của puff (0..1). Bản đầu ghim 0.75 và tắt tuyến tính ngay từ frame đầu -> khói mờ khó nhìn
   * (user báo 2026-08-25). Giờ là núm, và đường mờ giữ gần đỉnh suốt nửa đầu đời puff.
   */
  smokeAlpha: number;
  /**
   * MIỆNG HỘP — chỗ khói thoát ra, đo so với TÂM NODE LỌ (world). Nguồn để gốc particle TRÙNG mặt cát (nó nằm
   * trong ruột hộp, camera 3D nhìn xiên thấy được); cảnh này ortho nhìn thẳng nên khói phải bốc ra từ MIỆNG,
   * không phải từ mặt cát đang dâng — user chốt 2026-08-25.
   */
  smokeDx: number;
  smokeDy: number;
  /** true = khói bám mặt cát dâng (đúng nguồn). false (mặc định) = ghim ở miệng hộp theo smokeDx/smokeDy. */
  smokeFollowFill: boolean;
  /**
   * Pha màu lọ về TRẮNG (0 = đúng màu lọ như nguồn, 1 = trắng hẳn). Nguồn tint khói theo màu lọ, nhưng ở đây
   * khói nằm ngay trên mặt hộp CÙNG MÀU nên tint nguyên bản gần như tàng hình -> mặc định pha trắng.
   */
  smokeWhite: number;
}

export const JAR_FILL_DEFAULT: JarFillTuning = {
  enabled: true,
  w: 2.4, h: 0.42, dx: 0, dy: -0.95, dz: 0.06, range: 1.7,
  smoke: true, smokeEvery: 0.14, smokeCount: 3, smokeSize: 0.85,
  smokeLife: 0.55, smokeRise: 1.6, smokeSpread: 0.8, smokeAlpha: 1, smokeWhite: 0.55,
  smokeDx: 0, smokeDy: 1, smokeFollowFill: false,
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
  /** Màu puff = màu lọ đã pha trắng — xem smokeWhite. */
  private readonly smokeColor = new Color();
  private cooldown = 0;
  private progress = 0;
  /** Chỗ xương THÂN hộp đứng lúc NGHỈ, đo so với tâm node lọ — mốc để tính độ lệch do anim. */
  private readonly anchorRest = new Vec3();

  /**
   * @param jar node LỌ (không phải node hộp) — mọi số trong tuning đo so với tâm node này.
   * @param rgb màu lọ; < 0 = không map được -> dùng trắng.
   * @param smokeTex texture khói (`fx/smoke` = T_Dust03.png của nguồn). null -> quad trơn (hình VUÔNG, chỉ
   *        dùng khi thiếu file: user báo 2026-08-25 quad trơn đọc ra "ô vuông bay" chứ không ra khói).
   * @param anchor node socket bám xương THÂN hộp (xem đầu file). null = hộp không có anim -> mặt cát đứng yên
   *        trong hệ node lọ y như bản trước.
   */
  constructor(private readonly jar: Node, private readonly t: JarFillTuning, rgb: number,
              private readonly smokeTex: Texture2D | null = null,
              private readonly anchor: Node | null = null) {
    if (rgb >= 0) this.color.set((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255, 255);
    else this.color.set(255, 255, 255, 255);

    // Màu KHÓI = màu lọ pha trắng theo smokeWhite (mặt cát vẫn dùng màu lọ nguyên bản).
    const k = t.smokeWhite < 0 ? 0 : (t.smokeWhite > 1 ? 1 : t.smokeWhite);
    this.smokeColor.set(
      Math.round(this.color.r + (255 - this.color.r) * k),
      Math.round(this.color.g + (255 - this.color.g) * k),
      Math.round(this.color.b + (255 - this.color.b) * k),
      255,
    );

    if (anchor !== null) {
      // Chốt mốc NGAY LÚC DỰNG: lúc này chưa clip nào chạy nên socket còn ở pose nghỉ. Đo so với tâm node lọ chứ
      // không lấy world thô — node lọ còn bị JarColumns đặt lại chỗ và tween dồn cột sau đó.
      const a = anchor.worldPosition;
      const j = jar.worldPosition;
      this.anchorRest.set(a.x - j.x, a.y - j.y, a.z - j.z);
    }

    this.fill = new Node('JarFill');
    this.fill.setParent(jar);
    this.place();
    attachQuad(this.fill, t.w, t.h, this.color, null, false);
    this.fill.active = false;   // chưa nhận hạt nào thì hộp rỗng, không vẽ mặt cát

    if (!t.smoke) return;
    const cap = Math.max(1, Math.floor(t.smokeCount) * 3);   // 3 lứa cùng lúc là quá đủ với smokeLife ngắn
    for (let i = 0; i < cap; i++) {
      const n = new Node(`puff_${i}`);
      n.setParent(jar);
      n.active = false;
      const mr = attachQuad(n, t.smokeSize, t.smokeSize, this.smokeColor, this.smokeTex, true);
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
    this.place();
  }

  /**
   * Đặt quad mặt cát: mức cát theo `progress` + ĐỘ LỆCH của xương thân hộp so với lúc nghỉ (anim). Gọi mỗi
   * FRAME chứ không chỉ lúc mức cát đổi — anim chạy suốt trong khi `progress` đứng yên.
   */
  private place(): void {
    let dx = this.t.dx;
    let dy = this.t.dy + this.progress * this.t.range;
    let dz = this.t.dz;
    if (this.anchor !== null) {
      const a = this.anchor.worldPosition;
      const j = this.jar.worldPosition;
      dx += a.x - j.x - this.anchorRest.x;
      dy += a.y - j.y - this.anchorRest.y;
      dz += a.z - j.z - this.anchorRest.z;
    }
    this.fill.setPosition(dx, dy, dz);
  }

  /** Lọ vừa nhận cát -> bắn khói ở đúng mặt cát (nguồn: mainFx.Play() trong PlayAtProgress). */
  puff(): void {
    if (!this.t.enabled || !this.t.smoke || this.cooldown > 0) return;
    this.cooldown = this.t.smokeEvery;
    // Gốc khói: miệng hộp (mặc định) hoặc bám mặt cát dâng như nguồn.
    const x0 = this.t.smokeFollowFill ? this.t.dx : this.t.smokeDx;
    const y0 = this.t.smokeFollowFill
      ? this.t.dy + this.progress * this.t.range
      : this.t.smokeDy;
    let spawned = 0;
    for (const p of this.puffs) {
      if (spawned >= this.t.smokeCount) break;
      if (p.t > 0) continue;
      spawned++;
      p.t = this.t.smokeLife;
      p.x = x0 + (Math.random() * 2 - 1) * this.t.w * 0.4;
      p.y = y0;
      p.vx = (Math.random() * 2 - 1) * this.t.smokeSpread;
      p.node.active = true;
      p.node.setPosition(p.x, p.y, this.t.dz);
      p.node.setScale(0.8, 0.8, 1);
    }
  }

  /** Chạy theo FRAME (ColorJar.update). Trang trí thuần -> dùng dt thật, không bám nhịp sim 30Hz. */
  tick(dt: number): void {
    // Bám anim phải chạy TRƯỚC mọi nhánh thoát sớm phía dưới (khói tắt vẫn phải bám).
    if (this.anchor !== null && this.fill.active) this.place();
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
      const s = 0.8 + u * 0.9;                      // to dần
      p.node.setScale(s, s, 1);
      // Giữ gần alpha đỉnh suốt ~nửa đầu đời rồi mới tắt: tắt tuyến tính từ frame đầu thì puff chưa kịp thấy
      // đã mờ (đúng lý do user kêu khói khó nhìn).
      const a = this.t.smokeAlpha * Math.min(1, (1 - u) * 1.8);
      _c.set(this.smokeColor.r, this.smokeColor.g, this.smokeColor.b,
             Math.round(255 * (a < 0 ? 0 : (a > 1 ? 1 : a))));
      p.mr.getMaterialInstance(0)?.setProperty('mainColor', _c);
    }
  }

  /** ScenarioRunner replay. */
  reset(): void {
    this.progress = 0;
    this.cooldown = 0;
    this.fill.active = false;
    this.place();
    for (const p of this.puffs) { p.t = 0; p.node.active = false; }
  }
}

/** Vị trí mặt cát hiện tại theo world — để tầng khác (nếu cần) bắn VFX đúng chỗ. */
export function fillSurfaceWorld(jar: Node, t: JarFillTuning, ratio: number, out: Vec3): Vec3 {
  const w = jar.worldPosition;
  return out.set(w.x + t.dx, w.y + t.dy + ratio * t.range, w.z + t.dz);
}
