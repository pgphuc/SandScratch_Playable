// Decoder public — dùng ở Cocos runtime (TextAsset .txt chứa base64) lẫn ở test Node.
// Engine-agnostic: KHÔNG import gì của Cocos (`cc`).
// P4b: đã copy sang assets/scripts/levelbake/ và FLATTEN (bỏ tầng src/) -> import là './codec'.
//
// Dùng:
//   import { decodeLevelFromBase64 } from './decode';
//   const level = decodeLevelFromBase64(textAsset.text); // -> LevelAsset y hệt IR JSON gốc

export { decodeLevel, decodeLevelFromBase64 } from './codec';
export type {
  LevelAsset,
  LevelData,
  PixelLevelData,
  PixelViewData,
  FrozenShape,
  ColorRemap,
  ClusterColorMap,
  Jar,
  ColorJarColumn,
  CountedArray,
} from './codec';
