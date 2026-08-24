// Codec bake level cat (sand-drop-jar-fill) — engine-agnostic, dùng chung cho
// bake.mjs (encode, chạy Node) và decode.ts (decode, chạy trong Cocos runtime).
//
// Nguồn dữ liệu: ads/sand-drop-jar-fill/ir/levels/*.json (IR dump từ Unity LevelData SO).
// Hợp đồng: conversion-manifest.json > levelData = BAKE_BINARY_COMPRESSED.
//
// Chiến lược: mọi mảng lớn (indices 40k, sourceColors 40k, pixelViewData.colors 160k)
// đều đi qua "palette + RLE": rút tập giá trị DUY NHẤT thành palette, thay mỗi ô
// bằng index vào palette, rồi RLE-encode chuỗi index (ô liền kề cùng giá trị -> gộp
// thành 1 run). Field vô hướng (float/int/bool/string nhỏ) ghi thẳng, KHÔNG nén —
// số lượng ít, nén không đáng.
//
// Toàn bộ số phải lossless: int dùng varInt (zigzag LEB128), float dùng Float64
// (8 byte, không mất precision so với number JS gốc).

import { ByteWriter, ByteReader, bytesToBase64, base64ToBytes } from './binary';

// ---- shape JSON gốc (từ IR extractor, xem CHOSEN-Release-Level-0001.json) ----

export interface CountedArray<T> {
  __count: number;
  items: T[];
  // Cờ do P1-extract gắn khi mảng bị cắt bớt lúc dump IR (VD 6/20 level "scroll" có
  // pixelViewData.colors.__truncated=true, __count=240000 nhưng items chỉ 200000 phần tử).
  // Optional + tri-state (absent/false/true) để lossless tuyệt đối kể cả khi field vắng mặt.
  __truncated?: boolean;
}

export interface FrozenShape {
  shapeId: number;
  count: number;
  centerX: number;
  centerY: number;
  rotationDeg: number;
  scale: number;
}

export interface ColorRemap {
  from: number;
  to: number;
  isRegion: boolean;
  seedX: number;
  seedY: number;
  singleCell: boolean;
}

export interface ClusterColorMap {
  packedRgb: number;
  value: number;
}

export interface PixelLevelData {
  width: number;
  height: number;
  indices: CountedArray<number>;
  sourceColors: CountedArray<string>;
  cornerRadiusRatio: number;
  viewportHeight: number;
  noSwipeBandHeight: number;
  columnCount: number;
  frozenShapes: CountedArray<FrozenShape>;
  colorRemaps: CountedArray<ColorRemap>;
  clusterColorMaps: CountedArray<ClusterColorMap>;
}

export interface PixelViewData {
  width: number;
  height: number;
  colors: CountedArray<string>;
}

export interface Jar {
  color: string;
  capacity: number;
  hidden: boolean;
  connectorId: number;
}

export interface ColorJarColumn {
  jars: CountedArray<Jar>;
}

export interface LevelData {
  releaseDifficulty: string;
  pixelLevelData: PixelLevelData;
  pixelViewData: PixelViewData;
  grainyLook: boolean;
  colorJarColumns: CountedArray<ColorJarColumn>;
}

export interface LevelAsset {
  path: string;
  type: string;
  data: LevelData;
}

const MAGIC = 0x534c4231; // "SLB1"
const VERSION = 1;

// ---- palette + RLE, dùng chung cho mảng số và mảng màu hex ----

function encodeNumberGrid(w: ByteWriter, items: number[]): void {
  const palette: number[] = [];
  const indexOf = new Map<number, number>();
  const idxStream: number[] = new Array(items.length);
  for (let i = 0; i < items.length; i++) {
    const v = items[i];
    let pi = indexOf.get(v);
    if (pi === undefined) {
      pi = palette.length;
      indexOf.set(v, pi);
      palette.push(v);
    }
    idxStream[i] = pi;
  }
  w.varUint(palette.length);
  for (const v of palette) w.varInt(v);
  writeRuns(w, idxStream);
}

function decodeNumberGrid(r: ByteReader, expectedCount: number): number[] {
  const paletteLen = r.varUint();
  const palette: number[] = new Array(paletteLen);
  for (let i = 0; i < paletteLen; i++) palette[i] = r.varInt();
  const idxStream = readRuns(r, expectedCount);
  const out: number[] = new Array(expectedCount);
  for (let i = 0; i < expectedCount; i++) out[i] = palette[idxStream[i]];
  return out;
}

function hexColorToRgba(hex: string): number {
  // "#RRGGBBAA" -> uint32 0xRRGGBBAA
  return parseInt(hex.slice(1), 16) >>> 0;
}

function rgbaToHexColor(rgba: number): string {
  // padStart() can lib ES2017; tsconfig cua Cocos project la ES2015 -> pad thu cong.
  const h = (rgba >>> 0).toString(16).toUpperCase();
  return '#' + '00000000'.slice(h.length) + h;
}

function encodeColorGrid(w: ByteWriter, items: string[]): void {
  const palette: number[] = [];
  const indexOf = new Map<number, number>();
  const idxStream: number[] = new Array(items.length);
  for (let i = 0; i < items.length; i++) {
    const v = hexColorToRgba(items[i]);
    let pi = indexOf.get(v);
    if (pi === undefined) {
      pi = palette.length;
      indexOf.set(v, pi);
      palette.push(v);
    }
    idxStream[i] = pi;
  }
  w.varUint(palette.length);
  for (const v of palette) w.u32(v);
  writeRuns(w, idxStream);
}

function decodeColorGrid(r: ByteReader, expectedCount: number): string[] {
  const paletteLen = r.varUint();
  const palette: number[] = new Array(paletteLen);
  for (let i = 0; i < paletteLen; i++) palette[i] = r.u32();
  const idxStream = readRuns(r, expectedCount);
  const out: string[] = new Array(expectedCount);
  for (let i = 0; i < expectedCount; i++) out[i] = rgbaToHexColor(palette[idxStream[i]]);
  return out;
}

// NOTE quan trọng (phát hiện khi đo 6/20 level "scroll" 200x300 — 0013,0014,0015,0016,0018,0019):
// pixelViewData.colors.__count (=width*height) KHÔNG khớp items.length thật trong IR nguồn
// (__count=240000 nhưng items chỉ có 200000 phần tử) — đây là quirk có sẵn từ P1 extract,
// KHÔNG phải bug ở đây. Để lossless tuyệt đối, __count (declared) và items.length (actual,
// cái RLE thật sự mã hoá) được ghi TÁCH RIÊNG và phục hồi y hệt bản gốc, dù chúng lệch nhau.

// tri-state __truncated: 0 = vắng mặt, 1 = false, 2 = true
function writeTruncatedFlag(w: ByteWriter, v: boolean | undefined): void {
  w.u8(v === undefined ? 0 : v ? 2 : 1);
}
function readTruncatedFlag(r: ByteReader): boolean | undefined {
  const v = r.u8();
  return v === 0 ? undefined : v === 2;
}

function encodeCountedNumberGrid(w: ByteWriter, arr: CountedArray<number>): void {
  w.varUint(arr.__count);
  w.varUint(arr.items.length);
  writeTruncatedFlag(w, arr.__truncated);
  encodeNumberGrid(w, arr.items);
}

function decodeCountedNumberGrid(r: ByteReader): CountedArray<number> {
  const declaredCount = r.varUint();
  const actualCount = r.varUint();
  const truncated = readTruncatedFlag(r);
  const items = decodeNumberGrid(r, actualCount);
  const out: CountedArray<number> = { __count: declaredCount, items };
  if (truncated !== undefined) out.__truncated = truncated;
  return out;
}

function encodeCountedColorGrid(w: ByteWriter, arr: CountedArray<string>): void {
  w.varUint(arr.__count);
  w.varUint(arr.items.length);
  writeTruncatedFlag(w, arr.__truncated);
  encodeColorGrid(w, arr.items);
}

function decodeCountedColorGrid(r: ByteReader): CountedArray<string> {
  const declaredCount = r.varUint();
  const actualCount = r.varUint();
  const truncated = readTruncatedFlag(r);
  const items = decodeColorGrid(r, actualCount);
  const out: CountedArray<string> = { __count: declaredCount, items };
  if (truncated !== undefined) out.__truncated = truncated;
  return out;
}

function writeRuns(w: ByteWriter, idxStream: number[]): void {
  const runs: Array<[number, number]> = [];
  let i = 0;
  while (i < idxStream.length) {
    const v = idxStream[i];
    let j = i + 1;
    while (j < idxStream.length && idxStream[j] === v) j++;
    runs.push([v, j - i]);
    i = j;
  }
  w.varUint(runs.length);
  for (const [pi, len] of runs) {
    w.varUint(pi);
    w.varUint(len);
  }
}

function readRuns(r: ByteReader, expectedCount: number): number[] {
  const runCount = r.varUint();
  const out: number[] = new Array(expectedCount);
  let pos = 0;
  for (let k = 0; k < runCount; k++) {
    const pi = r.varUint();
    const len = r.varUint();
    for (let n = 0; n < len; n++) out[pos++] = pi;
  }
  if (pos !== expectedCount) {
    throw new Error(`readRuns: giải mã ra ${pos} phần tử, kỳ vọng ${expectedCount}`);
  }
  return out;
}

// ---- encode/decode 1 level đầy đủ ----

function encodePixelLevelData(w: ByteWriter, pl: PixelLevelData): void {
  w.varUint(pl.width);
  w.varUint(pl.height);
  encodeCountedNumberGrid(w, pl.indices);
  encodeCountedColorGrid(w, pl.sourceColors);
  w.f64(pl.cornerRadiusRatio);
  w.f64(pl.viewportHeight);
  w.f64(pl.noSwipeBandHeight);
  w.varInt(pl.columnCount);

  w.varUint(pl.frozenShapes.items.length);
  for (const fs of pl.frozenShapes.items) {
    w.varUint(fs.shapeId);
    w.varUint(fs.count);
    w.f64(fs.centerX);
    w.f64(fs.centerY);
    w.f64(fs.rotationDeg);
    w.f64(fs.scale);
  }

  w.varUint(pl.colorRemaps.items.length);
  for (const cr of pl.colorRemaps.items) {
    w.varInt(cr.from);
    w.varInt(cr.to);
    w.bool(cr.isRegion);
    w.varInt(cr.seedX);
    w.varInt(cr.seedY);
    w.bool(cr.singleCell);
  }

  w.varUint(pl.clusterColorMaps.items.length);
  for (const cc of pl.clusterColorMaps.items) {
    w.varUint(cc.packedRgb);
    w.varInt(cc.value);
  }
}

function encodePixelViewData(w: ByteWriter, pv: PixelViewData): void {
  w.varUint(pv.width);
  w.varUint(pv.height);
  encodeCountedColorGrid(w, pv.colors);
}

export function encodeLevel(level: LevelAsset): Uint8Array {
  const w = new ByteWriter(1 << 16);
  w.u32(MAGIC);
  w.u8(VERSION);

  w.str(level.path);
  w.str(level.type);

  const d = level.data;
  w.str(d.releaseDifficulty);

  encodePixelLevelData(w, d.pixelLevelData);
  encodePixelViewData(w, d.pixelViewData);

  w.bool(d.grainyLook);

  w.varUint(d.colorJarColumns.items.length);
  for (const col of d.colorJarColumns.items) {
    w.varUint(col.jars.items.length);
    for (const jar of col.jars.items) {
      w.str(jar.color);
      w.varUint(jar.capacity);
      w.bool(jar.hidden);
      w.varInt(jar.connectorId);
    }
  }

  return w.toUint8Array();
}

/**
 * Đo riêng size nhị phân của pixelLevelData vs pixelViewData (dùng cho report P4a —
 * manifest có phương án dự phòng bỏ/thu nhỏ pixelViewData nếu không đạt cap).
 * Không phải wire-format thật, chỉ dùng để đo lường.
 */
export function measureBreakdown(level: LevelAsset): {
  pixelLevelDataBytes: number;
  pixelViewDataBytes: number;
  restBytes: number;
  totalBytes: number;
} {
  const wPl = new ByteWriter(1 << 16);
  encodePixelLevelData(wPl, level.data.pixelLevelData);
  const pixelLevelDataBytes = wPl.toUint8Array().length;

  const wPv = new ByteWriter(1 << 16);
  encodePixelViewData(wPv, level.data.pixelViewData);
  const pixelViewDataBytes = wPv.toUint8Array().length;

  const totalBytes = encodeLevel(level).length;
  const restBytes = totalBytes - pixelLevelDataBytes - pixelViewDataBytes;
  return { pixelLevelDataBytes, pixelViewDataBytes, restBytes, totalBytes };
}

export function decodeLevel(bytes: Uint8Array): LevelAsset {
  const r = new ByteReader(bytes);
  const magic = r.u32();
  if (magic !== MAGIC) throw new Error(`decodeLevel: magic sai (0x${magic.toString(16)})`);
  const version = r.u8();
  if (version !== VERSION) throw new Error(`decodeLevel: version khong ho tro (${version})`);

  const path = r.str();
  const type = r.str();
  const releaseDifficulty = r.str();

  const width = r.varUint();
  const height = r.varUint();
  const indices = decodeCountedNumberGrid(r);
  const sourceColors = decodeCountedColorGrid(r);
  const cornerRadiusRatio = r.f64();
  const viewportHeight = r.f64();
  const noSwipeBandHeight = r.f64();
  const columnCount = r.varInt();

  const frozenCount = r.varUint();
  const frozenShapes: FrozenShape[] = new Array(frozenCount);
  for (let i = 0; i < frozenCount; i++) {
    frozenShapes[i] = {
      shapeId: r.varUint(),
      count: r.varUint(),
      centerX: r.f64(),
      centerY: r.f64(),
      rotationDeg: r.f64(),
      scale: r.f64(),
    };
  }

  const remapCount = r.varUint();
  const colorRemaps: ColorRemap[] = new Array(remapCount);
  for (let i = 0; i < remapCount; i++) {
    colorRemaps[i] = {
      from: r.varInt(),
      to: r.varInt(),
      isRegion: r.bool(),
      seedX: r.varInt(),
      seedY: r.varInt(),
      singleCell: r.bool(),
    };
  }

  const clusterCount = r.varUint();
  const clusterColorMaps: ClusterColorMap[] = new Array(clusterCount);
  for (let i = 0; i < clusterCount; i++) {
    clusterColorMaps[i] = { packedRgb: r.varUint(), value: r.varInt() };
  }

  const pvWidth = r.varUint();
  const pvHeight = r.varUint();
  const viewColors = decodeCountedColorGrid(r);

  const grainyLook = r.bool();

  const colCount = r.varUint();
  const colorJarColumnsItems: ColorJarColumn[] = new Array(colCount);
  for (let i = 0; i < colCount; i++) {
    const jarCount = r.varUint();
    const jars: Jar[] = new Array(jarCount);
    for (let j = 0; j < jarCount; j++) {
      jars[j] = {
        color: r.str(),
        capacity: r.varUint(),
        hidden: r.bool(),
        connectorId: r.varInt(),
      };
    }
    colorJarColumnsItems[i] = { jars: { __count: jarCount, items: jars } };
  }

  return {
    path,
    type,
    data: {
      releaseDifficulty,
      pixelLevelData: {
        width,
        height,
        indices,
        sourceColors,
        cornerRadiusRatio,
        viewportHeight,
        noSwipeBandHeight,
        columnCount,
        frozenShapes: { __count: frozenCount, items: frozenShapes },
        colorRemaps: { __count: remapCount, items: colorRemaps },
        clusterColorMaps: { __count: clusterCount, items: clusterColorMaps },
      },
      pixelViewData: {
        width: pvWidth,
        height: pvHeight,
        colors: viewColors,
      },
      grainyLook,
      colorJarColumns: { __count: colCount, items: colorJarColumnsItems },
    },
  };
}

export function encodeLevelToBase64(level: LevelAsset): string {
  return bytesToBase64(encodeLevel(level));
}

export function decodeLevelFromBase64(b64: string): LevelAsset {
  return decodeLevel(base64ToBytes(b64));
}
