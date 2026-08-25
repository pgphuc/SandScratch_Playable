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
// NGỮ NGHĨA 4 CLIP — 2026-08-25 KHÔNG CÒN LÀ SUY ĐOÁN. Hai nguồn khớp nhau:
//   (a) thời lượng đọc thẳng từ clip đã import (library .bin, sample 30):
//       Idle = 0.017s (ĐÚNG 1 FRAME) · Open_box = 0.183s · Close = 0.517s · Fill = 1.3s
//   (b) `JarAnim.cs` chỉ giữ 3 field: idleClip · openClip · closeClip — KHÔNG có field nào trỏ clip Fill.
// Suy ra:
//   · Idle  = NẮP MỞ (1 frame). ĐÍNH CHÍNH 2026-08-25: user mở Unity xem tận mắt — POSE GỐC của prefab (chưa
//             phát clip nào) mới là NẮP ĐÓNG, còn clip Idle là nắp MỞ. Comment "idleClip = pose nắp đóng sẵn"
//             trong `JarAnim.cs` là SAI/lạc hậu, ĐỪNG tin nó lần nữa.
//             => pose chờ = KHÔNG PHÁT GÌ (`waitingPose: 'none'`), và `idleBetween` phải TẮT: về Idle = MỞ NẮP.
//   · Close = COLLAPSE lúc lọ ĐẦY, không phải "đóng nắp lúc rời head": nguồn gọi nó trong `PlayAnimCollapse`,
//             và móc duy nhất bấm nó là feedback `Fb - Merge` (lọ đầy). 0.517s -> hold của JarColumns phải
//             >= 0.52s, hold 0.45s cũ CẮT NGANG clip = nhìn ra "lọ biến mất, không có anim đóng".
//   · Fill  = KHÔNG ĐƯỢC NGUỒN DÙNG. Lúc nhận cát nguồn chạy `Fb - Fill` = [Particles, Scale punch], tức là
//             nhịp nảy (ColorJar.playPunch đã có) + khói, KHÔNG phải clip skeletal. Và clip Fill dài 1.3s trong
//             khi lọ đầy sau ~1-2s -> bấm 1 phát là khoá suốt lượt: đúng triệu chứng user báo 2026-08-25
//             ("chỉ play 2 lần: hạt đầu và hạt cuối"). Vì vậy `fillOnHarvest` MẶC ĐỊNH TẮT.
//
// THỨ TỰ ƯU TIÊN (một hộp chỉ chạy 1 clip):  close > open > fill > idle.
//   (chờ) — lọ CHƯA tới lượt: KHÔNG PHÁT CLIP NÀO, để nguyên pose gốc của prefab = nắp ĐÓNG
//            (`waitingPose: 'none'`, mặc định). 3 LẦN SỬA HỎNG trước đó, đừng đi lại: `closeEnd` (frame cuối
//            Close = hộp đã sập), `idle` (clip Idle = nắp MỞ), `openStart` (thừa — pose gốc đã đúng rồi).
//   open   — lọ vừa lên làm HEAD của cột (JarColumns) = lọ này bắt đầu nhận hạt.
//   fill   — lọ vừa hút được hạt. Clip LOOP: bấm 1 lần rồi để engine quay; `fill()` những lần sau chỉ RESET
//            ĐỒNG HỒ. Ngừng nhận cát `anim.fillStopAfter` giây -> `tickFillWatchdog` ghim frame cuối clip
//            Open (nắp mở tĩnh) và thôi quay. Bấm lại khi clip đang chạy = giật về frame 0, đừng làm.
//   close  — lọ đầy. STICKY: chạy xong GIỮ NGUYÊN pose cuối (nắp đóng), không quay về idle.
//   idle   — trạng thái nghỉ giữa hai lần trên (clip 1 frame = 1 pose tĩnh).
//
// CÔNG TẮC: khối "anim" trong assets/resources/data/board-layout.txt — tắt từng móc được (openOnHead ·
// fillOnHarvest · closeOnFull · idleBetween) + `speed`. Vì ngữ nghĩa 4 clip là suy ra từ TÊN, chưa soi mắt:
// nếu pose nhìn sai thì tắt móc ở file txt, KHÔNG phải sửa file này.

import { AnimationClip, Node, Quat, SkeletalAnimation, Vec3 } from 'cc';

/**
 * POSE NẮP ĐÓNG — nướng sẵn từ `Assets/Editor/_PlayableAdExtract/Box_Box_Idle.anim` của project Unity
 * (user chỉ định 2026-08-25). Clip đó chỉ có 2 keyframe giá trị y hệt nhau = 1 POSE TĨNH, nên không cần import
 * clip sang Cocos: đặt thẳng transform 3 node xương là xong — và cách này KHÔNG phụ thuộc clip nào có trong fbx,
 * tức thoát hẳn chỗ đã đoán sai 3 lần (Idle/Close/bind pose).
 * Số lấy ở keyframe time = 0 của m_RotationCurves / m_PositionCurves / m_ScaleCurves (scale đều = 1 nên bỏ).
 * Mấu chốt là `Box/Spine/Spine1` (nắp): quaternion (1, ~0, 0, ~0) = xoay 180° quanh X.
 */
const BOX_IDLE_POSE: { path: string; pos: [number, number, number]; rot: [number, number, number, number] }[] = [
  { path: 'Box', pos: [0, 0.0004980351, 0], rot: [0, 0, 0, 1] },
  { path: 'Box/Spine', pos: [0, 0, 0], rot: [0, 0, 0, 1] },
  { path: 'Box/Spine/Spine1', pos: [0.0035727024, 3.2206068, 1.4155364],
    rot: [1, -3.1391647e-7, 1.9221839e-23, -6.123234e-17] },
];

/**
 * Trần số dòng log của cả cảnh (mọi hộp dùng chung). Anim bị bấm mỗi sim step nên không có trần thì console
 * ngập và preview tụt fps. Đủ để đọc 1 vòng đời lọ.
 */
const LOG_CAP = 60;
let logLeft = LOG_CAP;

const _q = new Quat();
const _v = new Vec3();

/** Núm chỉnh anim hộp — khối "anim" trong board-layout.txt. */
export interface BoxAnimTuning {
  enabled: boolean;
  speed: number;
  /**
   * In log MỖI LẦN bấm clip + mỗi lần clip kết thúc (trần 60 dòng/cảnh). Bật khi anim 'không thấy chạy' để
   * biết là KHÔNG BẤM, hay bấm rồi mà clip câm. Tắt trước khi build P5.
   */
  log: boolean;
  openOnHead: boolean;
  /**
   * Nghỉ tối thiểu SAU KHI vòng Fill vừa bị watchdog dừng, trước khi được phép chạy lại (giây).
   * ⚠ ĐÍNH CHÍNH 2026-08-25: bản trước ghi đây là "nhịp bấm lại clip Fill" kèm lời hứa "ngừng nhận cát ->
   * không ai gọi fill() nữa -> vòng lặp tự dừng". Lời hứa đó SAI và chính comment trong `attach` đã thú nhận
   * ngược lại: clip Fill giữ `wrapMode = Loop` nên ENGINE quay vòng — có ai gọi `fill()` hay không cũng
   * không dừng được gì. Đường dừng thật là `fillStopAfter` ở dưới. Núm này giờ chỉ còn nhiệm vụ chống nhấp
   * nháy start/stop khi cát về nhỏ giọt.
   */
  fillEvery: number;
  /**
   * ĐƯỜNG DỪNG của vòng Fill (giây): không hút thêm được hạt nào trong bấy nhiêu giây thì ghim pose nắp mở
   * và thôi quay. Đồng hồ reset ở MỌI lời gọi `fill()`, kể cả lời gọi bị chặn không phát clip.
   * <= 0 = TẮT watchdog, quay lại hành vi cũ (quay tới khi clip khác cắt ngang) — chỉ để thử tay.
   */
  fillStopAfter: number;
  fillOnHarvest: boolean;
  closeOnFull: boolean;
  /**
   * Hết clip một-lần thì về pose Idle (= nắp đóng). CHỈ áp cho clip KHÔNG sticky; open/close đều sticky nên
   * núm này thực tế chỉ còn tác dụng khi bật `fillOnHarvest`. Mặc định TẮT.
   */
  idleBetween: boolean;
  /**
   * Pose lúc lọ CHƯA tới lượt. 'none' = không phát, không sample gì -> giữ bind pose của fbx (nắp đóng sẵn).
   */
  waitingPose: WaitingPose;
}

export const BOX_ANIM_DEFAULT: BoxAnimTuning = {
  enabled: true, speed: 1, log: true,
  openOnHead: true, fillEvery: 0.4, fillStopAfter: 0.25, fillOnHarvest: true, closeOnFull: true,
  idleBetween: false,
  waitingPose: 'none',
};

type Slot = 'idle' | 'fill' | 'close' | 'open';

/** Pose của lọ đang chờ tới lượt — núm `waitingPose` trong board-layout.txt. */
export type WaitingPose = 'boxIdle' | 'none' | 'openStart' | 'closeEnd' | 'idle';

/** Chuỗi lạ trong file txt -> rơi về 'none' (BoardVisual dùng để lọc). */
export const WAITING_POSES: WaitingPose[] = ['boxIdle', 'none', 'openStart', 'closeEnd', 'idle'];

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
  /**
   * Số frame còn phải ĐẶT LẠI pose chờ. `attach()` chạy trước khi AdRoot bật/tắt node lọ (`spec.hidden`), mà
   * node tắt-bật lại thì Animation re-init và pose sample được ở đây bay mất. Chỉ dùng khi waitingPose != 'none'.
   */
  private reposeFrames = 0;
  /** Giây nghỉ còn lại sau khi vòng Fill vừa bị dừng — chống nhấp nháy start/stop (núm `fillEvery`). */
  private fillCooldown = 0;
  /**
   * Giây kể từ lần `fill()` gần nhất (= lần lọ hút được hạt gần nhất). Watchdog trong `tick` đọc con số này
   * để biết lúc nào ngừng vòng Fill. Chỉ có nghĩa khi `cur === 'fill'`.
   */
  private fillIdle = 0;
  /** Gọi 1 lần khi clip đang chạy KẾT THÚC (kể cả clip sticky như close). */
  private endCb: (() => void) | null = null;

  private constructor(private readonly anim: SkeletalAnimation, private readonly root: Node,
                      private readonly t: BoxAnimTuning) {}

  /**
   * Bắt lấy SkeletalAnimation của hộp vừa instantiate.
   * @returns null nếu tắt trong tuning, hoặc prefab không có anim/clip (hộp đứng bind pose như bản trước).
   */
  static attach(box: Node, t: BoxAnimTuning): BoxAnim | null {
    if (!t.enabled) return null;
    const anim = box.getComponent(SkeletalAnimation);
    if (anim === null) return null;

    const self = new BoxAnim(anim, box, t);
    for (const clip of anim.clips) {
      if (clip === null) continue;
      const slot = SLOT_OF_SUFFIX[suffixOf(clip.name)];
      if (slot !== undefined && self.names[slot] === undefined) self.names[slot] = clip.name;
    }
    if (Object.keys(self.names).length === 0) return null;

    anim.playOnLoad = false;
    // WRAP MODE — trình import FBX của Cocos đặt `wrapMode = 2 (Loop)` cho CẢ 4 clip (đọc thẳng trong
    // `assets/resources/box/SKM_Box.fbx.meta`: Open_box/Close/Fill/Idle đều wrapMode:2). KHÔNG AI YÊU CẦU cái đó —
    // nó là mặc định của importer, và nó là lý do 'anim mở nắp quay vòng mãi' (user báo 2026-08-25). Lớp này tự
    // đếm `lock = duration` rồi giữ pose cuối (sticky), tức đã coi mọi clip là MỘT LẦN; giờ ép engine khớp lại.
    // FILL GIỮ NGUYÊN LOOP: vòng lặp liền mạch đó chính là thứ user đã duyệt ('fill play oke', 2026-08-25) —
    // chuyển Normal thì giữa 2 vòng hở đúng `fillEvery` giây, nhìn khác đi.
    // ⚠ CÁI GIÁ của việc giữ Loop: engine quay vòng TỰ THÂN, "không ai gọi fill() nữa" KHÔNG dừng được nó.
    // Tới 2026-08-25 lớp này chưa hề có đường dừng nào -> lọ ngừng nhận cát mà chưa đầy thì nắp nhấp nhô mãi
    // tới khi `close` cắt ngang (user báo). Đường dừng giờ là `tickFillWatchdog` + núm `anim.fillStopAfter`.
    for (const slot of Object.keys(self.names)) {
      if (slot !== 'fill') self.playOnce(self.names[slot]);
    }
    // ⚠ KHÔNG ĐỘNG VÀO useBakedAnimation. Bản trước ép `= false` với lý do 'chỉ 4 hộp, realtime skinning rẻ hơn
    // 1 tầng lệch' — và đó là NGUYÊN NHÂN GỐC của 'anim không chạy' suốt mấy phiên. Đo bằng CDP trên preview
    // (2026-08-25): clip chạy thật (animTime 0.10 -> 0.58, state=ok) nhưng quaternion của Box/Spine/Spine1 KHÔNG
    // đổi một lần nào, model đổi sang SkinningModel mà joint thì không ai cập nhật -> hộp đứng như tượng.
    // Prefab do fbx sinh ra để _useBakedAnimation = true; giữ nguyên, joint texture baked tự phát.
    if (t.log && logLeft > 0) {
      logLeft--;
      console.log('[boxAnim] attach ' + box.name + ' clip=[' + self.slots + '] waitingPose=' + t.waitingPose);
    }
    // Mặc định của MỌI hộp = đang chờ (nắp đóng). Lọ nào là head thì JarColumns gọi open() ngay sau đó.
    self.waiting();
    return self;
  }

  /**
   * Giỏ tra được + độ dài clip — boot log in ra để biết clip nào THIẾU, và clip nào tới runtime với duration 0
   * (import hỏng), mà không phải mở editor.
   */
  get slots(): string {
    return Object.keys(this.names)
      .map((k) => {
        const st = this.anim.getState(this.names[k]);
        return st === null ? k + '=?' : k + '=' + st.duration.toFixed(2) + 's';
      })
      .join(' ');
  }

  /**
   * Lọ chưa tới lượt. Mặc định ('none') là KHÔNG LÀM GÌ — bind pose của fbx đã là nắp đóng, mọi cú play/sample
   * ở đây chỉ có thể làm hỏng nó (đúng bug user báo: hộp dưới mở nắp từ giây 0).
   */
  waiting(): void {
    this.reposeFrames = this.t.waitingPose === 'none' ? 0 : 2;
    this.applyWaitingPose();
  }

  private applyWaitingPose(): void {
    switch (this.t.waitingPose) {
      case 'boxIdle':   this.applyBoxIdlePose(); break;   // ⚠ chỉ ăn khi useBakedAnimation = false
      case 'openStart': this.holdFrame('open', 0); break;
      case 'closeEnd':  this.holdFrame('close', -1); break;
      case 'idle':      this.play('idle', false); break;
      default:          this.cur = ''; this.sticky = false; this.lock = 0; break;
    }
  }

  /** Lọ vừa lên làm head của cột. */
  open(): void {
    if (!this.t.openOnHead) return;
    // open() phải cắt được pose chờ (sticky) — nếu không lọ head thứ 2 trở đi sẽ đứng nắp đóng suốt.
    this.lock = 0;
    this.sticky = false;
    this.reposeFrames = 0;
    // STICKY: mở xong GIỮ pose nắp mở suốt lượt nhận cát. Nguồn (Animancer) cũng giữ pose cuối openClip, và chỉ
    // về idle khi lọ RỜI head (`PlayAnimClose` -> Play(idleClip)). Không sticky thì `idleBetween` sẽ đóng nắp
    // lại ngay 0.18s sau khi mở — head vừa mở đã đóng.
    this.play('open', true);
  }

  /**
   * Lọ vừa hút được hạt — gọi mỗi sim step trong suốt lượt nhận (ColorJar.harvestWithMouth, chỉ khi got > 0).
   *
   * VAI TRÒ THẬT của hàm này = BÁO "vẫn còn cát về", không phải "bấm clip". Clip Fill giữ `wrapMode = Loop`
   * nên chỉ cần phát MỘT lần rồi engine tự quay; việc dừng do watchdog trong `tick` lo. Vì vậy:
   *   · reset `fillIdle` là việc PHẢI làm đầu tiên, TRƯỚC mọi đường return — các nhánh dưới thoát sớm rất
   *     thường xuyên (clip đang quay là ca phổ biến nhất), không reset ở đây thì watchdog đếm oan và cắt
   *     clip ngay giữa lượt đang nhận cát.
   *   · `cur === 'fill'` thì TUYỆT ĐỐI không `play` lại: clip đang quay mà bấm lại là nhảy về frame 0 giữa
   *     vòng = cú giật. (Bản trước bấm lại theo đồng hồ `fillEvery` nên giật đều đặn — user báo 2026-08-25
   *     'lúc loop lúc không', log headless xác nhận 29 dòng `play fill` cách nhau 0.4s.)
   * Clip `close` (sticky) đang chạy thì KHÔNG cho fill chen vào — lọ đầy rồi.
   */
  fill(): void {
    if (!this.t.fillOnHarvest) return;
    this.fillIdle = 0;
    if (this.sticky && this.cur === 'close') return;   // lọ đầy, đang collapse
    if (this.cur === 'fill') return;                   // vòng Loop đang quay -> để yên
    if (this.fillCooldown > 0) return;                 // vừa dừng xong, chưa hết nghỉ
    this.play('fill', false);
  }

  /**
   * Lọ đầy — clip collapse, giữ pose cuối.
   * @param onEnd bắn ĐÚNG lúc clip chạy hết (nguồn: Animancer `state.Events.OnEnd` trong `PlayAnimCollapse`).
   *        Tắt anim / thiếu clip -> gọi NGAY (fail-open: không có clip thì cũng không được treo lọ lại vĩnh viễn).
   */
  close(onEnd?: () => void): void {
    if (!this.t.closeOnFull || this.names.close === undefined) { onEnd?.(); return; }
    this.endCb = onEnd ?? null;
    this.play('close', true);
    if (this.lock <= 0) { this.endCb = null; onEnd?.(); }   // clip 0 giây (import hỏng) -> đừng treo lọ
  }

  /** Về trạng thái đầu (ScenarioRunner replay) = đang chờ, y như lúc vừa dựng. */
  reset(): void {
    this.lock = 0;
    this.sticky = false;
    this.endCb = null;
    this.fillCooldown = 0;
    this.fillIdle = 0;
    this.waiting();
  }

  /** Gọi mỗi FRAME từ ColorJar.update — chạy watchdog Fill, rồi hết clip một-lần thì rơi về idle. */
  tick(dt: number): void {
    if (this.reposeFrames > 0) { this.reposeFrames--; this.applyWaitingPose(); }
    if (this.fillCooldown > 0) this.fillCooldown -= dt;
    // Phải chạy TRƯỚC early-return dưới: clip Fill là Loop nên `lock` của nó = 0 (không có mốc kết thúc).
    this.tickFillWatchdog(dt);
    if (this.lock <= 0) return;
    this.lock -= dt;
    if (this.lock > 0) return;
    // Clip vừa kết thúc: bắn event TRƯỚC (kể cả clip sticky — close cần nó để tắt lọ đúng lúc anim xong).
    const cb = this.endCb;
    this.endCb = null;
    if (this.t.log && logLeft > 0) {
      logLeft--;
      console.log('[boxAnim] ' + this.root.name + ' end ' + this.cur + ' cb=' + (cb !== null));
    }
    if (cb !== null) { cb(); return; }
    if (this.sticky) return;
    // ⚠ về Idle = MỞ NẮP (xem đầu file). Chỉ chạy khi user cố ý bật idleBetween.
    if (this.t.idleBetween) this.play('idle', false);
  }

  /**
   * ĐƯỜNG DỪNG DUY NHẤT của vòng Fill (thêm 2026-08-25 — trước đó KHÔNG HỀ CÓ, đây là bug user báo: lọ ngừng
   * nhận cát mà chưa đầy thì nắp cứ nhấp nhô tới lúc `close` cắt ngang).
   *
   * VÌ SAO KHÔNG DỪNG BẰNG "hết người gọi fill()": clip Fill là clip DUY NHẤT giữ `wrapMode = Loop` (xem
   * `attach`) — engine quay vòng tự thân, không hỏi ai. Nên phải có đồng hồ chủ động cắt.
   *
   * DỪNG BẰNG GÌ: ghim frame CUỐI clip Open = pose nắp MỞ tĩnh — đúng trạng thái nghỉ của lọ đang là head
   * (nó vẫn đang chờ cát). KHÔNG dùng `play('open')`: nắp đã mở sẵn, phát lại clip 0.183s là một cú giật
   * thừa. KHÔNG dùng pose Idle: clip Idle là nắp MỞ nhưng đi qua `idleBetween` thì lệ thuộc núm khác, còn
   * frame cuối Open thì chắc chắn là chỗ clip Fill xuất phát.
   * Thiếu clip open (fbx khác) -> `anim.pause()`: giữ nguyên frame đang đứng, xấu hơn nhưng vẫn DỪNG.
   */
  private tickFillWatchdog(dt: number): void {
    if (this.cur !== 'fill' || this.t.fillStopAfter <= 0) return;
    this.fillIdle += dt;
    if (this.fillIdle < this.t.fillStopAfter) return;
    if (this.names.open !== undefined) {
      this.holdFrame('open', -1);
    } else {
      this.anim.pause();
      this.cur = '';
      this.sticky = false;
      this.lock = 0;
    }
    this.fillCooldown = this.t.fillEvery > 0 ? this.t.fillEvery : 0;
    if (this.t.log && logLeft > 0) {
      logLeft--;
      console.log('[boxAnim] ' + this.root.name + ' stop fill (idle '
                  + this.fillIdle.toFixed(2) + 's) -> ' + this.cur);
    }
  }

  /**
   * ⚠ CHỈ CÓ TÁC DỤNG KHI `useBakedAnimation = false`. Ở chế độ baked (mặc định của prefab fbx, và là chế độ
   * DUY NHẤT chạy được ở đây — xem ghi chú trong attach), skinning đọc joint texture chứ không đọc transform node,
   * nên đặt tay thế này KHÔNG hiện gì. Giữ lại làm đường lui, mặc định dùng `'idle'`.
   * Đặt thẳng transform 3 node xương theo pose nướng từ Box_Box_Idle.anim. KHÔNG phát clip nào -> không có gì
   * sample đè, và không phụ thuộc tên clip trong fbx. `anim.stop()` trước để clip đang chạy dở (replay) không
   * ghi đè pose vừa đặt.
   */
  private applyBoxIdlePose(): void {
    this.anim.stop();
    for (const j of BOX_IDLE_POSE) {
      const n = this.root.getChildByPath(j.path);
      if (n === null) continue;
      n.setPosition(_v.set(j.pos[0], j.pos[1], j.pos[2]));
      n.setRotation(_q.set(j.rot[0], j.rot[1], j.rot[2], j.rot[3]));
    }
    this.cur = '';
    this.sticky = false;
    this.lock = 0;
  }

  /** Nhảy tới 1 frame của clip rồi dừng — pose tĩnh, không phát animation. `time < 0` = frame cuối. */
  private holdFrame(slot: Slot, time: number): void {
    const name = this.names[slot];
    if (name === undefined) return;
    this.anim.play(name);
    const st = this.anim.getState(name);
    if (st !== null) {
      st.setTime(time < 0 ? st.duration : time);
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
    if (this.t.log && logLeft > 0) {
      logLeft--;
      console.log('[boxAnim] ' + this.root.name + ' play ' + slot + ' dur=' + dur.toFixed(3)
                  + ' sticky=' + sticky + ' state=' + (st === null ? 'NULL' : 'ok'));
    }
    this.cur = slot;
    this.sticky = sticky;
    this.reposeFrames = 0;
    if (slot === 'fill') this.fillIdle = 0;
    // Clip idle dài 1 frame (0.017s) -> lock ~0, đúng ý: idle không giữ chỗ của ai.
    // Clip fill là LOOP -> không có mốc kết thúc để đếm, `lock = dur` chỉ tạo ra một mốc GIẢ ở giây 1.3
    // (bản trước dùng nó để bấm lại clip = cú giật về frame 0). Vòng Fill do `tickFillWatchdog` sở hữu.
    this.lock = (slot === 'idle' || slot === 'fill') ? 0 : dur;
  }

  /**
   * Node SOCKET bám xương `path` — đường DUY NHẤT để treo vật thể đi theo anim ở chế độ baked: transform của
   * node xương đứng im (skinning đọc joint texture), chỉ socket được engine cập nhật từ dữ liệu clip đã nướng.
   * `path` phải là 1 trong 2 joint của skeleton (library @438fe): 'Box/Spine' (THÂN hộp) ·
   * 'Box/Spine/Spine1' (NẮP). Sai path -> engine warn 'illegal socket path' và trả null.
   */
  socket(path: string): Node | null {
    return this.anim.createSocket(path);
  }

  /**
   * Ép 1 clip chạy MỘT LẦN rồi dừng ở frame cuối. Phải set CẢ HAI chỗ: `clip.wrapMode` cho state dựng sau này,
   * và `state.wrapMode` cho state đã dựng rồi (state không đọc lại clip sau khi khởi tạo).
   */
  private playOnce(name: string): void {
    for (const clip of this.anim.clips) {
      if (clip !== null && clip.name === name) clip.wrapMode = AnimationClip.WrapMode.Normal;
    }
    const st = this.anim.getState(name);
    if (st !== null) st.wrapMode = AnimationClip.WrapMode.Normal;
  }

  /** Giỏ đang chạy — probe/log đọc. */
  get current(): string { return this.cur; }
}
