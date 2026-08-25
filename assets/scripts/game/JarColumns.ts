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
// · Cung bay visual của hạt (JarGrainVisual, parabol SandJump): PORT RỒI — game/JarFlyVisual.ts. Nó là VFX
//   thuần, không đổi số đếm; JarColumns chỉ báo ra qua callback `onHarvested` của harvest().

import { Node, Vec3, tween } from 'cc';
import type { MouthBounds } from '../solver/counting';
import type { GrainParticlePool } from '../solver/pool';
import type { ColorJar } from './ColorJar';

/**
  * TRẦN AN TOÀN (giây) cho lúc lọ đầy. Điều kiện tắt lọ THẬT là EVENT `ColorJar.closeAnimDone` — clip collapse
  * chạy xong thì tắt, đúng như nguồn (`PlayAnimCollapse` gắn `state.Events.OnEnd` rồi mới Destroy).
  * Con số này chỉ để lọ không kẹt vĩnh viễn nếu event không bao giờ tới (clip lỗi/anim tắt). Vẫn giữ >= thời
  * lượng burst của nguồn (Particles 0.5 + Pause 0.3 = 0.8s). Núm: "merge".holdSec trong board-layout.txt.
  */
const CLEAR_HOLD_SEC = 0.8;
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

/**
 * Ảnh chụp CHẨN ĐOÁN 1 cột — `StaticProbe.probeStatic` dùng để trả lời: hạt đang đứng im có nằm trong hộp hút
 * của cột nào không, và nếu có thì VÌ SAO chưa bị hút (khác màu head · cột hết chỗ · cột hết lọ).
 * Chỉ đọc, và chỉ chạy ở nhịp probe (2s/lần) — không nằm trên đường nóng.
 */
export interface JarColumnDiag {
  mouth: MouthBounds;
  /** colorId của head còn sống; -1 = cột đã hết lọ (không hút gì nữa). */
  colorId: number;
  colorName: string;
  /** Pixel head còn nhận được. 0 = đầy / đang chờ clip đóng -> hạt ĐÚNG MÀU nằm trong hộp cũng KHÔNG bị hút. */
  room: number;
  /** Số lọ đã rời sân của cột. */
  cleared: number;
}

class JarColumn {
  headIdx = 0;
  private clearTimer = -1;

  constructor(readonly spec: JarColumnSpec, private readonly holdSec: number,
              private readonly log: boolean) {}

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

    if (this.clearTimer < 0) this.clearTimer = this.holdSec;
    this.clearTimer -= dt;
    // Tắt lọ khi ANIM BÁO XONG; đồng hồ chỉ là trần an toàn phòng event không tới.
    if (!h.closeAnimDone && this.clearTimer > 0) return;

    if (this.log) {
      console.log('[boxAnim] ' + h.node.name + ' OFF closeAnimDone=' + h.closeAnimDone
                  + ' timerConLai=' + this.clearTimer.toFixed(3));
    }
    this.clearTimer = -1;
    h.node.active = false;
    this.headIdx++;
    this.reposition();
    // Head MỚI mở nắp ngay khi được đôn lên (không đợi tween dồn cột xong) — nó đã bắt đầu nhận hạt từ
    // step này rồi, vùng hút của cột là CỐ ĐỊNH chứ không đi theo lọ.
    this.head?.onBecomeHead();
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

  constructor(specs: JarColumnSpec[], holdSec: number = CLEAR_HOLD_SEC, log = false) {
    const hold = holdSec > 0 ? holdSec : CLEAR_HOLD_SEC;
    for (const s of specs) {
      this.columns.push(new JarColumn(s, hold, log));
      // Đặt lọ vào slot ngay lúc dựng (không tween) — frame đầu phải đã đúng chỗ.
      for (let i = 0; i < s.jars.length; i++) {
        const slot = s.slots[Math.min(i, s.slots.length - 1)];
        s.jars[i].node.setWorldPosition(slot);
        s.jars[i].markMouthDirty();
      }
      // Lọ slot 0 là head ngay từ frame đầu -> mở nắp luôn, cùng móc với lúc dồn cột.
      if (s.jars.length > 0) s.jars[0].onBecomeHead();
    }
  }

  /** Tổng số lọ đã rời sân — P6 đọc, và là số mà goal `jars_cleared` nói tới. */
  get clearedCount(): number {
    let n = 0;
    for (const c of this.columns) n += c.cleared;
    return n;
  }

  /**
   * `onHarvested` (tuỳ chọn) = móc cho tầng VFX: gọi 1 lần mỗi lọ THỰC SỰ hút được hạt lượt này.
   * Cố ý truyền `jar` chứ không truyền toạ độ: đích cung bay là chỗ ĐỨNG của lọ, mà chỗ đó đang tween khi
   * cột dồn -> đọc worldPosition tại thời điểm bắn mới đúng.
   */
  harvest(pool: GrainParticlePool, onHarvested?: (jar: ColorJar, got: number) => void): void {
    for (const c of this.columns) {
      const jar = c.head;
      const got = c.harvest(pool);
      if (got > 0 && jar !== null) onHarvested?.(jar, got);
    }
  }

  tickVisual(dt: number): void {
    for (const c of this.columns) c.tickVisual(dt);
  }

  /** Ảnh chụp chẩn đoán 4 cột cho probe/boot log. Cấp mảng mới mỗi lần gọi — chỉ gọi ở nhịp probe. */
  diag(): JarColumnDiag[] {
    return this.columns.map((c) => {
      const h = c.head;
      return {
        mouth: c.spec.mouth,
        colorId: h !== null ? h.colorId : -1,
        colorName: h !== null ? h.colorName : '-',
        room: h !== null ? h.room : 0,
        cleared: c.cleared,
      };
    });
  }
}
