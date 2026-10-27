// Bake 1 level nguon (picture.png + level.json) -> file SLB1 base64 .txt chay duoc trong Cocos runtime.
//
// Dung:
//   npx tsx bake-level.mts level-src/level-0021          # out mac dinh: ../assets/resources/data/level-0021.txt
//   npx tsx bake-level.mts level-src/level-0021 --out ../assets/resources/data/level-0021.txt
//   npx tsx bake-level.mts level-src/level-0021 --dry    # chi in bao cao, khong ghi file
//
// Input mot folder gom:
//   picture.png   RGBA 200x200 (hoac W x H khac neu level.json chi ro). Pixel trong suot (alpha=0) = o trong.
//   level.json    cot lo + metadata (xem schema o duoi).
//   view.png      TUY CHON. Khong co -> upscale 2x nearest-neighbor tu picture.png.
//
// schema level.json (toi thieu):
// {
//   "name": "level-0021",
//   "jarColumns": [
//     [{ "color": "Yellow5", "capacity": 1500 }, { "color": "Yellow5", "capacity": 1500 }],
//     [{ "color": "Blue5",   "capacity": 1500 }]
//   ]
// }
// Mac dinh (co the override trong level.json): releaseDifficulty=Normal, grainyLook=true, cornerRadiusRatio=0.025,
// viewportHeight=<mech.height>, noSwipeBandHeight=0, columnCount=1, view.scale=2.
//
// Nguoc chieu: encodeLevelToBase64 cua codec.ts (encoder GOC, da verify roundtrip byte-identical voi level-0001).

import { encodeLevelToBase64 } from '../assets/scripts/levelbake/codec.ts';
import type { LevelAsset, Jar, ColorJarColumn, FrozenShape, ColorRemap, ClusterColorMap } from '../assets/scripts/levelbake/codec.ts';
import { COLOR_NAME_HEX } from '../assets/scripts/game/ColorNames.ts';
import { PNG } from 'pngjs';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename, join } from 'node:path';

interface JarSrc { color: string; capacity: number; hidden?: boolean; connectorId?: number; }
interface LevelJson {
  name?: string;
  path?: string;
  releaseDifficulty?: string;
  grainyLook?: boolean;
  mech?: {
    cornerRadiusRatio?: number;
    viewportHeight?: number;
    noSwipeBandHeight?: number;
    columnCount?: number;
  };
  view?: { scale?: number };
  /**
   * Mang 4 cot (khop layout AdRoot JAR_COLUMN_X = 4). Moi cot = mang lo xep tu TREN XUONG, slot 0 = head.
   * Khong bat buoc du 4 — thieu cot nao tool dien [] vao. Lo du qua 3 slot vat ly cua cot van hop le:
   * cac lo dau nam cho cho tui lo truoc dong roi doi len (nguon JarColumns.ts). Khong co lo nao = []
   * cho ca 4 cot (level khong co gameplay, chi tranh de xem).
   */
  jarColumns?: JarSrc[][];
  frozenShapes?: FrozenShape[];
  colorRemaps?: ColorRemap[];
  clusterColorMaps?: ClusterColorMap[];
}

function parseArgs(argv: string[]): { srcDir: string; outPath: string | null; dry: boolean } {
  const args = argv.slice(2);
  if (args.length === 0 || args[0].startsWith('--')) {
    throw new Error('Usage: bake-level.mts <src-dir> [--out <path>] [--dry]');
  }
  let outPath: string | null = null;
  let dry = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--out' && i + 1 < args.length) { outPath = args[++i]; continue; }
    if (args[i] === '--dry') { dry = true; continue; }
    throw new Error(`Co arg la: ${args[i]}`);
  }
  return { srcDir: resolve(args[0]), outPath: outPath !== null ? resolve(outPath) : null, dry };
}

async function readPng(path: string): Promise<{ width: number; height: number; data: Buffer }> {
  const buf = await readFile(path);
  return new Promise((ok, err) => {
    new PNG().parse(buf, (e, png) => {
      if (e !== null && e !== undefined) err(e);
      else ok({ width: png.width, height: png.height, data: png.data });
    });
  });
}

/** Hex 8-char hoa, luon co '#'. */
function rgbaHex(r: number, g: number, b: number, a: number): string {
  const h = (((r & 0xff) << 24) | ((g & 0xff) << 16) | ((b & 0xff) << 8) | (a & 0xff)) >>> 0;
  const s = h.toString(16).toUpperCase();
  return '#' + '00000000'.slice(s.length) + s;
}

/** PNG mech -> indices + sourceColors + palette hex set. */
function pixelsToMechGrid(mech: { width: number; height: number; data: Buffer }):
    { indices: number[]; sourceColors: string[]; palette: Map<string, number> } {
  const n = mech.width * mech.height;
  const indices = new Array<number>(n);
  const sourceColors = new Array<string>(n);
  const palette = new Map<string, number>();     // hex (opaque, chuan hoa alpha=FF cua nguon) -> colorId
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const a = mech.data[o + 3];
    if (a === 0) {
      indices[i] = -1;
      sourceColors[i] = '#00000000';
      continue;
    }
    const hex = rgbaHex(mech.data[o], mech.data[o + 1], mech.data[o + 2], a);
    let id = palette.get(hex);
    if (id === undefined) { id = palette.size; palette.set(hex, id); }
    indices[i] = id;
    sourceColors[i] = hex;
  }
  return { indices, sourceColors, palette };
}

/** View grid: dung PNG rieng neu co, khong thi upscale nearest-neighbor tu mech. */
function buildViewGrid(mech: { width: number; height: number; data: Buffer },
                       view: { width: number; height: number; data: Buffer } | null,
                       scale: number): { width: number; height: number; colors: string[] } {
  if (view !== null) {
    const n = view.width * view.height;
    const colors = new Array<string>(n);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const a = view.data[o + 3];
      colors[i] = a === 0 ? '#00000000' : rgbaHex(view.data[o], view.data[o + 1], view.data[o + 2], a);
    }
    return { width: view.width, height: view.height, colors };
  }
  const vw = mech.width * scale;
  const vh = mech.height * scale;
  const colors = new Array<string>(vw * vh);
  for (let vy = 0; vy < vh; vy++) {
    const my = (vy / scale) | 0;
    for (let vx = 0; vx < vw; vx++) {
      const mx = (vx / scale) | 0;
      const mo = (my * mech.width + mx) * 4;
      const a = mech.data[mo + 3];
      colors[vy * vw + vx] = a === 0
        ? '#00000000'
        : rgbaHex(mech.data[mo], mech.data[mo + 1], mech.data[mo + 2], a);
    }
  }
  return { width: vw, height: vh, colors };
}

async function fileExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

async function main(): Promise<void> {
  const { srcDir, outPath, dry } = parseArgs(process.argv);

  const jsonPath = join(srcDir, 'level.json');
  const picPath = join(srcDir, 'picture.png');
  const viewPath = join(srcDir, 'view.png');

  const json = JSON.parse(await readFile(jsonPath, 'utf8')) as LevelJson;
  const name = json.name ?? basename(srcDir);
  const mechPng = await readPng(picPath);
  const viewPng = (await fileExists(viewPath)) ? await readPng(viewPath) : null;

  const mechW = mechPng.width;
  const mechH = mechPng.height;
  const scale = json.view?.scale ?? 2;

  if (viewPng !== null) {
    if (viewPng.width !== mechW * scale || viewPng.height !== mechH * scale) {
      throw new Error(`view.png ${viewPng.width}x${viewPng.height} khong khop mech*scale (${mechW * scale}x${mechH * scale})`);
    }
  }

  const { indices, sourceColors, palette } = pixelsToMechGrid(mechPng);
  const view = buildViewGrid(mechPng, viewPng, scale);

  // Jars — mac dinh 4 cot rong (level khong co lo cung chay, scenario roi fallback 30s).
  const JAR_LAYOUT_COLS = 4;
  const rawCols = json.jarColumns ?? [];
  const colSrc: JarSrc[][] = [];
  for (let c = 0; c < Math.max(JAR_LAYOUT_COLS, rawCols.length); c++) colSrc.push(rawCols[c] ?? []);
  const colorJarColumns: ColorJarColumn[] = colSrc.map((col) => {
    const jars: Jar[] = col.map((j) => ({
      color: j.color,
      capacity: j.capacity | 0,
      hidden: !!j.hidden,
      connectorId: (j.connectorId ?? 0) | 0,
    }));
    return { jars: { __count: jars.length, items: jars } };
  });

  // Validate: jar color -> hex phai co trong COLOR_NAME_HEX, va hex do PHAI dang xuat hien trong tranh
  // (neu khong, lo khong hut duoc gi). Chi warn, khong fail — co the chu dinh (hidden jar) hoac design chua xong.
  const warnings: string[] = [];
  const paletteHexNoAlpha = new Set<string>();
  for (const hex of palette.keys()) {
    paletteHexNoAlpha.add(hex.slice(0, 7));                 // '#RRGGBB' bo alpha
  }
  for (let ci = 0; ci < colorJarColumns.length; ci++) {
    for (const jar of colorJarColumns[ci].jars.items) {
      const rgb = COLOR_NAME_HEX[jar.color];
      if (rgb === undefined) {
        warnings.push(`jar col=${ci} ten "${jar.color}" KHONG CO trong COLOR_NAME_HEX -> runtime se tra -1, lo nay khong hut hat`);
        continue;
      }
      const hex6 = '#' + rgb.toString(16).toUpperCase().padStart(6, '0');
      if (!paletteHexNoAlpha.has(hex6)) {
        warnings.push(`jar col=${ci} ten "${jar.color}" (${hex6}) khong co pixel nao trong picture.png mang mau nay`);
      }
    }
  }

  const defaultPath = `Assets/!_Game_SDK/Level/Level Database/SO/Baked Levels/${name}.asset`;
  const asset: LevelAsset = {
    path: json.path ?? defaultPath,
    type: 'LevelData',
    data: {
      releaseDifficulty: json.releaseDifficulty ?? 'Normal',
      pixelLevelData: {
        width: mechW,
        height: mechH,
        indices: { __count: indices.length, items: indices },
        sourceColors: { __count: sourceColors.length, items: sourceColors },
        cornerRadiusRatio: json.mech?.cornerRadiusRatio ?? 0.025,
        viewportHeight: json.mech?.viewportHeight ?? mechH,
        noSwipeBandHeight: json.mech?.noSwipeBandHeight ?? 0,
        columnCount: json.mech?.columnCount ?? 1,
        frozenShapes: { __count: (json.frozenShapes ?? []).length, items: json.frozenShapes ?? [] },
        colorRemaps: { __count: (json.colorRemaps ?? []).length, items: json.colorRemaps ?? [] },
        clusterColorMaps: { __count: (json.clusterColorMaps ?? []).length, items: json.clusterColorMaps ?? [] },
      },
      pixelViewData: {
        width: view.width,
        height: view.height,
        colors: { __count: view.colors.length, items: view.colors },
      },
      grainyLook: json.grainyLook ?? true,
      colorJarColumns: { __count: colorJarColumns.length, items: colorJarColumns },
    },
  };

  const b64 = encodeLevelToBase64(asset);

  const out = outPath ?? resolve(fileURLToPath(import.meta.url), '..', '..', 'assets', 'resources', 'data', `${name}.txt`);

  // Report
  const uniqOpaque = palette.size;
  console.log(`[bake] src: ${srcDir}`);
  console.log(`[bake] mech: ${mechW}x${mechH} (${indices.length} pixel), unique mau opaque: ${uniqOpaque}`);
  console.log(`[bake] view: ${view.width}x${view.height}${viewPng === null ? ` (upscale x${scale})` : ' (view.png cap tay)'}`);
  console.log(`[bake] cot lo: ${colorJarColumns.length}, tong lo: ${colorJarColumns.reduce((s, c) => s + c.jars.items.length, 0)}`);
  console.log(`[bake] b64 size: ${b64.length} ky tu (${Math.round(b64.length / 1024)} KB)`);
  for (const w of warnings) console.warn(`[bake] WARN ${w}`);
  if (dry) {
    console.log(`[bake] --dry: khong ghi file. Dich mac dinh se la ${out}`);
    return;
  }
  await writeFile(out, b64 + '\n', 'utf8');
  console.log(`[bake] XONG -> ${out}`);
  console.log('[bake] Nho mo lai Cocos editor de no sinh .meta cho file moi (neu la lan dau).');
}

main().catch((e: unknown) => {
  console.error('[bake] LOI:', e instanceof Error ? e.message : e);
  process.exit(1);
});
