// ANIM CỦA HỘP LỌ — 4 clip skeletal có sẵn trong SKM_Box.fbx: Idle · Fill · Close · Open_box.
//
// KHÔNG PHẢI PORT TAY: clip đã nằm trong fbx và editor đã import chúng thành sub-asset, ĐỒNG THỜI prefab
// `SKM_Box.prefab` do fbx sinh ra ĐÃ mang sẵn 1 `cc.SkeletalAnimation` trỏ đủ 4 clip (đọc từ library JSON của
// fbx: _clips = [@53699 Open_box, @7dd5f Close, @0b9dd Fill, @77ecd Idle], playOnLoad=false). Nên "port" ở đây
// = BẤM ĐÚNG CLIP ĐÚNG LÚC, không phải nạp clip. Không cần uuid, không cần sửa .prefab/.scene.
//
// TÊN CLIP: Cocos giữ nguyên tên FBX "Box|Box|Fill" -> tra theo ĐUÔI sau dấu `|` cuối, không so khớp cả chuỗi
// (đổi tên rig bên Unity là chuỗi đầu đổi, đuôi thì không).
//
// ĐƯỜNG CURVE CỦA CLIP nằm ở "Box", "Box/Spine", "Box/Spine/Spine1", "Box/Spine/Spine1/Spine1_end",
// "MOD_Box_Xam" — TOÀN LÀ CON. Node gốc SKM_Box KHÔNG bị clip đụng => transform fit khung (scale/pos do
// BoxVisual.attachBox đặt) và tween punch của ColorJar KHÔNG bị anim ghi đè. Đây là lý do anim ghép được vào
// mà không phải bọc thêm 1 node trung gian.
//
// VÌ SAO TẮT BAKED: prefab để `_useBakedAnimation = true` (mặc định của fbx importer). Baked pre-sample skeleton
// vào joint texture — rẻ khi có hàng chục instance, nhưng cảnh này chỉ 3-4 hộp, còn material thì tự dựng
// (builtin-unlit + getMaterialInstance cho từng màu) nên đường baked thêm một chỗ nữa để lệch macro. Realtime
// skinning với 4 joint × 4 hộp là không đáng kể mà đường đi ngắn hơn 1 tầng.
//
// THỨ TỰ ƯU TIÊN (một hộp chỉ chạy 1 clip):  close > open > fill > idle.
//   (chờ) — lọ CHƯA tới lượt (không phải head) đứng ở POSE CUỐI của clip Close = nắp đóng. Không phải "phát
//            clip Close" mà là NHẢY THẲNG tới frame cuối rồi pause: 4 hộp cùng đóng nắp ở giây 0 thì nhìn như
//            lỗi. Tắt bằng `closedWhenWaiting` nếu pose đó không phải nắp đóng như suy đoán.
//   open   — lọ vừa lên làm HEAD của cột (JarColumns) = lọ này bắt đầu nhận hạt.
//   fill   — lọ vừa hút được hạt. Xin liên tục mỗi sim step nên KHÔNG bấm lại khi clip đang chạy, nếu không
//            hộp sẽ giật ở frame đầu clip suốt cả lượt.
//   close  — lọ đầy. STICKY: chạy xong GIỮ NGUYÊN pose cuối (nắp đóng), không quay về idle.
//   idle   — trạng thái nghỉ giữa hai lần trên (clip 1 frame = 1 pose tĩnh).
//
// CÔNG TẮC: khối "anim" trong assets/resources/data/board-layout.txt — tắt từng móc được (openOnHead ·
// fillOnHarvest · closeOnFull · idleBetween) + `speed`. Vì ngữ nghĩa 4 clip là suy ra từ TÊN, chưa soi mắt:
// nếu pose nhìn sai thì tắt móc ở file txt, KHÔNG phải sửa file này.

import { Node, SkeletalAnimation } from 'cc';

/** Núm chỉnh anim hộp — khối "anim" trong board-layout.txt. */
export interface BoxAnimTuning {
  enabled: boolean;
  speed: number;
  openOnHead: boolean;
  fillOnHarvest: boolean;
  closeOnFull: boolean;
  idleBetween: boolean;
  /** Lọ chưa tới lượt đứng ở pose nắp ĐÓNG (frame cuối clip Close) thay vì pose Idle. */
  closedWhenWaiting: boolean;
}

export const BOX_ANIM_DEFAULT: BoxAnimTuning = {
  enabled: true, speed: 1,
  openOnHead: true, fillOnHarvest: true, closeOnFull: true, idleBetween: true, closedWhenWaiting: true,
};

type Slot = 'idle' | 'fill' | 'close' | 'open';

/** Đuôi tên clip (sau dấu `|` cuối, đã hạ chữ thường) -> giỏ. */
const SLOT_OF_SUFFIX: { [k: string]: Slot } = {
  idle: 'idle', fill: 'fill', close: 'close', open_box: 'open', open: 'open',
};

function suffixOf(clipName: string): string {
  const i = clipName.lastIndexOf('|');
  return (i < 0 ? clipName : clipName.substring(i + 1)).toLowerCase();
}

export class BoxAnim {
  private readonly names: { [k: string]: string } = {};
  private cur: Slot | '' = '';
  /** Giây còn lại mà clip đang chạy KHÔNG được nhường cho clip ưu tiên thấp hơn. */
  private lock = 0;
  /** Clip đang chạy giữ pose cuối (close) — hết lock cũng không về idle. */
  private sticky = false;

  private constructor(private readonly anim: SkeletalAnimation, private readonly t: BoxAnimTuning) {}

  /**
   * Bắt lấy SkeletalAnimation của hộp vừa instantiate.
   * @returns null nếu tắt trong tuning, hoặc prefab không có anim/clip (hộp đứng bind pose như bản trước).
   */
  static attach(box: Node, t: BoxAnimTuning): BoxAnim | null {
    if (!t.enabled) return null;
    const anim = box.getComponent(SkeletalAnimation);
    if (anim === null) return null;

    const self = new BoxAnim(anim, t);
    for (const clip of anim.clips) {
      if (clip === null) continue;
      const slot = SLOT_OF_SUFFIX[suffixOf(clip.name)];
      if (slot !== undefined && self.names[slot] === undefined) self.names[slot] = clip.name;
    }
    if (Object.keys(self.names).length === 0) return null;

    anim.playOnLoad = false;
    anim.useBakedAnimation = false;
    // Mặc định của MỌI hộp = đang chờ (nắp đóng). Lọ nào là head thì JarColumns gọi open() ngay sau đó.
    self.waiting();
    return self;
  }

  /** Danh sách giỏ tra được — boot log in ra để biết clip nào thiếu mà không phải mở editor. */
  get slots(): string { return Object.keys(this.names).join('+'); }

  /** Lọ chưa tới lượt: đứng im ở pose nắp đóng (không phát clip). */
  waiting(): void {
    if (this.t.closedWhenWaiting && this.names.close !== undefined) this.holdEnd('close');
    else this.play('idle', false);
  }

  /** Lọ vừa lên làm head của cột. */
  open(): void {
    if (!this.t.openOnHead) return;
    // open() phải cắt được pose chờ (sticky) — nếu không lọ head thứ 2 trở đi sẽ đứng nắp đóng suốt.
    this.lock = 0;
    this.sticky = false;
    this.play('open', false);
  }

  /** Lọ vừa hút được hạt. Gọi mỗi sim step cũng an toàn — clip đang chạy thì bỏ qua. */
  fill(): void {
    if (!this.t.fillOnHarvest) return;
    if (this.lock > 0) return;
    this.play('fill', false);
  }

  /** Lọ đầy — clip cuối cùng, giữ pose. */
  close(): void { if (this.t.closeOnFull) this.play('close', true); }

  /** Về trạng thái đầu (ScenarioRunner replay) = đang chờ, y như lúc vừa dựng. */
  reset(): void {
    this.lock = 0;
    this.sticky = false;
    this.waiting();
  }

  /** Gọi mỗi FRAME từ ColorJar.update — hết clip một-lần thì rơi về idle. */
  tick(dt: number): void {
    if (this.lock <= 0) return;
    this.lock -= dt;
    if (this.lock > 0 || this.sticky) return;
    if (this.t.idleBetween) this.play('idle', false);
  }

  /** Nhảy thẳng tới frame CUỐI của clip rồi dừng — dùng cho pose tĩnh, không phát animation. */
  private holdEnd(slot: Slot): void {
    const name = this.names[slot];
    if (name === undefined) return;
    this.anim.play(name);
    const st = this.anim.getState(name);
    if (st !== null) {
      st.setTime(st.duration);
      st.sample();
      st.pause();
    }
    this.cur = slot;
    this.sticky = true;
    this.lock = 0;
  }

  private play(slot: Slot, sticky: boolean): void {
    const name = this.names[slot];
    if (name === undefined) return;
    // `close` được phép cắt ngang mọi thứ; các clip khác đã bị chặn ở lock trước khi tới đây.
    this.anim.play(name);
    const st = this.anim.getState(name);
    const speed = this.t.speed > 0 ? this.t.speed : 1;
    let dur = 0;
    if (st !== null) {
      st.speed = speed;
      dur = st.duration / speed;
    }
    this.cur = slot;
    this.sticky = sticky;
    // Clip idle dài 1 frame (0.017s) -> lock ~0, đúng ý: idle không giữ chỗ của ai.
    this.lock = slot === 'idle' ? 0 : dur;
  }

  /** Giỏ đang chạy — probe/log đọc. */
  get current(): string { return this.cur; }
}
