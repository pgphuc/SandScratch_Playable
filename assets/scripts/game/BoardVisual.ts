// ART NỀN — khung tranh · khung băng chuyền · dải băng · ảnh nền. Toàn bộ là PNG (không mesh).
//
// CHỈNH TAY Ở ĐÂU: `assets/resources/data/board-layout.txt` (JSON). Sửa số rồi RELOAD PREVIEW là thấy ngay —
// không phải sửa file này. Thiếu/hỏng file đó thì rơi về BOARD_DEFAULT dưới đây, ad vẫn chạy.
//
// NGUỒN SỐ MẶC ĐỊNH (đọc thẳng từ Unity, không đặt tay):
//   prefab !_Game_SDK/SandFlow/Prefab/GameBoard.prefab — root `GameBoard` scale 1.15, LevelSpawner đặt nó tại
//   gameBoardLocalPosition (0.025, 17) [ir/particles/__Game_SDK_Level_Prefabs_Game_Specifics.prefab.yaml:1137].
//   Con của nó (localPosition CHƯA nhân scale):
//     Artboard         (0,      0,      0.6)  <- Artboard.png       2160x4320 / PPU 100
//     khungbangchuyen  (0,     -11.88, -0.5)  <- khungbangchuyen.png 1604x593
//     bangchuyen1      (-0.06, -12.04, -0.5)  <- Bangchuyen2.png     1160x193
//   world = (0.025, 17) + local × 1.15 · cỡ world = px / 100 × 1.15.
//
// KIỂM CHỨNG số này ĐÚNG (không phải ướm): khungbangchuyen ra tâm world (0.025, 3.34) và rộng 18.45 — trong khi
// vành băng chuyền dựng từ SDF nằm ở tâm (0, 3.2) rộng ~18.2. Hai đường hoàn toàn độc lập mà trùng nhau.
//
// Z: Unity camera nhìn +Z nên z LỚN = XA; cảnh này camera nhìn -Z nên z lớn = GẦN => thứ tự lớp ĐẢO so với số z
// của prefab. Vì vậy z ở đây đặt lại theo thứ tự lớp, không bê nguyên số z Unity.
//
// VÌ SAO z TỚI -8 CHỨ KHÔNG PHẢI -1.2 NHƯ BẢN ĐẦU: hộp lọ là MESH 3D dày ~1.9 world (xoay rotX=45 thì ~2.6) và
// đuôi hộp thụt về SAU mặt phẳng lọ (z=0.2), tức chạm tới z ≈ -1.7..-2.4. Art nền ở -1.2/-1.0 nằm CHEN GIỮA nên
// pass transparent của nó vẽ đè lên ruột hộp (user báo 2026-08-25: "ruột hộp bị màu xanh bg_ipad che"). Camera
// ORTHO nên đẩy z ra xa KHÔNG đổi kích thước ảnh — chỉ đổi thứ tự che nhau, đây là sửa miễn phí.
//
// ⚠ CHƯA làm: biến thể theo độ khó (*_Hard/_Veryhard — xem DifficultyViewSprite.cs) · khung1/2/3 · thanhchan ·
// Arrow · mask. Ad chỉ chạy 1 level Normal nên 4 lớp ở đây là đủ khung hình.

import { Color, Node, Texture2D } from 'cc';
import { attachQuad } from './QuadVisual';
import { BOX_ANIM_DEFAULT, WAITING_POSES, type BoxAnimTuning, type WaitingPose } from './BoxAnim';
import { JAR_FILL_DEFAULT, type JarFillTuning } from './JarFillVisual';
import { JAR_FLY_DEFAULT, type JarFlyTuning } from './JarFlyVisual';
import { JAR_MERGE_DEFAULT, type JarMergeTuning } from './JarBurstVisual';

/** 1 lớp art nền, ĐÃ quy về world — đúng 6 số mà file board-layout.txt cho chỉnh. */
export interface BoardLayer {
  /** Đường dẫn resources (KHÔNG đuôi). Rỗng = bỏ lớp. */
  res: string;
  /** Tâm ảnh theo world. */
  x: number;
  y: number;
  /** Bề ngang/cao theo world. */
  w: number;
  h: number;
  /** Lớp vẽ; nhỏ hơn = xa hơn. Phải < Z_PICTURE (-0.05) để không che tranh/cát. */
  z: number;
}

/** Núm chỉnh hộp lọ (mesh SKM_Box) — cùng file JSON, xem BoxVisual.attachBox. */
export interface BoxTuning {
  w: number; h: number;
  dx: number; dy: number;
  /** Đẩy MẶT TRƯỚC hộp tới/lui theo z (world). Dương = ra gần màn hình. Bị kẹp dưới Z_CTA trong AdRoot. */
  dz: number;
  rotX: number; rotY: number; rotZ: number;
  scale: number;
  zScale: number;
}

/**
 * Núm HỘP HÚT (port `ObiJarSink`) — vùng NHẬN HẠT của mỗi cột. ⚠ KHÔNG phải chỗ đứng của lọ: nguồn đặt hộp ở
 * RÃNH ĐÁY BELT, cách tâm head jar 4 world LÊN TRÊN; lọ chỉ là đích của cung bay visual.
 * Hạt ĐÚNG MÀU head của cột + cột CÒN CHỖ mới bị hút; hạt KHÁC MÀU nằm trong hộp thì cứ nằm đó.
 */
export interface MouthTuning {
  /** Tâm hộp = tâm HEAD JAR + offsetY (world). Nguồn `autoMouthOffset = (0, 4, 0)`. */
  offsetY: number;
  /** Cỡ hộp (world). Nguồn `autoMouthSize = (2.3, 3)` — số SERIALIZE trên prefab, KHÔNG phải default trong .cs. */
  w: number;
  h: number;
  /** Vẽ khung hộp hút ra màn hình để soi mắt: hạt kẹt nằm TRONG hay NGOÀI hộp. TẮT trước P5. */
  debug: boolean;
}

/** Số nguồn từ prefab `Game Specifics` §ObiJarSink. Khai TRƯỚC BOARD_DEFAULT vì bị dùng ngay trong đó. */
export const MOUTH_DEFAULT: MouthTuning = { offsetY: 4, w: 2.3, h: 3, debug: false };

export interface BoardLayout {
  board: BoardLayer[];
  box: BoxTuning;
  /** Công tắc anim hộp (Idle/Fill/Close/Open_box) — xem BoxAnim.ts. */
  anim: BoxAnimTuning;
  /** Mực cát dâng + khói khi lọ nhận cát — xem JarFillVisual.ts. */
  fill: JarFillTuning;
  /** Cung bay của hạt từ rãnh belt vào lọ (port ObiJarSink) — xem JarFlyVisual.ts. */
  fly: JarFlyTuning;
  /** Burst + thời gian nán lại lúc lọ ĐẦY (port Fb - Merge) — xem JarBurstVisual.ts. */
  merge: JarMergeTuning;
  /** Hộp hút của từng cột (port ObiJarSink) — xem MouthTuning. */
  mouth: MouthTuning;
}

/** Rơi về đây khi board-layout.txt thiếu/hỏng. Số y hệt bản trong file JSON. */
export const BOARD_DEFAULT: BoardLayout = {
  board: [
    { res: 'board/bg_ipad', x: 0.025, y: 12.4, w: 34.5, h: 37.157, z: -8 },
    { res: 'board/Artboard', x: 0.025, y: 17, w: 24.84, h: 49.68, z: -7 },
    { res: 'board/khungbangchuyen', x: 0.025, y: 3.338, w: 18.446, h: 6.82, z: -6 },
    { res: 'board/Bangchuyen2', x: -0.044, y: 3.154, w: 13.34, h: 2.22, z: -5.9 },
  ],
  box: { w: 3.6, h: 2.6, dx: 0, dy: 0, dz: 0, rotX: 0, rotY: 0, rotZ: 0, scale: 1, zScale: 1 },
  anim: BOX_ANIM_DEFAULT,
  fill: JAR_FILL_DEFAULT,
  fly: JAR_FLY_DEFAULT,
  merge: JAR_MERGE_DEFAULT,
  mouth: MOUTH_DEFAULT,
};

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && isFinite(v) ? v : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

/**
 * Đọc JSON chỉnh tay. Hỏng ở đâu thì vá chỗ đó bằng mặc định — KHÔNG vứt cả file, vì người chỉnh tay hay để lỡ
 * 1 dấu phẩy và mất trắng layout thì khó hiểu hơn nhiều so với 1 lớp lệch.
 */
export function parseBoardLayout(text: string): BoardLayout {
  const raw = JSON.parse(text) as Partial<BoardLayout>;
  const d = BOARD_DEFAULT;
  const box = (raw.box ?? {}) as Partial<BoxTuning>;
  const anim = (raw.anim ?? {}) as Partial<BoxAnimTuning>;
  const fill = (raw.fill ?? {}) as Partial<JarFillTuning>;
  const fly = (raw.fly ?? {}) as Partial<JarFlyTuning>;
  const merge = (raw.merge ?? {}) as Partial<JarMergeTuning>;
  const mouth = (raw.mouth ?? {}) as Partial<MouthTuning>;
  const layers = Array.isArray(raw.board) ? raw.board : d.board;
  return {
    board: layers
      .filter((L) => typeof L?.res === 'string' && L.res !== '')
      .map((L, i) => {
        const f = d.board[i] ?? d.board[0];
        return {
          res: L.res, x: num(L.x, f.x), y: num(L.y, f.y),
          w: num(L.w, f.w), h: num(L.h, f.h), z: num(L.z, f.z),
        };
      }),
    box: {
      w: num(box.w, d.box.w), h: num(box.h, d.box.h),
      dx: num(box.dx, d.box.dx), dy: num(box.dy, d.box.dy), dz: num(box.dz, d.box.dz),
      rotX: num(box.rotX, d.box.rotX), rotY: num(box.rotY, d.box.rotY), rotZ: num(box.rotZ, d.box.rotZ),
      scale: num(box.scale, d.box.scale), zScale: num(box.zScale, d.box.zScale),
    },
    anim: {
      enabled: bool(anim.enabled, d.anim.enabled),
      speed: num(anim.speed, d.anim.speed),
      log: bool(anim.log, d.anim.log),
      openOnHead: bool(anim.openOnHead, d.anim.openOnHead),
      fillEvery: num(anim.fillEvery, d.anim.fillEvery),
      fillStopAfter: num(anim.fillStopAfter, d.anim.fillStopAfter),
      fillOnHarvest: bool(anim.fillOnHarvest, d.anim.fillOnHarvest),
      closeOnFull: bool(anim.closeOnFull, d.anim.closeOnFull),
      idleBetween: bool(anim.idleBetween, d.anim.idleBetween),
      waitingPose: WAITING_POSES.indexOf(anim.waitingPose as WaitingPose) >= 0
        ? (anim.waitingPose as WaitingPose) : d.anim.waitingPose,
    },
    fill: {
      enabled: bool(fill.enabled, d.fill.enabled),
      w: num(fill.w, d.fill.w), h: num(fill.h, d.fill.h),
      dx: num(fill.dx, d.fill.dx), dy: num(fill.dy, d.fill.dy), dz: num(fill.dz, d.fill.dz),
      range: num(fill.range, d.fill.range),
      smoke: bool(fill.smoke, d.fill.smoke),
      smokeEvery: num(fill.smokeEvery, d.fill.smokeEvery),
      smokeCount: num(fill.smokeCount, d.fill.smokeCount),
      smokeSize: num(fill.smokeSize, d.fill.smokeSize),
      smokeLife: num(fill.smokeLife, d.fill.smokeLife),
      smokeRise: num(fill.smokeRise, d.fill.smokeRise),
      smokeSpread: num(fill.smokeSpread, d.fill.smokeSpread),
      smokeAlpha: num(fill.smokeAlpha, d.fill.smokeAlpha),
      smokeWhite: num(fill.smokeWhite, d.fill.smokeWhite),
      smokeDx: num(fill.smokeDx, d.fill.smokeDx),
      smokeDy: num(fill.smokeDy, d.fill.smokeDy),
      smokeFollowFill: bool(fill.smokeFollowFill, d.fill.smokeFollowFill),
    },
    fly: {
      enabled: bool(fly.enabled, d.fly.enabled),
      size: num(fly.size, d.fly.size),
      landOffsetX: num(fly.landOffsetX, d.fly.landOffsetX),
      landOffsetY: num(fly.landOffsetY, d.fly.landOffsetY),
      landOffsetZ: num(fly.landOffsetZ, d.fly.landOffsetZ),
      jumpPower: num(fly.jumpPower, d.fly.jumpPower),
      jumpPeakFrac: num(fly.jumpPeakFrac, d.fly.jumpPeakFrac),
      jumpDuration: num(fly.jumpDuration, d.fly.jumpDuration),
      jumpPowerJitter: num(fly.jumpPowerJitter, d.fly.jumpPowerJitter),
      jumpDurationJitter: num(fly.jumpDurationJitter, d.fly.jumpDurationJitter),
      landBandWidth: num(fly.landBandWidth, d.fly.landBandWidth),
      landSpread: num(fly.landSpread, d.fly.landSpread),
      arcLanes: num(fly.arcLanes, d.fly.arcLanes),
      arcLaneSpread: num(fly.arcLaneSpread, d.fly.arcLaneSpread),
      arcLaneJitter: num(fly.arcLaneJitter, d.fly.arcLaneJitter),
      capacity: num(fly.capacity, d.fly.capacity),
      sampleEvery: num(fly.sampleEvery, d.fly.sampleEvery),
    },
    merge: {
      enabled: bool(merge.enabled, d.merge.enabled),
      holdSec: num(merge.holdSec, d.merge.holdSec),
      count: num(merge.count, d.merge.count),
      size: num(merge.size, d.merge.size),
      sizeEnd: num(merge.sizeEnd, d.merge.sizeEnd),
      life: num(merge.life, d.merge.life),
      speed: num(merge.speed, d.merge.speed),
      gravity: num(merge.gravity, d.merge.gravity),
      spin: num(merge.spin, d.merge.spin),
      white: num(merge.white, d.merge.white),
    },
    mouth: {
      offsetY: num(mouth.offsetY, d.mouth.offsetY),
      w: num(mouth.w, d.mouth.w), h: num(mouth.h, d.mouth.h),
      debug: bool(mouth.debug, d.mouth.debug),
    },
  };
}

const WHITE = new Color(255, 255, 255, 255);

/**
 * Dựng các lớp nền có texture. Lớp nào thiếu texture thì BỎ HẲN (không vẽ ô màu thay) — nền giả dễ bị tưởng là
 * art thật rồi đi tune layout theo nó.
 * @param textures cùng thứ tự `layers`; null = chưa nạp được.
 * @returns số lớp thực sự dựng được.
 */
export function buildBoardVisual(parent: Node, layers: readonly BoardLayer[],
                                 textures: readonly (Texture2D | null)[]): number {
  const root = new Node('Board');
  root.setParent(parent);

  let built = 0;
  for (let i = 0; i < layers.length; i++) {
    const tex = textures[i] ?? null;
    if (tex === null) continue;
    const L = layers[i];
    const node = new Node(L.res.substring(L.res.lastIndexOf('/') + 1));
    node.setParent(root);
    node.setPosition(L.x, L.y, L.z);
    // transparent = true: mọi PNG ở đây đều có alpha (khung tranh rỗng ruột, băng chuyền bo góc).
    attachQuad(node, L.w, L.h, WHITE, tex, true);
    built++;
  }
  return built;
}
