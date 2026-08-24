// Nạp 1 level đã BAKE (assets/data/levels/level-NNNN.txt, base64 của định dạng SLB1) và biến nó thành thứ mà
// lớp gameplay dùng được: carve model + palette màu + danh sách lọ.
//
// Đây là chỗ DUY NHẤT đọc hình dạng dữ liệu level. Mọi file khác nhận sản phẩm đã dựng, không tự lội `LevelAsset`.
//
// GRID CƠ CHẾ vs VIEW — số thật của Release Level 0001:
//   pixelLevelData 200×200 (cơ chế: indices + sourceColors, 40 000 phần tử)
//   pixelViewData  400×400 (hiển thị: colors, 160 000 phần tử)  -> viewScale 2
//
// PALETTE: `indices[i]` là colorId của pixel cơ chế i, `sourceColors[i]` là màu hex của CHÍNH pixel đó. Nên palette
// dựng bằng cách quét 1 lượt và lấy hex ĐẦU TIÊN gặp cho mỗi colorId — không nội suy, không bịa.

import { decodeLevelFromBase64, type LevelAsset, type Jar } from '../levelbake/decode';
import { PictureCarveModel } from '../solver/carveModel';
import { hexOfColorName } from './ColorNames';

export interface JarSpec {
  /** Cột chứa lọ (0-based, theo colorJarColumns). */
  column: number;
  /** Thứ tự trong cột, 0 = trên cùng theo đúng thứ tự IR. */
  slot: number;
  /** Tên màu như IR ghi ("Yellow5"). Dùng để map sang colorId + material. */
  colorName: string;
  capacity: number;
  hidden: boolean;
  connectorId: number;
}

export interface LoadedLevel {
  asset: LevelAsset;

  mechWidth: number;
  mechHeight: number;
  viewWidth: number;
  viewHeight: number;

  /** colorId theo pixel cơ chế (hàng-trước). -1 = pixel trống. */
  colorIds: Int32Array;
  /** colorId -> RGBA 0..1, stride 4. Độ dài = (maxColorId+1)*4. */
  palette: Float32Array;
  /** Màu hex lưới VIEW cho PictureTexture. */
  viewColors: readonly string[];

  /** viewportHeight của level; == mechHeight nghĩa là KHÔNG scroll. */
  viewportRows: number;
  columnCount: number;
  noSwipeBandHeight: number;
  grainyLook: boolean;

  jars: JarSpec[];
}

/** Giải nén + chuẩn hoá 1 level từ nội dung TextAsset (base64). */
export function loadLevel(base64: string): LoadedLevel {
  const asset = decodeLevelFromBase64(base64);
  const d = asset.data;
  const p = d.pixelLevelData;
  const v = d.pixelViewData;

  const mechWidth = p.width | 0;
  const mechHeight = p.height | 0;
  const n = mechWidth * mechHeight;

  const idx = p.indices.items;
  const src = p.sourceColors.items;

  const colorIds = new Int32Array(n);
  // Palette dựng theo colorId lớn nhất THẬT gặp được, không theo số phần tử sourceColors.
  let maxColorId = -1;
  const count = Math.min(n, idx.length);
  for (let i = 0; i < count; i++) {
    const c = idx[i] | 0;
    colorIds[i] = c;
    if (c > maxColorId) maxColorId = c;
  }
  // idx NGẮN hơn n (IR cụt): phần còn lại để 0 sẽ thành màu 0 = SAI (pixel trống hoá đặc). Ép -1 tường minh.
  for (let i = count; i < n; i++) colorIds[i] = -1;

  const palette = new Float32Array((maxColorId + 1) * 4);
  const seen = new Uint8Array(maxColorId + 1);
  for (let i = 0; i < count; i++) {
    const c = colorIds[i];
    if (c < 0 || seen[c] !== 0) continue;
    const rgba = parseHex(src[i]);
    if (rgba === null) continue;             // hex lạ -> chưa chốt, để colorId sau điền
    seen[c] = 1;
    palette[c * 4] = rgba[0];
    palette[c * 4 + 1] = rgba[1];
    palette[c * 4 + 2] = rgba[2];
    palette[c * 4 + 3] = rgba[3];
  }

  const jars: JarSpec[] = [];
  const cols = d.colorJarColumns.items;
  for (let ci = 0; ci < cols.length; ci++) {
    const list = cols[ci].jars.items;
    for (let si = 0; si < list.length; si++) {
      const j: Jar = list[si];
      jars.push({
        column: ci,
        slot: si,
        colorName: j.color,
        capacity: j.capacity | 0,
        hidden: !!j.hidden,
        connectorId: j.connectorId | 0,
      });
    }
  }

  return {
    asset,
    mechWidth, mechHeight,
    viewWidth: v.width | 0,
    viewHeight: v.height | 0,
    colorIds,
    palette,
    viewColors: v.colors.items,
    viewportRows: p.viewportHeight | 0,
    columnCount: Math.max(1, p.columnCount | 0),
    noSwipeBandHeight: p.noSwipeBandHeight | 0,
    grainyLook: !!d.grainyLook,
    jars,
  };
}

/**
 * Dựng carve model từ level đã nạp.
 *
 * `occCellPixels = 1`: đường Grain LUÔN fine per-pixel — nguồn `BuildOccupancyField` ép như vậy, và
 * `GrainOccupancyField.occCellPixels` trong occupancy.ts ghi rõ điều đó. Truyền 4 (default của ctor) sẽ làm
 * occupancy thô gấp 4 so với field mà solver đọc => hạt xuyên tranh.
 *
 * `exitMinPx/exitMaxPx = -1` (full-width): level 0001 không có dải chặn (`noSwipeBandHeight = 0`) nên cả hàng đáy
 * là cửa thoát. Level có dải chặn phải truyền biên thật, không được để -1.
 */
export function buildCarveModel(level: LoadedLevel, escapeSlideCells: number): PictureCarveModel {
  return new PictureCarveModel(
    level.mechWidth, level.mechHeight, level.colorIds,
    /* occCellPixels */ 1,
    /* exitMinPx */ -1,
    /* exitMaxPx */ -1,
    escapeSlideCells,
  );
}

/**
 * colorId của một TÊN màu lọ ("Yellow5"). IR không có bảng tên->colorId trực tiếp, nên nối 2 bên qua HEX:
 * tên -> hex (COLOR_NAME_HEX, bake từ material) -> tìm colorId trong palette level có RGB khớp.
 *
 * So sánh RGB theo BYTE (làm tròn 0..255) chứ không so float: palette dựng từ hex nên phải khớp tuyệt đối; so float
 * sẽ trượt vì 0xFF/255 round-trip. Bỏ qua alpha — tên màu không mang alpha.
 *
 * Trả -1 nếu tên lạ hoặc level không dùng màu đó. Caller PHẢI xử -1 (lọ không map được = không đếm được hạt),
 * không được coi 0 là mặc định.
 */
export function colorIdOfJarName(level: LoadedLevel, colorName: string): number {
  const hex = hexOfColorName(colorName);
  if (hex < 0) return -1;
  const r = (hex >>> 16) & 0xff, g = (hex >>> 8) & 0xff, b = hex & 0xff;
  const pal = level.palette;
  const n = (pal.length / 4) | 0;
  for (let c = 0; c < n; c++) {
    const o = c * 4;
    if (pal[o + 3] === 0) continue;                       // slot chưa điền
    if (Math.round(pal[o] * 255) !== r) continue;
    if (Math.round(pal[o + 1] * 255) !== g) continue;
    if (Math.round(pal[o + 2] * 255) !== b) continue;
    return c;
  }
  return -1;
}

/** "#RRGGBB" / "#RRGGBBAA" -> [r,g,b,a] 0..1. null nếu không parse được. */
function parseHex(hex: string | null | undefined): [number, number, number, number] | null {
  if (!hex) return null;
  const s = hex.charCodeAt(0) === 35 ? hex.slice(1) : hex;
  if (s.length !== 6 && s.length !== 8) return null;
  const v = parseInt(s, 16);
  if (!Number.isFinite(v)) return null;
  if (s.length === 6) {
    return [((v >>> 16) & 0xff) / 255, ((v >>> 8) & 0xff) / 255, (v & 0xff) / 255, 1];
  }
  return [((v >>> 24) & 0xff) / 255, ((v >>> 16) & 0xff) / 255, ((v >>> 8) & 0xff) / 255, (v & 0xff) / 255];
}
