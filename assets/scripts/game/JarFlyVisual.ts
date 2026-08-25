// HẠT VISUAL BAY TỪ CHỖ BỊ HÚT VÀO LỌ (G1 — "cung nhảy") — port 1:1 toán của `ObiJarSink.LaunchGrain` +
// `ObiJarSink.TickFlights` (SandFlow/Flow/Counting/ObiJarSink.cs), số lấy từ prefab `Game Specifics.prefab`.
//
// VÌ SAO CẦN: hộp hút nằm ở RÃNH ĐÁY BELT chứ không ở chỗ đứng của lọ (autoMouthOffset (0,4,0) trên prefab).
// Không có cung bay thì hạt chạm rãnh đáy là BIẾN MẤT tại chỗ.
//
// HÌNH DẠNG HẠT: mesh CẦU unlit — đúng prefab nguồn `SandFlow/Prefab/Grains.prefab` (root + con "Sphere":
// MeshFilter mesh built-in Sphere, MeshRenderer, localScale 0.25 cả 3 trục; `JarGrainVisual` chỉ tint màu qua
// MaterialPropertyBlock, và comment nguồn dặn material phải UNLIT). Nên `size` mặc định = 0.25, không phải số
// đặt tay như bản trước (0.42).
//
// TOÁN NGUỒN — 4 tầng chồng lên nhau, bản trước chỉ có tầng 1:
//   1. base: `Vector3.LerpUnclamped(start, target, OutQuad(t))` — ease OutQuad, KHÔNG phải lerp thẳng.
//   2. bow dọc: `pos.y += power * 4w(1-w)` với `w` được WARP để đỉnh cung rơi đúng `jumpPeakFrac` (0.3 = vọt
//      sớm rồi hạ dần vào miệng), không phải parabol đối xứng đỉnh ở giữa.
//   3. fan ngang: mỗi hạt vào 1 LÀN (`arcLanes` = 3, xoay vòng), lệch theo PHÁP TUYẾN của (target-start) trong
//      XY với bow đối xứng 4t(1-t) -> mọi làn hội tụ đúng miệng. Đây là thứ làm dòng hạt XOÈ ra nhiều đường
//      cong thay vì 1 sợi.
//   4. đích LIVE: target đọc lại MỖI FRAME từ node lọ (lọ đang tween dồn cột thì hạt bám theo), + `landOffset`
//      + `landJitter` cố định per-hạt (dải ngang `landBandWidth` × dày dọc `landSpread`).
//
// ĐẢO DẤU Z: nguồn `grainLandOffset.z = -1.45` (camera Unity nhìn +Z: z nhỏ = gần). Cảnh này nhìn -Z nên
// `landOffsetZ` = +1.45. Hạt bay từ mặt phẳng cát tới z đó — NỘI SUY z, y như LerpUnclamped của nguồn, chứ
// không ghim 1 z cố định như bản trước.
//
// KHÔNG ĐỘNG VÀO SỐ ĐẾM: lớp này chỉ đọc `ColorJar.lastHarvested` rồi vẽ. Hạt đã bị pool.removeAt từ trước.
// NGÂN SÁCH: 1 lượt hút có thể tới hàng nghìn hạt -> LẤY MẪU `sampleEvery` + trần `capacity` cung cùng lúc
// (nguồn không cần: hạt Obi thưa hơn hạt của solver này nhiều lần).

import { Color, MeshRenderer, Node, Vec3 } from 'cc';
import { attachSphere } from './QuadVisual';
import type { HarvestedGrain } from '../solver/counting';

/** Núm chỉnh — khối "fly" trong assets/resources/data/board-layout.txt. Tên khớp field của ObiJarSink. */
export interface JarFlyTuning {
  enabled: boolean;
  /** Đường kính hạt (world). Nguồn: Grains.prefab localScale 0.25 trên sphere đơn vị. */
  size: number;
  /** Điểm đáp so với TÂM NODE LỌ. Nguồn grainLandOffset (0, 0.5, -1.45) — z ĐÃ đảo dấu sang hệ cảnh này. */
  landOffsetX: number;
  landOffsetY: number;
  landOffsetZ: number;
  /** Độ vồng DỌC (world). Nguồn grainJumpPower = 2. */
  jumpPower: number;
  /** Vị trí ĐỈNH cung theo tiến trình bay (0..1). Nguồn 0.3 = vọt sớm rồi hạ dần vào miệng. */
  jumpPeakFrac: number;
  /** Thời gian bay 1 hạt (giây). Nguồn 0.6. */
  jumpDuration: number;
  /** Jitter ±tỉ lệ power / duration mỗi hạt. Nguồn 0.3 / 0.25. */
  jumpPowerJitter: number;
  jumpDurationJitter: number;
  /** Điểm đáp: dải NGANG rộng bằng miệng lọ (nguồn 1) × dày DỌC ±(nguồn 0.15). Band = 0 -> tán tròn bán kính spread. */
  landBandWidth: number;
  landSpread: number;
  /** Số LÀN cung riêng (nguồn 3) · độ xoè làn ngoài cùng (0.6) · jitter ngang mỗi hạt (0.08). */
  arcLanes: number;
  arcLaneSpread: number;
  arcLaneJitter: number;
  /** Trần số cung bay cùng lúc (ngân sách riêng của bản Cocos). */
  capacity: number;
  /** Cứ bấy nhiêu hạt bị hút thì vẽ 1 cung. */
  sampleEvery: number;
}

export const JAR_FLY_DEFAULT: JarFlyTuning = {
  enabled: true,
  size: 0.25,
  landOffsetX: 0, landOffsetY: 0.5, landOffsetZ: 1.45,
  jumpPower: 2, jumpPeakFrac: 0.3, jumpDuration: 0.6,
  jumpPowerJitter: 0.3, jumpDurationJitter: 0.25,
  landBandWidth: 1, landSpread: 0.15,
  arcLanes: 3, arcLaneSpread: 0.6, arcLaneJitter: 0.08,
  capacity: 96, sampleEvery: 12,
};

interface Flyer {
  node: Node;
  /** Node LỌ đích — đọc worldPosition mỗi frame (đích LIVE của nguồn). null = cung rảnh. */
  jar: Node | null;
  startX: number; startY: number; startZ: number;
  /** Offset đáp cố định per-hạt (dải ngang/dọc) — cộng vào đích live. */
  jitterX: number; jitterY: number;
  /** Lệch NGANG theo pháp tuyến (làn cung + jitter). */
  lateral: number;
  power: number;
  duration: number;
  elapsed: number;
}

const _p = new Vec3();

export class JarFlyVisual {
  private readonly flyers: Flyer[] = [];
  private readonly renderers: MeshRenderer[] = [];
  private readonly root: Node;
  /** Bộ đếm dồn qua các lượt để lượt nhỏ không mất mẫu. */
  private carry = 0;
  /** Xoay vòng làn cung mỗi hạt phóng (nguồn: _laneCursor). */
  private laneCursor = 0;

  constructor(parent: Node, private readonly t: JarFlyTuning) {
    this.root = new Node('JarFly');
    this.root.setParent(parent);

    const cap = Math.max(1, Math.floor(t.capacity));
    for (let i = 0; i < cap; i++) {
      const n = new Node(`fly_${i}`);
      n.setParent(this.root);
      n.active = false;
      this.renderers.push(attachSphere(n, t.size, new Color(255, 255, 255, 255)));
      this.flyers.push({
        node: n, jar: null, startX: 0, startY: 0, startZ: 0,
        jitterX: 0, jitterY: 0, lateral: 0, power: 0, duration: 1, elapsed: 0,
      });
    }
  }

  /**
   * Xếp cung bay cho lượt hút vừa xong. `grains` = ColorJar.lastHarvested (CHỈ hợp lệ ngay sau harvest).
   * `jar` = node lọ (giữ tham chiếu để đọc đích LIVE). `color` = màu lọ.
   */
  spawnFrom(grains: readonly HarvestedGrain[], jar: Node, color: Color): void {
    if (!this.t.enabled || grains.length === 0) return;
    const every = Math.max(1, Math.floor(this.t.sampleEvery));
    this.carry += grains.length;
    const take = Math.floor(this.carry / every);
    if (take <= 0) return;
    this.carry -= take * every;

    // Trải mẫu ĐỀU trên lượt hút thay vì lấy N hạt đầu — N hạt đầu hay nằm chụm 1 góc hộp.
    const stride = grains.length / take;
    const lanes = Math.max(1, Math.floor(this.t.arcLanes));
    for (let k = 0; k < take; k++) {
      const fi = this.acquire();
      if (fi < 0) break;                           // hết cung rảnh -> bỏ phần còn lại, không cấp phát thêm
      const f = this.flyers[fi];
      const g = grains[Math.min(grains.length - 1, Math.floor(k * stride))];
      f.jar = jar;
      f.startX = g.x; f.startY = g.y; f.startZ = 0;
      // Điểm đáp (nguồn LaunchGrain): band > 0 -> rải ngang đều thành dải; = 0 -> tán tròn quanh miệng.
      if (this.t.landBandWidth > 0) {
        f.jitterX = (Math.random() - 0.5) * this.t.landBandWidth;
        f.jitterY = this.t.landSpread > 0 ? (Math.random() * 2 - 1) * this.t.landSpread : 0;
      } else if (this.t.landSpread > 0) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * this.t.landSpread;
        f.jitterX = Math.cos(a) * r;
        f.jitterY = Math.sin(a) * r;
      } else {
        f.jitterX = 0; f.jitterY = 0;
      }
      // Làn cung: laneT map [-1..1] (làn giữa = 0) đối xứng, xoay vòng theo laneCursor.
      const laneT = lanes > 1 ? (this.laneCursor % lanes) / (lanes - 1) * 2 - 1 : 0;
      this.laneCursor++;
      const laneJitter = this.t.arcLaneJitter > 0
        ? (Math.random() * 2 - 1) * this.t.arcLaneJitter : 0;
      f.lateral = laneT * this.t.arcLaneSpread + laneJitter;
      f.power = this.t.jumpPower * (1 + (Math.random() * 2 - 1) * this.t.jumpPowerJitter);
      f.duration = Math.max(0.01,
        this.t.jumpDuration * (1 + (Math.random() * 2 - 1) * this.t.jumpDurationJitter));
      f.elapsed = 0;
      f.node.active = true;
      f.node.setPosition(f.startX, f.startY, f.startZ);
      this.renderers[fi].getMaterialInstance(0)?.setProperty('mainColor', color);
    }
  }

  /** Chạy theo FRAME (nguồn TickFlights cũng là 1 vòng lặp tập trung, không tween per-hạt). */
  tick(dt: number): void {
    for (let i = 0; i < this.flyers.length; i++) {
      const f = this.flyers[i];
      if (f.jar === null) continue;
      f.elapsed += dt;
      const t = f.elapsed / f.duration;
      if (t >= 1 || !f.jar.isValid) { f.jar = null; f.node.active = false; continue; }

      // Đích LIVE: lọ đang tween dồn cột thì hạt bám theo (nguồn đọc targetJar._transform.position mỗi tick).
      const w = f.jar.worldPosition;
      const tx = w.x + this.t.landOffsetX + f.jitterX;
      const ty = w.y + this.t.landOffsetY + f.jitterY;
      const tz = w.z + this.t.landOffsetZ;

      const baseT = 1 - (1 - t) * (1 - t);         // OutQuad — SandEasing.Evaluate(SandEase.OutQuad, t)
      let x = f.startX + (tx - f.startX) * baseT;
      let y = f.startY + (ty - f.startY) * baseT;
      const z = f.startZ + (tz - f.startZ) * baseT;

      // bow dọc: warp w để đỉnh rơi đúng jumpPeakFrac; 0 ở hai đầu -> đáp đúng đích.
      const peak = this.t.jumpPeakFrac > 0 && this.t.jumpPeakFrac < 1 ? this.t.jumpPeakFrac : 0.3;
      const bw = t < peak ? 0.5 * (t / peak) : 0.5 + 0.5 * ((t - peak) / (1 - peak));
      y += f.power * 4 * bw * (1 - bw);

      // fan ngang theo pháp tuyến của (target - start) trong XY, bow đối xứng 4t(1-t).
      if (f.lateral !== 0) {
        let px = -(ty - f.startY);
        let py = tx - f.startX;
        const len = Math.sqrt(px * px + py * py);
        if (len > 0.01) {
          px /= len; py /= len;
          const off = f.lateral * 4 * t * (1 - t);
          x += px * off;
          y += py * off;
        }
      }

      f.node.setPosition(_p.set(x, y, z));
    }
  }

  /** ScenarioRunner replay: thu hết cung đang bay. */
  reset(): void {
    for (const f of this.flyers) { f.jar = null; f.node.active = false; }
    this.carry = 0;
  }

  /** Chỉ số cung rảnh, -1 = hết. Trả INDEX vì caller cần renderer cùng chỉ số. */
  private acquire(): number {
    for (let i = 0; i < this.flyers.length; i++) if (this.flyers[i].jar === null) return i;
    return -1;
  }
}
