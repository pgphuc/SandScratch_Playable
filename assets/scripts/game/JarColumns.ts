// HÀNG ĐỢI LỌ THEO CỘT — phần của `ColorJarController` mà lớp Cocos thật sự cần.
//
// Luật của nguồn (ColorJarController + ObiJarSink), giữ nguyên 3 điểm:
//  1. MỖI CỘT chỉ có ĐÚNG MỘT lọ đang nhận = "head". Các lọ sau xếp hàng phía dưới, KHÔNG hút gì.
//  2. Vùng hút KHÔNG nằm ở chỗ đứng của lọ mà ở RÃNH ĐÁY BELT; màu + hạn ngạch của vùng hút lấy từ head jar
//     SỐNG của cột (nguồn: `autoMouthFromJars = true` -> "dồn cột tự đúng màu").
//     => 4 hộp miệng cùng phủ rãnh đáy, LỌC THEO MÀU. Hạt màu C bị hút bởi đúng cột đang có head màu C.
//  3. Head đầy -> lọ rời sân, lọ kế dồn lên slot trên.
//
// LỆCH CÓ CHỦ Ý so với nguồn, và vì sao:
// · Nguồn cho mỗi cột 1 hộp hẹp (autoMouthSize 0.6×0.5) đặt đúng chỗ cột đó đón hạt trên belt ĐANG CHẠY.
//   Ở ad này belt = 0 (ConveyorController là shell no-op, manifest P2 chốt bake data-only) nên hạt KHÔNG được
//   chở đi đâu cả — chúng đọng ngay dưới miệng chute. Hộp hẹp per-cột sẽ làm 2/4 cột chết đói. Nên hộp của cả
//   4 cột phủ TRỌN rãnh đáy; việc phân luồng do bộ lọc màu đảm nhiệm, y như nguồn.
//   ⚠ Đây là chỗ ĐẦU TIÊN phải sửa nếu P6 quyết định làm belt chạy thật.
// · Cung bay visual của hạt (JarGrainVisual, parabol SandJump) KHÔNG port: nó là VFX, không đổi số đếm.

import { Node, Vec3, tween } from 'cc';
import type { MouthBounds } from '../solver/counting';
import type { GrainParticlePool } from '../solver/pool';
import type { ColorJar } from './ColorJar';

/** Giữ head "đầy" trên sân bấy nhiêu giây cho anim burst chạy hết rồi mới cho lọ kế dồn lên. */
const CLEAR_HOLD_SEC = 0.45;
/** Thời gian tween dồn cột — nguồn: ColorJarController.repositionDuration = 0.3. */
const REPOSITION_SEC = 0.3;

export interface JarColumnSpec {
  /** Lọ theo đúng thứ tự slot trong IR (slot 0 = head lúc bắt đầu). */
  jars: ColorJar[];
  /** Vị trí world của từng slot; slot i là chỗ đứng của lọ thứ i còn sống. */
  slots: Vec3[];
  /** Hộp hút của cột (rãnh đáy belt). */
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
