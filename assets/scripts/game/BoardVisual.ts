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
// ⚠ CHƯA làm: biến thể theo độ khó (*_Hard/_Veryhard — xem DifficultyViewSprite.cs) · khung1/2/3 · thanhchan ·
// Arrow · mask. Ad chỉ chạy 1 level Normal nên 4 lớp ở đây là đủ khung hình.

import { Color, Node, Texture2D } from 'cc';
import { attachQuad } from './QuadVisual';

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
  rotX: number; rotY: number; rotZ: number;
  scale: number;
}

export interface BoardLayout {
  board: BoardLayer[];
  box: BoxTuning;
}

/** Rơi về đây khi board-layout.txt thiếu/hỏng. Số y hệt bản trong file JSON. */
export const BOARD_DEFAULT: BoardLayout = {
  board: [
    { res: 'board/bg_ipad', x: 0.025, y: 12.4, w: 34.5, h: 37.157, z: -1.2 },
    { res: 'board/Artboard', x: 0.025, y: 17, w: 24.84, h: 49.68, z: -1.0 },
    { res: 'board/khungbangchuyen', x: 0.025, y: 3.338, w: 18.446, h: 6.82, z: -0.9 },
    { res: 'board/Bangchuyen2', x: -0.044, y: 3.154, w: 13.34, h: 2.22, z: -0.85 },
  ],
  box: { w: 3.6, h: 2.6, dx: 0, dy: 0, rotX: 0, rotY: 0, rotZ: 0, scale: 1 },
};

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && isFinite(v) ? v : fallback);

/**
 * Đọc JSON chỉnh tay. Hỏng ở đâu thì vá chỗ đó bằng mặc định — KHÔNG vứt cả file, vì người chỉnh tay hay để lỡ
 * 1 dấu phẩy và mất trắng layout thì khó hiểu hơn nhiều so với 1 lớp lệch.
 */
export function parseBoardLayout(text: string): BoardLayout {
  const raw = JSON.parse(text) as Partial<BoardLayout>;
  const d = BOARD_DEFAULT;
  const box = (raw.box ?? {}) as Partial<BoxTuning>;
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
      dx: num(box.dx, d.box.dx), dy: num(box.dy, d.box.dy),
      rotX: num(box.rotX, d.box.rotX), rotY: num(box.rotY, d.box.rotY), rotZ: num(box.rotZ, d.box.rotZ),
      scale: num(box.scale, d.box.scale),
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
