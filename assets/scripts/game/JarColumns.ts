// HÀNG ĐỢI LỌ THEO CỘT — phần của `ColorJarController` mà lớp Cocos thật sự cần.
//
// Luật của nguồn (ColorJarController + ObiJarSink), giữ nguyên 3 điểm:
//  1. MỖI CỘT chỉ có ĐÚNG MỘT lọ đang nhận = "head". Các lọ sau xếp hàng phía dưới, KHÔNG hút gì.
//  2. Vùng hút KHÔNG nằm ở chỗ đứng của lọ mà ở RÃNH ĐÁY BELT; màu + hạn ngạch của vùng hút lấy từ head jar
//     SỐNG của cột (nguồn: `autoMouthFromJars = true` -> "dồn cột tự đúng màu").
//     => 4 hộp miệng cùng phủ rãnh đáy, LỌC THEO MÀU. Hạt màu C bị hút bởi đúng cột đang có head màu C.
//  3. Head đầy -> lọ rời sân, lọ kế dồn lên slot trên.
//
// LỊCH SỬ 1 BUG — ĐỌC TRƯỚC KHI NỚI HỘP HÚT RA LẠI:
// Bản 2026-08-24 (và trước đó) cho CẢ 4 CỘT dùng CHUNG một hộp phủ TRỌN rãnh đáy vành, lấy lý do "belt = 0 nên
// hộp hẹp làm 2/4 cột chết đói". Hai vế đều hỏng:
//  · belt KHÔNG hề = 0 — lực belt nằm ở GrainFlowBackend chứ không ở ConveyorController (đã sửa, Cocos 2b1b078);
//  · "0.6×0.5" là DEFAULT trong ObiJarSink.cs, không phải số serialize. Số thật trên prefab là 2.3×3.
// Hậu quả: harvestJar gọi pool.removeAt -> nguyên đường chạy DƯỚI của băng chuyền thành máy hút, hạt vừa tới
// rãnh là bốc hơi trước khi belt kịp chở đi. Nhìn ra ngoài = "cát tự biến mất" + "băng chuyền đứng im".
// Giờ mỗi cột có hộp RIÊNG tại chỗ đứng của nó (AdRoot.buildJars), đúng nguồn: 4×2.3 = 9.2 trên dấu chân belt
// ~18.2 world -> hở ~50% cho hạt chạy vòng. Phân luồng vẫn do bộ lọc màu, và belt chạy vòng nên hạt màu C sớm
// muộn cũng đi qua hộp của cột C.
//
// · Cung bay visual của hạt (JarGrainVisual, parabol SandJump) KHÔNG port: nó là VFX, không đổi số đếm.

import { Node, Vec3, tween } from 'cc';
import type { MouthBounds } from '../solver/counting';
import type { GrainParticlePool } from '../solver/pool';
import type { ColorJar } from './ColorJar';

/** Giữ head "đầy" trên sân bấy nhiêu giây cho anim burst chạy hết rồi mới cho lọ kế dồn lên. */
const CLEAR_HOLD_SEC = 0.45;
/** Thời gian tween dồn cột — nguồn: ColorJarController.repositionDuration = 0.15 (prefab Game_Specifics). */
const REPOSITION_SEC = 0.15;

export interface JarColumnSpec {
  /** Lọ theo đúng thứ tự slot trong IR (slot 0 = head lúc bắt đầu). */
  jars: ColorJar[];
  /** Vị trí world của từng slot; slot i là chỗ đứng của lọ thứ i còn sống. */
  slots: Vec3[];
  /** Hộp hút RIÊNG của cột: tâm = tâm head jar + autoMouthOffset, cỡ = autoMouthSize (nguồn ObiJarSink). */
  mouth: MouthBounds;
}

class JarColumn {
  headIdx = 0;
  private clearTimer = -1;

  constructor(readonly spec: JarColumnSpec) {}

  get head(): ColorJar | null {
    return this.headIdx < this.spec.jars.length ? this.spec.jars[this.headIdx] : null;
  }

  /** Số lọ đã rời sân của cột này. */
  get cleared(): number { return this.headIdx; }

  /** Chạy trong SIM step (30Hz) — hút theo step giữ nhịp với vật lý. */
  harvest(pool: GrainParticlePool): number {
    const h = this.head;
    if (h === null || h.isFull) return 0;
    return h.harvestWithMouth(pool, this.spec.mouth);
  }

  /** Chạy theo FRAME — chỉ lo hình ảnh (giữ burst, dồn cột). */
  tickVisual(dt: number): void {
    const h = this.head;
    if (h === null) return;
    if (!h.isFull) return;

    if (this.clearTimer < 0) this.clearTimer = CLEAR_HOLD_SEC;
    this.clearTimer -= dt;
    if (this.clearTimer > 0) return;

    this.clearTimer = -1;
    h.node.active = false;
    this.headIdx++;
    this.reposition();
  }

  /** Dồn mọi lọ CÒN SỐNG lên slot mới. Lọ tràn quá số slot đứng chồng ở slot cuối (khuất dưới đáy màn). */
  private reposition(): void {
    const { jars, slots } = this.spec;
    if (slots.length === 0) return;
    for (let i = this.headIdx; i < jars.length; i++) {
      const jar = jars[i];
      const slot = slots[Math.min(i - this.headIdx, slots.length - 1)];
      tween(jar.node)
        .to(REPOSITION_SEC, { worldPosition: new Vec3(slot.x, slot.y, slot.z) })
        .call(() => jar.markMouthDirty())
        .start();
    }
  }
}

export class JarColumns {
  private readonly columns: JarColumn[] = [];

  constructor(specs: JarColumnSpec[]) {
    for (const s of specs) {
      this.columns.push(new JarColumn(s));
      // Đặt lọ vào slot ngay lúc dựng (không tween) — frame đầu phải đã đúng chỗ.
      for (let i = 0; i < s.jars.length; i++) {
        const slot = s.slots[Math.min(i, s.slots.length - 1)];
        s.jars[i].node.setWorldPosition(slot);
        s.jars[i].markMouthDirty();
      }
    }
  }

  /** Tổng số lọ đã rời sân — P6 đọc, và là số mà goal `jars_cleared` nói tới. */
  get clearedCount(): number {
    let n = 0;
    for (const c of this.columns) n += c.cleared;
    return n;
  }

  harvest(pool: GrainParticlePool): void {
    for (const c of this.columns) c.harvest(pool);
  }

  tickVisual(dt: number): void {
    for (const c of this.columns) c.tickVisual(dt);
  }
}
