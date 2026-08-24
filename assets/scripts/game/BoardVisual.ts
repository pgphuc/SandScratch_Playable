// ART NỀN — khung tranh · khung băng chuyền · dải băng · ảnh nền. Toàn bộ là PNG (không mesh).
//
// NGUỒN SỐ (đọc thẳng từ Unity, không đặt tay):
//   prefab !_Game_SDK/SandFlow/Prefab/GameBoard.prefab — root `GameBoard` scale 1.15, LevelSpawner đặt nó tại
//   gameBoardLocalPosition (0.025, 17) [ir/particles/__Game_SDK_Level_Prefabs_Game_Specifics.prefab.yaml:1137].
//   Con của nó (localPosition CHƯA nhân scale):
//     Artboard         (0,      0,      0.6)  <- Artboard.png       2160x4320 / PPU 100
//     khungbangchuyen  (0,     -11.88, -0.5)  <- khungbangchuyen.png 1604x593
//     bangchuyen1      (-0.06, -12.04, -0.5)  <- Bangchuyen2.png     1160x193
//   Cỡ world = px / PPU, rồi × 1.15 của root; vị trí world = (0.025, 17) + local × 1.15.
//
// KIỂM CHỨNG số này ĐÚNG (không phải ướm): khungbangchuyen ra tâm world (0.025, 3.34) và rộng 18.45 — trong khi
// vành băng chuyền dựng từ SDF nằm ở tâm (0, 3.2) rộng ~18.2. Hai đường hoàn toàn độc lập mà trùng nhau.
//
// Z: Unity camera nhìn +Z nên z LỚN = XA; Cocos ở đây camera nhìn -Z nên z lớn = GẦN => thứ tự lớp bị ĐẢO so với
// số Unity. Vì vậy z dưới đây đặt lại theo thứ tự lớp, không bê nguyên số z của prefab.
//
// ⚠ CHƯA làm: biến thể theo độ khó (*_Hard/_Veryhard — xem DifficultyViewSprite.cs) · khung1/2/3 · thanhchan ·
// Arrow · mask. Ad chỉ chạy 1 level Normal nên 4 lớp ở đây là đủ khung hình.

import { Color, Node, Texture2D } from 'cc';
import { attachQuad } from './QuadVisual';

/** Scale của root prefab GameBoard. */
const BOARD_SCALE = 1.15;
/** Chỗ LevelSpawner đặt prefab GameBoard (world 2D). */
const BOARD_X = 0.025;
const BOARD_Y = 17;
/** Unity PPU của cả bộ PNG này (spritePixelsToUnits trong .meta). */
const PPU = 100;

/** 1 lớp art: tên file trong resources/board + chỗ đặt local (theo prefab) + z lớp của ta. */
export interface BoardLayer {
  /** Đường dẫn resources (KHÔNG đuôi) — caller nạp rồi truyền texture vào. */
  res: string;
  /** localPosition trong prefab GameBoard, CHƯA nhân BOARD_SCALE. */
  localX: number;
  localY: number;
  /** Cỡ ảnh (pixel) — quy ra world bằng px / PPU × BOARD_SCALE. */
  pxW: number;
  pxH: number;
  z: number;
}

/**
 * 4 lớp nền, xếp từ XA tới GẦN. z chọn nằm hết phía sau Z_PICTURE (-0.05) và Z_GRAIN (0) của AdRoot: art nền
 * KHÔNG bao giờ được che cát hay tranh.
 */
export const BOARD_LAYERS: readonly BoardLayer[] = [
  // Ảnh nền không thuộc prefab GameBoard (nó là phông của cả cảnh) -> local (0,0) và tự phủ theo cỡ thật.
  { res: 'board/bg_ipad', localX: 0, localY: -4, pxW: 3000, pxH: 3231, z: -1.2 },
  { res: 'board/Artboard', localX: 0, localY: 0, pxW: 2160, pxH: 4320, z: -1.0 },
  { res: 'board/khungbangchuyen', localX: 0, localY: -11.88, pxW: 1604, pxH: 593, z: -0.9 },
  { res: 'board/Bangchuyen2', localX: -0.06, localY: -12.04, pxW: 1160, pxH: 193, z: -0.85 },
];

const WHITE = new Color(255, 255, 255, 255);

/**
 * Dựng các lớp nền có texture. Lớp nào thiếu texture thì BỎ HẲN (không vẽ ô màu thay) — nền giả dễ bị tưởng là
 * art thật rồi đi tune layout theo nó.
 * @param textures cùng thứ tự BOARD_LAYERS; null = chưa nạp được.
 * @returns số lớp thực sự dựng được.
 */
export function buildBoardVisual(parent: Node, textures: readonly (Texture2D | null)[]): number {
  const root = new Node('Board');
  root.setParent(parent);

  let built = 0;
  for (let i = 0; i < BOARD_LAYERS.length; i++) {
    const tex = textures[i] ?? null;
    if (tex === null) continue;
    const L = BOARD_LAYERS[i];
    const node = new Node(L.res.substring(L.res.lastIndexOf('/') + 1));
    node.setParent(root);
    node.setPosition(BOARD_X + L.localX * BOARD_SCALE, BOARD_Y + L.localY * BOARD_SCALE, L.z);
    // transparent = true: mọi PNG ở đây đều có alpha (khung tranh rỗng ruột, băng chuyền bo góc).
    attachQuad(node, (L.pxW / PPU) * BOARD_SCALE, (L.pxH / PPU) * BOARD_SCALE, WHITE, tex, true);
    built++;
  }
  return built;
}
