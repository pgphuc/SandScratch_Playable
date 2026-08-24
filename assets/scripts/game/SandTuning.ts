// Tuning BAKE từ Unity — nguồn: ads/sand-drop-jar-fill/ir/tuning.json, config `GrainTuningConfig` (SO "SandTuning").
// Giữ NGUYÊN TÊN field của nguồn để tra ngược được; giá trị copy nguyên văn, KHÔNG làm tròn, KHÔNG bịa.
//
// Vì sao bake thành const thay vì load JSON runtime: các số này không đổi trong 1 ad (không có UI setting), nên
// nhồi JSON vào build chỉ tốn size + 1 lượt parse. Đổi tuning = sửa file này rồi build lại.
//
// ⚠ Số float ở Unity là float32; ở đây là float64 literal đọc từ IR (vd 0.11999999731779099 = f32 của 0.12).
// Giữ nguyên chuỗi số dài đó CHỦ Ý: nó là giá trị f32 THẬT mà Unity chạy. Làm tròn về 0.12 là đổi vật lý.

import type { ConversionFrontConfig } from '../solver/conversionFront';
import { AutoSwipeGhostMode } from '../solver/swipeBatch';

/** Bản sao 1:1 GrainTuningConfig (SandTuning.asset). Chỉ những knob lớp Cocos thật sự đọc. */
export const SAND_TUNING = {
  // --- hạt + tích phân ---
  grainGravityY: -50,
  grainParticleRadius: 0.11999999731779099,
  grainSubsteps: 2,
  grainDespawnY: -50,
  grainMaxSolverStepsPerFrame: 2,

  // --- tường ---
  grainWallRestitution: 0,
  grainWallFriction: 0.05000000074505806,
  grainWallGridEnabled: true,
  grainWallGridCellMul: 2,
  grainWallGridIntegrate: true,
  grainWallCompliance: 0.20000000298023224,

  // --- contact ---
  grainContactIterations: 4,
  grainContactStiffness: 1,
  grainContactSoftness: 0.20000000298023224,
  grainContactIntruderBias: 1,
  grainContactMaxPush: 0.05999999865889549,
  grainContactDamping: 0.8999999761581421,
  grainContactAbsorbCapMul: 2,
  grainContactSettleDamping: 0,

  // --- friction / sleep ---
  grainFrictionVelocity: 8,
  grainFrictionSurfaceDrag: 1,
  grainFrictionPosMu: 0,
  grainSleepEnabled: false,
  grainSleepQuadrant: true,
  grainSleepDelaySeconds: 1,

  // --- ccd + neighbor grid ---
  grainGrainCcdGate: 2,
  grainGrainCcdMaxPull: 1,
  grainNeighborGridEnabled: true,
  grainNeighborGridSubdiv: 1,

  // --- occupancy tranh ---
  grainOccupancyPushStrength: 30,
  grainOccupancyMaxStep: 0.029999999329447746,
  grainOccupancySlip: 0.800000011920929,
  grainOccupancySmoothRadius: 4,
  grainOccupancyDilateCells: 0,
  grainOccupancyEjectSearchCells: 6,

  // --- creep (cát bò trên mặt tranh) ---
  grainSurfaceCreepSpeed: 10,
  grainSurfaceCreepSlopeMin: 0.20000000298023224,
  grainSurfaceCreepWindow: 2,
  grainCreepLateralMax: 4,

  // --- scroll ---
  grainScrollRowsPerSecond: 10,
  grainScrollClearGrainMax: 5,

  // --- throttle pool ---
  grainThrottleEntry: 6000,
  grainThrottleExit: 5900,
  grainsPerPixelDivisor: 1.5,

  // --- conversion front (cào tranh -> emit hạt) ---
  maxGroupSize: 3,
  waveInterval: 0.000009999999747378752,
  emitSpeed: 20,
  emitConeHalfAngleDeg: 45,
  grainEscapeSlideCells: 3,
  grainSpawnClearanceRings: 2,

  // --- swipe batch ---
  swipeBatchDrainSpeed: 10000,
  swipeBatchSlabCells: 3,
  swipeBatchThinStripCells: 3,
  swipeBatchThinStripMaxCells: 100,
  swipeBatchEmptyStampsToClose: 1,
  swipeBatchRevertStyle: 'WaveBack' as const,
  swipeBatchRevertDuration: 0.25,
  autoSwipeGhostMode: 'Always' as const,

  // --- hình học phễu/khung (builder ĐÃ port ở P4b — xem SdfBuild.ts) ---
  capSegments: 32,
  edgeRadius: 0.5,
  entryGapWidth: 0.30000001192092896,
  funnelHeight: 0.1850000023841858,
  funnelMouthHalfWidth: 1,
  chuteLength: 0.04699999839067459,
  chuteInputWidth: 0.30000001192092896,
  buildFrameWalls: true,
  frameWallHeight: 2,
  frameWallExtraHeight: 0.15000000596046448,
  frameCornerRadius: 0.09000000357627869,
  buildTopWall: true,
  frameWallOutset: 0,
  // 2 knob cùng nhóm, P4a chưa cần nên chưa chép — SdfBuild.ts đọc.
  chuteJunctionCornerRadius: 0,
  grainGateWallThicknessMul: 0.5,
} as const;

/**
 * ConveyorShapeData — nguồn: ir/tuning.json, asset
 * Assets/!_Game_SDK/SandFlow/Data/GrainBurst/ConveyorShape.asset. Đơn vị GEOMETRY-LOCAL (nhân RIG_LAYOUT.geomScale
 * mới ra world), đúng như GrainFlowBackend.BuildSdfField đọc.
 */
export const CONVEYOR_SHAPE = {
  bodyLength: 1.1299999952316284,
  channelWidth: 0.25,
  innerHoleRadius: 0.03500000014901161,
} as const;

/**
 * ObiFlowLayoutConfig — nguồn: ir/tuning.json, asset .../GrainBurst/Layout.asset.
 * · rig*  = pose + PHÓNG TO HÌNH HỌC của phễu/chute/khung/stadium (KHÔNG scale solver: gravity/radius giữ đơn vị thật).
 * · quad* = pose SandQuadRoot = TRANH.
 */
export const RIG_LAYOUT = {
  rigPositionX: 0,
  rigPositionY: 3.200000047683716,
  geomScale: 10.699999809265137,
  quadPositionX: 0,
  quadPositionY: 21,
  quadScale: 0.4099999964237213,
} as const;

/**
 * Cỡ world của 1 CELL tranh, TRƯỚC quadScale — `LevelSpawner.pictureCellWorldSize`.
 *
 * ⚠ Số này KHÔNG nằm trong IR: nó là SerializeField trên prefab LevelSpawner, mà prefab không được extract ở P1.
 * Suy ra bằng 2 mốc ĐỘC LẬP trong chính source Unity, cả hai cùng cho 0.25:
 *  1. GrainFlowBackend.BuildOccupancyField, comment đo thật "@881a4aca, level 200px, cellWorld=0.1025"
 *     -> 0.1025 / quadScale(0.41) = 0.25.
 *  2. Cùng comment: "hạt chỉ dày 2.34 ô", với grainParticleRadius = 0.12
 *     -> 2*0.12 / 0.1025 = 2.341 ô. Khớp.
 * Kiểm chéo hình học: nửa bề ngang tranh = 200*0.1025/2 = 10.25; tường khung ở wallX*geomScale = 10.7
 * -> tranh LỌT trong khung, hở 0.45 world mỗi bên (đúng "khe nền" mà nguồn mô tả).
 * Kiểm chéo dọc: tranh cao 20.5, tâm ở quadPositionY=21 -> [10.75 .. 31.25]; khung từ funnelTop 8.73 tới
 * wallTop 31.74 -> tranh nằm trọn trong khung, còn topHeadroom ~0.5. Ba phép kiểm này độc lập nhau.
 */
export const PICTURE_CELL_WORLD_SIZE = 0.25;

/** Cỡ world 1 pixel CƠ CHẾ của tranh = pictureCellWorldSize × quadScale. */
export const PICTURE_PIXEL_WORLD = PICTURE_CELL_WORLD_SIZE * RIG_LAYOUT.quadScale;


/**
 * `autoSwipeRemainingThreshold` KHÔNG có trong GrainTuningConfig của nguồn — nó là knob mà front đọc để tự gạt nốt
 * màu gần hết. Nguồn Unity đọc nó từ chỗ khác (chưa xác định trong IR) -> để 0 = TẮT, đúng nghĩa "không bịa số".
 * Bật lên nếu P6 thấy tranh đọng vài pixel lẻ không tan.
 */
export const AUTO_SWIPE_REMAINING_THRESHOLD = 0;

/** Dựng ConversionFrontConfig từ tuning đã bake. Mọi field lấy trực tiếp, không suy diễn. */
export function makeConversionFrontConfig(): ConversionFrontConfig {
  const ghostMode = SAND_TUNING.autoSwipeGhostMode === 'Always'
    ? AutoSwipeGhostMode.Always
    : AutoSwipeGhostMode.Off;   // enum nguon: Off | TrappedOnly | Always
  return {
    waveInterval: SAND_TUNING.waveInterval,
    maxGroupSize: SAND_TUNING.maxGroupSize,
    swipeBatchDrainSpeed: SAND_TUNING.swipeBatchDrainSpeed,
    emitSpeed: SAND_TUNING.emitSpeed,
    emitConeHalfAngleDeg: SAND_TUNING.emitConeHalfAngleDeg,
    grainParticleRadius: SAND_TUNING.grainParticleRadius,
    grainSpawnClearanceRings: SAND_TUNING.grainSpawnClearanceRings,
    autoSwipeGhostMode: ghostMode,
    autoSwipeRemainingThreshold: AUTO_SWIPE_REMAINING_THRESHOLD,
  };
}

/**
 * Trần pool hạt. Nguồn throttle theo `grainThrottleEntry/Exit`; capacity phải >= entry để throttle là cái CHẶN,
 * không phải pool đầy (pool đầy = emit im lặng trượt, khó truy).
 */
export function grainPoolCapacity(): number {
  return SAND_TUNING.grainThrottleEntry + 256;
}
