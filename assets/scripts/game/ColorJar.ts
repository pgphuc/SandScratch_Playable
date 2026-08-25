// 1 LỌ MÀU: hộp miệng hút hạt đúng màu + trạng thái đầy + tween "JarAnim".
//
// Chia việc với solver: `harvestJar()` (counting.ts) làm phần ĐẾM/HÚT thuần số, file này làm phần Cocos —
// đặt hộp miệng theo node, phát tween, bắn sự kiện onFull cho ScenarioRunner.
//
// JARANIM mức ĐẦY ĐỦ (manifest: fidelity FULL): nguồn Unity dùng HighlightPlus (middleware, đã DROP) cho
// outline+glow. Bên này outline/glow là shader TỰ VIẾT (manifest `shaders.new_authored`) — CHƯA có, nên phần
// glow ở đây để seam `onHighlight` và tween scale/punch chạy trước; gắn material outline sau không sửa logic.
//
// THROTTLE: `maxAcceptPixels` mỗi lượt = hạn ngạch chống overshoot. Nguồn kẹp theo chỗ CÒN LẠI của lọ, nên lọ
// gần đầy chỉ nhận đúng phần thiếu — không nhận quá rồi trừ ngược (trừ ngược làm số % nhảy giật).

import { Component, Node, Vec3, tween, Tween, _decorator } from 'cc';
import { harvestJar, mouthFromCenterSize, type HarvestedGrain, type MouthBounds } from '../solver/counting';
import type { GrainParticlePool } from '../solver/pool';
import type { BoxAnim } from './BoxAnim';
import type { JarFillVisual } from './JarFillVisual';

const { ccclass, property } = _decorator;

export type JarFullHandler = (jar: ColorJar) => void;

@ccclass('ColorJar')
export class ColorJar extends Component {
  @property({ tooltip: 'Bề ngang hộp miệng (world). Hạt đúng màu vào hộp là bị hút.' })
  mouthWidth = 1;

  @property({ tooltip: 'Bề cao hộp miệng (world).' })
  mouthHeight = 0.5;

  @property({ tooltip: 'Lệch tâm hộp miệng so với node (world).' })
  mouthOffset: Vec3 = new Vec3(0, 0, 0);

  /** colorId đã resolve từ tên màu (LevelLoad.colorIdOfJarName). -1 = CHƯA map được -> lọ không hút gì. */
  colorId = -1;
  /** Tên màu theo IR ("Yellow5") — giữ để log/parity đọc được. */
  colorName = '';
  /** Sức chứa theo PIXEL tranh (level 0001: ~1459/lọ). */
  capacity = 0;

  private filledValue = 0;
  private fullValue = false;
  private onFullHandlers: JarFullHandler[] = [];
  private mouth: MouthBounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  private mouthDirty = true;
  private punch: Tween<Node> | null = null;
  /**
   * Anim skeletal của mesh hộp (BoxAnim). AdRoot gắn vào sau attachBox; null = hộp quad placeholder hoặc
   * anim bị tắt trong board-layout.txt -> mọi lời gọi ở dưới thành no-op, logic lọ KHÔNG đổi.
   */
  boxAnim: BoxAnim | null = null;
  /** Mực cát dâng + khói (JarFillVisual). null = tắt trong board-layout.txt -> mọi lời gọi thành no-op. */
  fillVisual: JarFillVisual | null = null;
  private readonly baseScale = new Vec3(1, 1, 1);

  /** Buffer hạt vừa hút — tái dùng, không cấp phát trong vòng update. */
  private readonly harvested: HarvestedGrain[] = [];

  get filled(): number { return this.filledValue; }
  get isFull(): boolean { return this.fullValue; }
  /** 0..1. capacity <= 0 -> 0 (không chia cho 0). */
  get fillRatio(): number { return this.capacity > 0 ? this.filledValue / this.capacity : 0; }

  onLoad(): void {
    this.baseScale.set(this.node.scale);
  }

  /** Chỉ để nhịp anim hộp chạy — KHÔNG đụng số đếm (đếm nằm ở harvest, gọi từ sim step 30Hz). */
  update(dt: number): void {
    this.boxAnim?.tick(dt);
    this.fillVisual?.tick(dt);
  }

  /** Lọ vừa lên làm head của cột (JarColumns) = bắt đầu được nhận hạt -> mở nắp hộp. */
  onBecomeHead(): void {
    this.boxAnim?.open();
  }

  /** Gán thông số từ LevelLoad.JarSpec. Gọi TRƯỚC frame đầu. */
  setup(colorName: string, colorId: number, capacity: number): void {
    this.colorName = colorName;
    this.colorId = colorId;
    this.capacity = capacity | 0;
    this.filledValue = 0;
    this.fullValue = false;
    this.mouthDirty = true;
  }

  onFull(handler: JarFullHandler): void {
    this.onFullHandlers.push(handler);
  }

  /** Node lọ di chuyển (JarAnim đẩy lên/xuống) -> gọi cái này để hộp miệng tính lại. */
  markMouthDirty(): void { this.mouthDirty = true; }

  private ensureMouth(): void {
    if (!this.mouthDirty) return;
    const w = this.node.worldPosition;
    this.mouth = mouthFromCenterSize(
      w.x + this.mouthOffset.x,
      w.y + this.mouthOffset.y,
      this.mouthWidth, this.mouthHeight,
    );
    this.mouthDirty = false;
  }

  /**
   * Hút hạt trong 1 sim step. Trả số PIXEL vừa nhận.
   * Gọi từ vòng sim (không phải render): hút theo step giữ nhịp với vật lý, hút theo frame sẽ lệch khi frame drop.
   */
  harvest(pool: GrainParticlePool): number {
    this.ensureMouth();
    return this.harvestWithMouth(pool, this.mouth);
  }

  /**
   * Bản dùng hộp miệng NGOÀI. Nguồn Unity (ObiJarSink) KHÔNG hút tại chỗ đứng của lọ: vùng hút nằm ở RÃNH ĐÁY
   * BELT (autoMouthOffset = (0,5,0) so với tâm head jar), còn lọ chỉ là đích của cung bay visual. JarColumns.ts
   * giữ đúng tính chất đó — hộp miệng do CỘT cấp, không phải do node lọ.
   */
  harvestWithMouth(pool: GrainParticlePool, mouth: MouthBounds): number {
    if (this.colorId < 0 || this.fullValue) return 0;

    const room = this.capacity - this.filledValue;
    if (room <= 0) { this.markFull(); return 0; }

    this.harvested.length = 0;
    const got = harvestJar(pool, mouth, this.colorId, room, this.harvested);
    if (got <= 0) return 0;

    this.filledValue += got;
    this.playPunch();
    this.boxAnim?.fill();
    // Nguồn: JarAnim gọi SmokeEffect.PlayAtProgress(progress) mỗi lần nhận -> nâng mực cát + bắn khói cùng lúc.
    this.fillVisual?.setProgress(this.fillRatio);
    this.fillVisual?.puff();
    if (this.filledValue >= this.capacity) this.markFull();
    return got;
  }

  /** Hạt vừa bị hút lượt này — tầng VFX đọc để bắn hiệu ứng bay vào lọ. Chỉ hợp lệ ngay sau harvest(). */
  get lastHarvested(): readonly HarvestedGrain[] { return this.harvested; }

  private markFull(): void {
    if (this.fullValue) return;
    this.fullValue = true;
    this.filledValue = this.capacity;
    this.playFullBurst();
    this.boxAnim?.close();
    this.fillVisual?.setProgress(1);
    // Handler có thể đọc/ghi state khác -> gọi SAU khi đã chốt fullValue, để re-entrancy không lật cờ lại.
    for (let i = 0; i < this.onFullHandlers.length; i++) this.onFullHandlers[i](this);
  }

  // ==================================================================== JarAnim

  /** Nhịp nảy nhẹ mỗi lượt nhận hạt. Cắt tween cũ để không dồn chồng khi nhận liên tục mỗi step. */
  private playPunch(): void {
    this.punch?.stop();
    const s = this.baseScale;
    this.punch = tween(this.node)
      .to(0.06, { scale: new Vec3(s.x * 1.05, s.y * 0.95, s.z) })
      .to(0.10, { scale: new Vec3(s.x, s.y, s.z) })
      .start();
  }

  /** Lọ đầy: nảy mạnh 1 nhịp. Outline/glow gắn vào đây khi shader new_authored có. */
  private playFullBurst(): void {
    this.punch?.stop();
    const s = this.baseScale;
    this.punch = tween(this.node)
      .to(0.10, { scale: new Vec3(s.x * 1.18, s.y * 1.18, s.z) })
      .to(0.16, { scale: new Vec3(s.x, s.y, s.z) })
      .start();
  }

  /** Reset cho ScenarioRunner replay. */
  reset(): void {
    this.boxAnim?.reset();
    this.fillVisual?.reset();
    this.punch?.stop();
    this.punch = null;
    this.node.setScale(this.baseScale);
    this.filledValue = 0;
    this.fullValue = false;
    this.mouthDirty = true;
  }
}
