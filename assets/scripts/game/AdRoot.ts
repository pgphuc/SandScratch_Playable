// BOOTSTRAP của ad: nối level -> carve model -> ConversionFront -> SandSolver -> renderer -> lọ -> ScenarioRunner,
// và DỰNG LUÔN cây node của cảnh.
//
// ============ VÌ SAO CÂY NODE DỰNG BẰNG CODE ============
// `.scene` của Cocos là JSON tham chiếu asset bằng uuid. Muốn có uuid thì asset phải được editor import trước;
// muốn scene đúng thì phải có file mẫu do editor sinh. Ad này không có cả hai (docs/cocos-conventions.md §"Luật
// ghi file" cấm bịa uuid). Nên `assets/scenes/ad.scene` giữ ở mức TỐI THIỂU — 1 node mang AdRoot + ScenarioRunner
// — còn camera/tranh/hạt/lọ/CTA dựng ở đây, nơi toạ độ được typecheck và nằm cùng chỗ với số hình học.
// Asset (level, scenario, material) nạp qua `resources.load` THEO ĐƯỜNG DẪN, cũng không cần uuid.
//
// ============ NHỊP CHẠY (docs/cocos-conventions.md, mục perf webview) ============
// Sim FIXED-STEP 30Hz tách khỏi render 60fps, cap catch-up = grainMaxSolverStepsPerFrame (= 2).
// Vì sao tách: solver là PBD — dt đổi thì kết quả đổi. Chạy theo dt của frame là để vật lý phụ thuộc máy người xem,
// và ad chạy trên webview bị throttle nên dt nhảy rất bạo. Cap catch-up chống "spiral of death" khi 1 frame kẹt lâu.
// Renderer đồng bộ 1 lần/FRAME (không phải mỗi step): 2 step trong 1 frame ghi mesh 2 lần cho cùng 1 hình.

import {
  Asset, Camera, Canvas, Color, Component, EventTouch, Input, Label, Layers, Material, Node, Prefab, TextAsset,
  Texture2D, UITransform, Vec3, input, resources, view, _decorator,
} from 'cc';

import { SandSolver, refreshOccupancy, type SolverParams } from '../solver/step';
import { SandCellSolver } from '../solver/modeB';
import { ConversionFront, type SandEmitRequest, type SandFlowBackend } from '../solver/conversionFront';
import {
  BeltFullGate, countBeltGrains, fillRatio, isInBeltLocal, mouthFromCenterSize, type BeltRegion,
} from '../solver/counting';
import type { GrainOccupancyField } from '../solver/occupancy';

import {
  SAND_TUNING, RIG_LAYOUT, CONVEYOR_SHAPE, PICTURE_PIXEL_WORLD, makeConversionFrontConfig, grainPoolCapacity,
} from './SandTuning';
import { buildSdfRig, type SdfRig } from './SdfBuild';
import { loadLevel, buildCarveModel, colorIdOfJarName, type LoadedLevel } from './LevelLoad';
import { hexOfColorName } from './ColorNames';
import { PictureMap } from './PictureMap';
import { PictureTexture } from './PictureTexture';
import { PictureView } from './PictureView';
import { SandPictureHost } from './SandPictureHost';
import { SandGrainRenderer } from './SandGrainRenderer';
import { ColorJar } from './ColorJar';
import { JarColumns, type JarColumnSpec } from './JarColumns';
import { HandHint } from './HandHint';
import { attachQuad } from './QuadVisual';
import { attachBox, boxTextureName, lastBoxFit } from './BoxVisual';
import { BoxAnim } from './BoxAnim';
import { JarFillVisual } from './JarFillVisual';
import { buildBoardVisual, parseBoardLayout, BOARD_DEFAULT, type BoardLayout } from './BoardVisual';
import { buildRigVisual } from './RigVisual';
import { JarFlyVisual } from './JarFlyVisual';
import { probeStatic } from './StaticProbe';
import { ScenarioRunner, type ScenarioJson } from './ScenarioRunner';
import type { NetworkId } from './NetworkAdapter';

const { ccclass, property } = _decorator;

/** Sim 30Hz. Số này là MỘT PHẦN CỦA VẬT LÝ (PBD), không phải knob perf — đổi nó là đổi hành vi cát. */
const SIM_DT = 1 / 30;

// ============================================================ LAYOUT (world Unity, xem SandTuning.RIG_LAYOUT)
//
// Cả cảnh sống trong ĐÚNG hệ toạ độ của rig Unity — không quy đổi, không chuẩn hoá. Nhờ vậy mọi số hình học
// (segment SDF, tâm tranh, bán kính hạt 0.12) so trực tiếp được với nguồn khi truy parity ở P6.
//
// Số THẬT từ IR: tranh 200×200 cell × 0.1025 = 20.5 world, tâm (0, 21).
// Rig: tường khung ±10.7, đáy khung y = 8.73, nóc y = 31.74, tâm vành stadium (0, 3.2).

/** Nửa chiều cao camera ortho. 19.2 -> phủ y ∈ [-6.2, 32.2]: đủ nóc khung (31.74) và chỗ cho 2 slot lọ dưới belt. */
const CAM_HALF_HEIGHT = 19.2;
const CAM_CENTER_Y = 13;

// ============================================================ LAYOUT LỌ — SỐ THẬT TỪ PREFAB (2026-08-24)
//
// Nguồn: ir/particles/__Game_SDK_Level_Prefabs_Game_Specifics.prefab.yaml §ColorJarController (&4927878577378634387)
//   pointA (SpawnPoint, &8579220994057226019) localPosition = (0, -2, -2); cha ColorJarController ở (0,0,0),
//     cha nữa (root Game_Specifics) ở (0,0,0)  =>  pointA world 2D = (0, -2).
//   columnSpacing = 4.2 · headLocalYZ = (-0.5, 0) · secondLocalYZ = (-2.75, -2) · jarYStep = -1.5 · jarZStep = -2
//
// ⚠ ĐÍNH CHÍNH note 92 của job.json: prefab này ĐÃ ĐƯỢC EXTRACT ở P1 (ir/particles/, 36 file). Ghi chú cũ "chỗ
// đứng của lọ KHÔNG có nguồn Unity, số ở đây là ĐẶT TAY" là SAI. Số đặt tay cũ ([-6.9,-2.3,2.3,6.9] /
// [-2.2,-5.4,-8.6]) tình cờ khá sát, nhưng từ đây dùng số nguồn.
//
// ============ TRỤC Z CỦA CỘT LỌ (ĐÍNH CHÍNH 2026-08-25) ============
// Bản P4a BỎ trục z với lý do "ad này phẳng 2D". Đúng khi lọ còn là quad màu; SAI từ lúc lọ thành mesh SKM_Box
// dày ~2.3 world: không lệch z thì hộp slot trên đâm xuyên và đè lên MẶT TRƯỚC hộp slot dưới (user báo).
//
// ⚠ ĐẢO DẤU khi bê sang: camera Unity nhìn +Z nên z NHỎ = GẦN camera; nguồn có headLocalYZ.z = 0,
// secondLocalYZ.z = -2, jarZStep = -2 => lọ càng DƯỚI càng z nhỏ = càng GẦN camera = vẽ ĐÈ LÊN lọ trên. Camera
// cảnh này nhìn -Z nên z LỚN = gần => bước dương +2, cùng một trật tự che nhau.
//
// Hệ quả: slot sâu nhất có mặt trước ở z = 0.2 + 2·2 = 4.2, nên Z_HINT/Z_CTA phải nâng lên 8 (trước là 1).
// Nâng z KHÔNG đổi hình gì vì camera ORTHO — chỉ đổi thứ tự che nhau.
const JAR_Z_STEP = 2;

const JAR_POINT_A_X = 0;
const JAR_POINT_A_Y = -2;
const JAR_COLUMN_SPACING = 4.2;
/** 4 cột đối xứng quanh pointA.x -> [-6.3, -2.1, 2.1, 6.3]. */
const JAR_COLUMN_X = [0, 1, 2, 3].map((c) => JAR_POINT_A_X + (c - 1.5) * JAR_COLUMN_SPACING);
/** Slot 0 = head (headLocalYZ.x), slot 1 = secondLocalYZ.x, slot 2 trở đi cộng dồn jarYStep. */
const JAR_SLOT_Y = [
  JAR_POINT_A_Y - 0.5,
  JAR_POINT_A_Y - 2.75,
  JAR_POINT_A_Y - 2.75 - 1.5,
];
const JAR_W = 3.6;
const JAR_H = 2.6;

// ---- hộp hút (ObiJarSink &7977750162497774786, CÙNG prefab) ----
// autoMouthFromJars = 1 · autoMouthOffset = (0, 4, 0) · autoMouthSize = (2.3, 3) · columnMouthOverrides = []
//
// ⚠ ĐÍNH CHÍNH note 91: "autoMouthSize 0.6×0.5" là DEFAULT trong ObiJarSink.cs, KHÔNG phải giá trị serialize
// trên prefab. Số thật là 2.3×3.
const JAR_MOUTH_OFFSET_Y = 4;
const JAR_MOUTH_W = 2.3;
const JAR_MOUTH_H = 3;

/** z từng lớp — tranh phải Ở SAU hạt, nếu không pass transparent của tranh vẽ đè lên hạt opaque. */
const Z_RIG = -0.2;        // rig ở SAU tranh: cát + tranh phải nằm trên khung
const Z_PICTURE = -0.05;
const Z_GRAIN = 0;
const Z_JAR = 0.2;         // slot 0 (head). Slot dưới CỘNG thêm JAR_Z_STEP mỗi bậc -> nằm TRƯỚC head.
const Z_JAR_FLY = 0.25;    // cung bay phải nằm TRƯỚC thân lọ HEAD, nếu không hạt chui vào sau lọ ở cuối cung
const Z_HINT = 8;
const Z_CTA = 8;
/**
 * Trần của núm `box.dz` (board-layout.txt): mặt trước hộp SÂU NHẤT = Z_JAR + JAR_Z_STEP·(số slot−1) + dz,
 * phải luôn ở SAU nút CTA. Chừa 0.05 làm đệm để hộp không z-fight với CTA.
 */
const MAX_BOX_DZ = Z_CTA - 0.05 - (Z_JAR + JAR_Z_STEP * (JAR_SLOT_Y.length - 1));

@ccclass('AdRoot')
export class AdRoot extends Component {
  @property({ tooltip: 'Đường trong assets/resources tới level đã bake (SLB1 base64)' })
  levelResPath = 'data/level-0001';

  @property({ tooltip: 'Đường trong assets/resources tới scenario đã chọn' })
  scenarioResPath = 'data/scenario';

  @property({ tooltip: 'File JSON chỉnh tay vị trí/cỡ art nền + hộp lọ (trong assets/resources)' })
  boardLayoutResPath = 'data/board-layout';

  @property({ tooltip: 'Bán kính brush vuốt, theo Ô CƠ CHẾ' })
  brushRadiusCells = 3;

  @property({
    tooltip: 'Số frame LIÊN TIẾP mà rìa brush chạm biên túi thì ĐÓNG TÚI GIỮA NÉT (tay vẫn giữ). '
      + 'Nguồn: GrainTuningConfig.swipeBatchEmptyStampsToClose = 1. Đặt 0 = TẮT mốc rìa -> túi chỉ đóng khi nhả tay.',
    min: 0,
  })
  swipeEmptyStampsToClose = 1;

  @property({ tooltip: 'network id của variant đang build' })
  network: string = 'applovin';

  @property({ tooltip: 'HUD debug góc trái trên (hạt sống / emit / lọ hút / rơi khỏi rig / % đang chạy). TẮT trước khi build P5.' })
  debugHud = true;

  /**
   * A = port TS trung thực của solver Unity (PBD/DEM) — GIỮ TRỌN tuning nguồn, là bản chuẩn cho parity P6.
   * B = cellular automaton (solver/modeB.ts) — rẻ ~10x, dùng khi A quá nặng; tuning tầng physics KHÁC HẲN,
   * phải tune lại bằng mắt. ĐỪNG đọc số parity theo B.
   */
  @property({ tooltip: 'Solver cát: A = port trung thực (chuẩn parity) · B = cellular automaton (rẻ, tune riêng)' })
  solverMode: string = 'A';

  /**
   * Hình khối STAND-IN của rig (khung/phễu/vành) vẽ thẳng từ SDF. Từ 2026-08-24 MẶC ĐỊNH TẮT: art thật (Artboard +
   * khungbangchuyen + Bangchuyen2) đã ráp nên stand-in chỉ còn là công cụ CHẨN ĐOÁN — bật khi cần thấy
   * chính xác chỗ cát bị chặn, vì nó vẽ THẲNG từ SDF nên không thể lệch so với va chạm thật.
   */
  @property({ tooltip: 'Vẽ hình khối stand-in của rig từ SDF (khung/phễu/vành). Tắt khi đã có art PNG thật.' })
  showRigStandIn = false;

  /**
   * Probe CHẨN ĐOÁN hạt đứng im (game/StaticProbe.ts) — in ra console mỗi `staticProbePeriod` giây, phân loại
   * hạt tĩnh theo THỨ ĐANG GIỮ NÓ (rig / occupancy tranh / ghost / lơ lửng thật). Chỉ đọc, không sửa gì.
   * TẮT trước build P5 như debugHud.
   */
  @property({ tooltip: 'In log phân loại hạt đứng im ra console (chẩn đoán). TẮT trước build P5.' })
  staticProbe = true;

  @property({ tooltip: 'Chu kỳ in log probe (giây)' })
  staticProbePeriod = 2;

  /**
   * Console của bản preview nằm trong trình duyệt/editor nên phía ngoài KHÔNG đọc được. Đặt URL này thì mỗi lô
   * log probe được POST thêm sang server `tools/probe-sink.js` để ghi ra file đọc được. Rỗng = chỉ in console.
   * Lỗi mạng bị NUỐT có chủ ý: không có sink thì ad vẫn phải chạy y nguyên.
   */
  @property({ tooltip: 'URL sink nhận log probe (node tools/probe-sink.js). Rỗng = chỉ in console.' })
  staticProbeSink = 'http://127.0.0.1:7799/';

  // --- state ---
  private level!: LoadedLevel;
  private map!: PictureMap;
  private tex!: PictureTexture;
  private host!: SandPictureHost;
  private front!: ConversionFront;
  private solver!: SandSolver | SandCellSolver;
  private rig!: SdfRig;
  private renderer: SandGrainRenderer | null = null;
  private runner: ScenarioRunner | null = null;
  private jarColumns: JarColumns | null = null;
  private jarFly: JarFlyVisual | null = null;
  private gameCamera: Camera | null = null;
  /** Art nut CTA (assets/resources/ui/cta-button.png). null = chua co art -> ve placeholder mau. */
  private ctaTex: Texture2D | null = null;
  /** Prefab mesh hộp lọ (assets/resources/box/SKM_Box.fbx). null = chưa nạp được -> quad màu. */
  private boxPrefab: Prefab | null = null;
  /** hex HOA 6 ký tự -> atlas màu của hộp. Thiếu màu nào thì hộp màu đó chỉ có mesh trắng. */
  private readonly boxTex: Record<string, Texture2D> = {};
  /** Đường dẫn resources đã nạp được prefab hộp (hoặc lý do thiếu) — in ra log boot. */
  private boxPrefabPath = '(chua nap)';
  /** Số lọ bắt được SkeletalAnimation của hộp (BoxAnim). 0 mà có mesh hộp = clip không tới được runtime. */
  private jarsAnimated = 0;
  /** Các giỏ clip tra được ở hộp cuối cùng gắn anim — boot log in để biết clip nào thiếu. */
  private boxAnimSlots = '';

  /** Số lớp art nền dựng được (BoardVisual). Ít hơn số lớp trong layout = có PNG chưa nạp được. */
  private boardLayers = 0;
  /** Layout chỉnh tay được; mặc định = số suy từ prefab Unity. */
  private layout: BoardLayout = BOARD_DEFAULT;
  /** Layout đang chạy lấy từ đâu — in ra log boot để biết file chỉnh tay CÓ ĂN hay không. */
  private layoutSource = 'MAC DINH';

  private solverParams!: SolverParams;
  private occ!: GrainOccupancyField;
  private occRaw!: Uint8Array;
  private occDilated!: Uint8Array;
  private occNormals!: Float32Array;

  private ready = false;
  private simAccum = 0;
  private touching = false;
  private strokeArc = 0;
  /** Số frame LIÊN TIẾP mà dấu chân brush đã chạm biên túi (nguồn: SandSwipeController._emptyStampStreak). */
  private emptyStampStreak = 0;
  private readonly lastCell = { x: 0, y: 0 };
  private readonly tmpWorld = new Vec3();

  /** Số hạt bị escape-guard giật về miệng phễu ở step gần nhất — P6 đọc (lớn = tường đang rò). */
  lastRespawned = 0;
  /** Số lệnh emit bị trượt vì pool đầy. > 0 = capacity thấp hơn throttle, hoặc throttle không chạy. */
  emitDroppedCount = 0;

  // ---- đếm cho HUD debug: 3 CỬA hạt rời pool, tách bạch để nhìn 1 phát biết hạt đi đâu ----
  /** Hạt đã sinh ra từ tranh (ConversionFront). */
  private emittedTotal = 0;
  /** Hạt bị LỌ hút (harvestJar -> pool.removeAt). */
  private harvestedTotal = 0;
  /** Hạt bị killBelowY loại (rơi lọt khỏi rig). */
  private killedTotal = 0;
  private hudLabel: Label | null = null;
  private hudTimer = 0;
  private probeTimer = 0;

  // ---- belt-full gate + cửa trượt SDF (xem §BELT-FULL bên dưới) ----
  private beltGate: BeltFullGate | null = null;
  private beltRegion: BeltRegion | null = null;
  /** ĐỘ ĐÓNG cửa: 0 = mở hẳn, 1 = đóng kín khe entry. */
  private doorOpenness = 0;
  private doorTarget = 0;
  private doorDesired = 0;
  /** 1 segment [ax, ay, bx, by] LOCAL — cấp 1 lần, ghi đè mỗi step. */
  private readonly doorSeg = new Float32Array(4);
  private beltFull = false;
  /** Số hạt đang trong vành ở step gần nhất — HUD + P6 đọc. */
  private beltGrainCount = 0;

  // ==================================================================== khởi tạo

  onLoad(): void {
    this.setupCamera();
    void this.boot();
  }

  /** Nạp asset (bất đồng bộ) rồi dựng. Cờ `ready` gác `update()` để không chạy sim khi chưa có gì. */
  private async boot(): Promise<void> {
    const [levelTxt, scenarioTxt, grainMat, pictureMat, ctaTex] = await Promise.all([
      loadRes(this.levelResPath, TextAsset),
      loadRes(this.scenarioResPath, TextAsset),
      loadRes('mat/grain', Material),
      loadRes('mat/picture', Material),
      // Art CTA la TUY CHON: thieu -> null -> quad mau nhu cu. Khong duoc chan boot vi mot cai nut.
      loadResOpt('ui/cta-button/texture', Texture2D),
    ]);
    this.ctaTex = ctaTex;

    this.level = loadLevel(levelTxt.text);

    // --- tranh: map + texture ---
    // pixelSize + tâm lấy THẲNG từ config Unity (không fit theo khung tự đặt): giữ đúng tỉ lệ hạt/pixel mà toàn
    // bộ tuning được cân theo. Xem PICTURE_CELL_WORLD_SIZE trong SandTuning.ts để biết 0.1025 ở đâu ra.
    const rows = this.level.viewportRows > 0 && this.level.viewportRows < this.level.mechHeight
      ? this.level.viewportRows : this.level.mechHeight;
    this.map = new PictureMap(
      this.level.mechWidth, this.level.mechHeight, PICTURE_PIXEL_WORLD,
      RIG_LAYOUT.quadPositionX - (this.level.mechWidth - 1) * 0.5 * PICTURE_PIXEL_WORLD,
      RIG_LAYOUT.quadPositionY + (rows - 1) * 0.5 * PICTURE_PIXEL_WORLD,
    );
    this.tex = new PictureTexture(
      this.level.mechWidth, this.level.mechHeight,
      this.level.viewWidth, this.level.viewHeight,
      this.level.viewColors, SAND_TUNING.swipeBatchRevertDuration,
    );

    // --- carve model + host ---
    const model = buildCarveModel(this.level, SAND_TUNING.grainEscapeSlideCells);
    this.host = new SandPictureHost(model, this.map, this.tex, {
      slabCells: SAND_TUNING.swipeBatchSlabCells,
      thinStripCells: SAND_TUNING.swipeBatchThinStripCells,
      thinStripMaxCells: SAND_TUNING.swipeBatchThinStripMaxCells,
      // Nguồn: clearance = số RING × cỡ 1 pixel. grainSpawnClearanceRings = 2.
      spawnClearanceMargin: SAND_TUNING.grainSpawnClearanceRings * this.map.pixelSize,
    });

    // --- solver ---
    this.solver = this.solverMode.toUpperCase() === 'B' ? new SandCellSolver() : new SandSolver();
    const cap = grainPoolCapacity();
    this.solver.alloc(cap);
    this.rig = buildSdfRig();

    this.occ = this.map.makeOccupancyField({
      pushStrength: SAND_TUNING.grainOccupancyPushStrength,
      maxStep: SAND_TUNING.grainOccupancyMaxStep,
      smoothRadius: SAND_TUNING.grainOccupancySmoothRadius,
      dilateCells: SAND_TUNING.grainOccupancyDilateCells,
      ejectSearchCells: SAND_TUNING.grainOccupancyEjectSearchCells,
      creepWindow: SAND_TUNING.grainSurfaceCreepWindow,
      creepSpeed: SAND_TUNING.grainSurfaceCreepSpeed,
      creepSlopeMin: SAND_TUNING.grainSurfaceCreepSlopeMin,
      creepLateralMax: SAND_TUNING.grainCreepLateralMax,
    }, this.level.columnCount, this.level.viewportRows);

    const occCells = this.occ.occWidth * this.occ.occHeight;
    this.occRaw = new Uint8Array(occCells);
    // dilateCells = 0 -> solver phải nhận TRÙNG 1 mảng để bit-identical với nguồn (xem refreshOccupancy).
    this.occDilated = SAND_TUNING.grainOccupancyDilateCells > 0 ? new Uint8Array(occCells) : this.occRaw;
    this.occNormals = new Float32Array(occCells * 2);

    this.solverParams = this.makeSolverParams();
    this.setupBeltGate();

    // --- conversion front ---
    const backend: SandFlowBackend = {
      acceptSand: (req: SandEmitRequest) => this.emitGrain(req),
    };
    this.front = new ConversionFront(model, this.host, backend, makeConversionFrontConfig());
    this.front.begin();

    if (this.showRigStandIn) buildRigVisual(this.node, this.rig, Z_RIG);
    this.buildPicture(pictureMat);
    this.buildGrainRenderer(grainMat, cap);
    await this.loadLayout();
    await this.loadBoxArt();
    // Art nền dựng TRƯỚC lọ/CTA nhưng z của nó nằm sau tất cả, nên thứ tự dựng không quyết định thứ tự vẽ.
    const layers = this.layout.board;
    const boardTex = await Promise.all(layers.map((L) => loadResOpt(`${L.res}/texture`, Texture2D)));
    this.boardLayers = buildBoardVisual(this.node, layers, boardTex);
    this.buildJars();
    this.setupScenario(scenarioTxt);
    this.syncOccupancy();
    this.ready = true;
    this.reportBoot();
  }

  /** 1 lô log lúc boot xong: art nào nạp được, dựng được bao nhiêu lọ. Trả lời thẳng "sao không thấy asset". */
  private reportBoot(): void {
    const texKeys = Object.keys(this.boxTex);
    const fit = lastBoxFit();
    const zDeep = Z_JAR + JAR_Z_STEP * (JAR_SLOT_Y.length - 1) + this.layout.box.dz;
    const lines = [
      `[boot] mode=${this.solverMode.toUpperCase()} lo=${this.level.jars.length} `
      + `poolCap=${this.solver.pool.capacity} rigStandIn=${this.showRigStandIn}`,
      `[boot] art: boxPrefab=${this.boxPrefab !== null ? 'OK' : 'THIEU'} `
      + `boxTex=[${texKeys.join(',')}] boxPath=${this.boxPrefabPath} ctaTex=${this.ctaTex !== null ? 'OK' : 'THIEU'} `
      + `board=${this.boardLayers}/${this.layout.board.length} layout=${this.layoutSource}`,
      `[boot] boxAnim: ${this.layout.anim.enabled ? 'BAT' : 'TAT'} loCoAnim=${this.jarsAnimated}/${this.level.jars.length} `
      + `clip=[${this.boxAnimSlots}] speed=${this.layout.anim.speed}`,
      `[boot] box: day=${fit.depth.toFixed(2)} zSlot0=${Z_JAR.toFixed(2)} zSlotSau=${zDeep.toFixed(2)} `
      + `buocZ=${JAR_Z_STEP} dz=${this.layout.box.dz} matSauZ(slot0)=${(Z_JAR + fit.backLocalZ).toFixed(2)} `
      + `-> art nen phai co z < ${(Z_JAR + fit.backLocalZ).toFixed(2)} moi khong che ruot hop`,
      `[boot] fill: ${this.layout.fill.enabled ? 'BAT' : 'TAT'} khoi=${this.layout.fill.smoke ? 'BAT' : 'TAT'} `
      + `range=${this.layout.fill.range} ctaZ=${Z_CTA} tranDz=${MAX_BOX_DZ.toFixed(2)}`,
    ];
    for (const l of lines) console.log(l);
    this.sendProbe(lines);
  }

  // ==================================================================== dựng cây node

  private setupCamera(): void {
    const node = new Node('Main Camera');
    node.setParent(this.node.parent ?? this.node);
    node.setWorldPosition(0, CAM_CENTER_Y, 100);
    const cam = node.addComponent(Camera);
    cam.projection = Camera.ProjectionType.ORTHO;
    cam.orthoHeight = this.resolveOrthoHeight(200);
    cam.near = 0.1;
    cam.far = 400;
    cam.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    cam.clearColor = new Color(24, 22, 28, 255);
    this.gameCamera = cam;
  }

  /**
   * Camera ortho của Cocos fit theo CHIỀU CAO. Màn hẹp hơn 9:16 sẽ cắt mất mép tranh, nên nới chiều cao lên cho
   * đủ bề ngang. Ad chạy portrait nên nhánh này gần như không kích hoạt — nó là net an toàn, không phải layout.
   */
  private resolveOrthoHeight(mechWidth: number): number {
    const size = view.getVisibleSize();
    const aspect = size.height > 0 ? size.width / size.height : 9 / 16;
    const halfWidthNeeded = mechWidth * 0.5 * PICTURE_PIXEL_WORLD;
    const needed = aspect > 0 ? halfWidthNeeded / aspect : CAM_HALF_HEIGHT;
    return Math.max(CAM_HALF_HEIGHT, needed);
  }

  private buildPicture(mat: Material): void {
    const node = new Node('PictureView');
    node.setParent(this.node);
    const pv = node.addComponent(PictureView);
    pv.pictureMaterial = mat;
    pv.build(this.map.worldBounds(), this.tex.texture, this.tex.texelSize());
    const p = node.worldPosition;
    node.setWorldPosition(p.x, p.y, Z_PICTURE);
  }

  private buildGrainRenderer(mat: Material, cap: number): void {
    const node = new Node('SandGrains');
    node.setParent(this.node);
    node.setWorldPosition(0, 0, Z_GRAIN);
    this.renderer = node.addComponent(SandGrainRenderer);
    this.renderer.grainMaterial = mat;
    this.renderer.init(cap, this.level.palette);
  }

  /**
   * 14 lọ / 4 cột. Layout + hộp hút lấy từ prefab (xem khối hằng số LAYOUT LỌ ở đầu file).
   *
   * ⚠ SỬA 2026-08-24 — ĐÂY LÀ BUG LÀM "CÁT BIẾN MẤT" VÀ "BĂNG CHUYỀN ĐỨNG IM":
   * bản trước cấp cho CẢ 4 CỘT một hộp hút phủ TRỌN nửa dưới vành stadium (|x| tới ±(halfBody+rOut)·geomScale,
   * y từ tâm vành xuống mép ngoài). `harvestJar` (solver/counting.ts) gọi `pool.removeAt` -> toàn bộ đường
   * chạy DƯỚI của băng chuyền là một cái MÁY HÚT: hạt vừa rơi tới rãnh là bốc hơi, không kịp được belt chở đi
   * đâu. Nhìn ra ngoài y hệt "belt chết + cát tự biến mất".
   * Lý do cũ ("belt = 0 nên hộp hẹp làm 2/4 cột chết đói") đã hết hiệu lực từ lúc belt chạy thật (Cocos 2b1b078).
   *
   * Hộp đúng theo nguồn: tâm = tâm HEAD JAR của cột + autoMouthOffset, cỡ = autoMouthSize.
   * Với 4 cột thì 4 hộp phủ 4×2.3 = 9.2 world trên dấu chân belt rộng ~18.2 -> hở ~50% cho hạt chạy vòng.
   */
  /**
   * Nạp file chỉnh tay layout (assets/resources/data/board-layout.txt). Thiếu/hỏng -> BOARD_DEFAULT, và nói rõ
   * trong log là đang chạy bằng số mặc định — im lặng ở đây thì người chỉnh tay sửa mãi mà không thấy đổi.
   */
  private async loadLayout(): Promise<void> {
    const asset = await loadResOpt(this.boardLayoutResPath, TextAsset);
    if (asset === null) { this.layoutSource = 'MAC DINH (khong co file)'; return; }
    try {
      this.layout = parseBoardLayout(asset.text);
      // Kẹp dz TẠI ĐÂY chứ không ở BoxVisual: trần phụ thuộc Z_CTA/Z_JAR — hai hằng của cảnh, chỗ này biết,
      // BoxVisual thì không. Vượt trần thì kẹp im lặng nhưng boot log in số ĐÃ kẹp để đối chiếu.
      if (this.layout.box.dz > MAX_BOX_DZ) this.layout.box.dz = MAX_BOX_DZ;
      this.layoutSource = this.boardLayoutResPath;
    } catch (e) {
      this.layoutSource = `MAC DINH (JSON hong: ${(e as Error).message})`;
      console.warn(`[AdRoot] ${this.boardLayoutResPath} hỏng JSON — dùng số mặc định.`, e);
    }
  }

  /**
   * Nạp art hộp lọ: 1 prefab mesh + 1 atlas màu cho MỖI màu lọ level dùng (tên file = hex, xem BoxVisual).
   * TUỲ CHỌN hết: thiếu file -> null -> buildJars rơi về quad màu như trước, KHÔNG chặn boot vì cái hộp.
   */
  private async loadBoxArt(): Promise<void> {
    const hexes: string[] = [];
    for (const spec of this.level.jars) {
      const rgb = hexOfColorName(spec.colorName);
      if (rgb < 0) continue;
      const name = boxTextureName(rgb);
      if (hexes.indexOf(name) < 0) hexes.push(name);
    }
    // FBX là asset GHÉP: prefab nằm TRONG nó dưới tên sub-asset "SKM_Box.prefab" (xem subMetas của .fbx.meta),
    // nên đường dẫn resources là "<file>/<tên sub-asset>" — y hệt kiểu "box/FF9900/texture" của ảnh. Thử lần
    // lượt rồi GHI LẠI cái nào ăn: đoán 1 phát rồi im lặng trả null chính là cái đã ra boxPrefab=THIEU.
    const candidates = ['box/SKM_Box/SKM_Box', 'box/SKM_Box'];
    const [prefab, texes] = await Promise.all([
      (async (): Promise<Prefab | null> => {
        for (const p of candidates) {
          const a = await loadResOpt(p, Prefab);
          if (a !== null) { this.boxPrefabPath = p; return a; }
        }
        this.boxPrefabPath = `THIEU (da thu: ${candidates.join(' , ')})`;
        return null;
      })(),
      Promise.all(hexes.map((h) => loadResOpt(`box/${h}/texture`, Texture2D))),
    ]);
    this.boxPrefab = prefab;
    for (let i = 0; i < hexes.length; i++) {
      const t = texes[i];
      if (t !== null) this.boxTex[hexes[i]] = t;
    }
  }

  private buildJars(): void {
    const jarRoot = new Node('Jars');
    jarRoot.setParent(this.node);

    const headY = JAR_SLOT_Y[0];
    const mouthCenterY = headY + JAR_MOUTH_OFFSET_Y;

    const specs: JarColumnSpec[] = [];
    for (let c = 0; c < JAR_COLUMN_X.length; c++) {
      const cx = JAR_COLUMN_X[c];
      specs.push({
        jars: [],
        slots: JAR_SLOT_Y.map((y, i) => new Vec3(cx, y, Z_JAR + JAR_Z_STEP * i)),
        // Hộp RIÊNG từng cột — KHÔNG dùng chung 1 object, mỗi cột 1 bbox tại chỗ đứng của chính nó.
        mouth: mouthFromCenterSize(cx, mouthCenterY, JAR_MOUTH_W, JAR_MOUTH_H),
      });
    }

    for (const spec of this.level.jars) {
      if (spec.column < 0 || spec.column >= specs.length) {
        console.warn(`[AdRoot] lọ ở cột ${spec.column} vượt ${specs.length} cột layout — bỏ qua.`);
        continue;
      }
      const node = new Node(`Jar_${spec.column}_${spec.slot}_${spec.colorName}`);
      node.setParent(jarRoot);
      const rgb = hexOfColorName(spec.colorName);
      // Mesh hộp thật; thiếu prefab/atlas -> quad màu placeholder như bản trước (không để lọ tàng hình).
      const boxNode = this.boxPrefab !== null
        ? attachBox(node, this.boxPrefab, rgb >= 0 ? this.boxTex[boxTextureName(rgb)] ?? null : null,
                    this.layout.box)
        : null;
      if (boxNode === null) attachQuad(node, JAR_W, JAR_H, hexToColor(rgb), null, false);

      const jar = node.addComponent(ColorJar);
      // Anim hộp: clip đã nằm sẵn trong prefab fbx, chỉ cần bấm đúng lúc (BoxAnim). Không có anim -> hộp
      // đứng bind pose y như bản trước, lọ vẫn chạy đủ.
      if (boxNode !== null) {
        jar.boxAnim = BoxAnim.attach(boxNode, this.layout.anim);
        if (jar.boxAnim !== null) { this.jarsAnimated++; this.boxAnimSlots = jar.boxAnim.slots; }
      }
      jar.mouthWidth = JAR_W;
      jar.mouthHeight = JAR_H;
      const cid = colorIdOfJarName(this.level, spec.colorName);
      if (cid < 0) {
        console.warn(`[AdRoot] lọ "${spec.colorName}" không map được sang colorId — lọ này sẽ KHÔNG hút hạt.`);
      }
      jar.setup(spec.colorName, cid, spec.capacity);
      // Mực cát + khói: dựng SAU setup để nó đọc được màu, và gắn vào node LỌ (không phải node hộp) — hộp bị
      // BoxVisual scale/xoay, treo mặt cát vào đó là mọi số tuning phải nhân ngược hệ số fit.
      if (this.layout.fill.enabled) jar.fillVisual = new JarFillVisual(node, this.layout.fill, rgb);
      jar.node.active = !spec.hidden;
      jar.onFull(() => this.runner?.notifyJarFull());
      specs[spec.column].jars.push(jar);
    }

    this.jarColumns = new JarColumns(specs);
    this.jarFly = new JarFlyVisual(this.node, Z_JAR_FLY);
  }

  private setupScenario(asset: TextAsset): void {
    const json = JSON.parse(asset.text) as ScenarioJson;
    this.runner = this.getComponent(ScenarioRunner) ?? this.addComponent(ScenarioRunner)!;
    this.runner.ctaNode = this.buildCta(json);
    this.runner.handHintNode = this.buildHandHint(json);
    this.runner.init(json, this.network as NetworkId);
  }

  /** Tỉ lệ màn hình [0..1] gốc dưới-trái -> world (camera ortho, tâm (0, CAM_CENTER_Y)). */
  private screenRatioToWorld(rx: number, ry: number, z: number): Vec3 {
    const halfH = this.gameCamera?.orthoHeight ?? CAM_HALF_HEIGHT;
    const size = view.getVisibleSize();
    const aspect = size.height > 0 ? size.width / size.height : 9 / 16;
    const halfW = halfH * aspect;
    return new Vec3((rx - 0.5) * 2 * halfW, CAM_CENTER_Y + (ry - 0.5) * 2 * halfH, z);
  }

  /**
   * Nút CTA = PLACEHOLDER quad (xem QuadVisual.ts). Art thật là 1 PNG ĐÃ IN SẴN CHỮ "PLAY NOW"
   * (scenario.cta.visualCue.art.status = PENDING_USER) -> có art rồi thì chỉ truyền texture vào attachQuad.
   * Nút chỉ là TÍN HIỆU: CTA armed thì chạm CHỖ NÀO cũng mở store (ScenarioRunner bắt ở tầng global).
   */
  private buildCta(json: ScenarioJson): Node {
    const cue = json.cta.visualCue;
    const widthPct = cue?.widthPct ?? 0.62;
    const marginPct = cue?.marginBottomPct ?? 0.08;

    const halfH = this.gameCamera?.orthoHeight ?? CAM_HALF_HEIGHT;
    const size = view.getVisibleSize();
    const aspect = size.height > 0 ? size.width / size.height : 9 / 16;
    const w = widthPct * 2 * halfH * aspect;
    // Ti le nut lay THEO ART that (862x405 = 2.128) chu khong phai hang so 0.24 cua placeholder — dung 0.24 voi
    // art vien thuoc nay se bop det vien bo tron. Chua co art -> giu 0.24 nhu cu.
    const artRatio = this.ctaTex !== null && this.ctaTex.height > 0 ? this.ctaTex.width / this.ctaTex.height : 0;
    const h = artRatio > 0 ? w / artRatio : w * 0.24;

    const node = new Node('CtaButton');
    node.setParent(this.node);
    // Co art -> tint TRANG (khong nhan mau len art). Khong co art -> quad cam nhu cu.
    const tint = this.ctaTex !== null ? new Color(255, 255, 255, 255) : new Color(255, 176, 32, 255);
    attachQuad(node, w, h, tint, this.ctaTex);
    const pos = this.screenRatioToWorld(0.5, marginPct, Z_CTA);
    node.setWorldPosition(pos.x, pos.y + h * 0.5, Z_CTA);
    node.active = false;
    return node;
  }

  private buildHandHint(json: ScenarioJson): Node {
    const node = new Node('HandHint');
    node.setParent(this.node);
    attachQuad(node, 1.6, 1.6, new Color(255, 255, 255, 210));
    const hint = node.addComponent(HandHint);
    const path = json.input.handHint.path ?? [];
    hint.setPath(path.map((p) => this.screenRatioToWorld(p[0], p[1], Z_HINT)));
    node.active = false;
    return node;
  }

  // ==================================================================== solver params

  private makeSolverParams(): SolverParams {
    const { sdf, segments, grid, cellStart, cellItems, cellMask } = this.rig;
    const empty = new Float32Array(0);

    // frictionKeep: nguồn quy đổi SẴN = pow(1 - f, 1/substeps) vì clamp tường chạy MỖI substep; truyền (1-f)
    // thẳng vào sẽ ma sát mạnh gấp `substeps` lần.
    const frictionKeep = Math.pow(1 - SAND_TUNING.grainWallFriction, 1 / SAND_TUNING.grainSubsteps);
    // Broad-phase đường integrate có knob RIÊNG và còn ĐÒI mask hợp lệ (segmentCount <= 64) — cùng gate của nguồn.
    const wgi = SAND_TUNING.grainWallGridIntegrate && grid.enabled !== 0 && grid.maskValid !== 0 ? 1 : 0;

    return {
      iterations: SAND_TUNING.grainContactIterations,
      subdiv: SAND_TUNING.grainNeighborGridEnabled ? SAND_TUNING.grainNeighborGridSubdiv : 1,
      cellSize: 2 * SAND_TUNING.grainParticleRadius,
      hasSdf: 1,
      killBelowY: SAND_TUNING.grainDespawnY,

      integrate: {
        gravityX: 0, gravityY: SAND_TUNING.grainGravityY,
        dt: SIM_DT, substeps: SAND_TUNING.grainSubsteps,
        hasSdf: 1, sdf, segments,
        restitution: SAND_TUNING.grainWallRestitution,
        frictionKeep,
        // Belt = băng chuyền, CHẠY THẬT. ⚠ SỬA 2026-08-24: bản trước để cả 12 knob = 0 vì manifest P2 đọc
        // `ConveyorController` là shell no-op rồi suy ra belt tắt. Sai: lực belt KHÔNG nằm ở controller đó mà ở
        // `GrainFlowBackend`, ăn thẳng 13 con số dưới đây — chúng nằm sẵn trong ir/tuning.json configs.5.data.
        // Hệ quả của bug cũ: không có gì tải hạt đi -> hạt đọng ở đáy, băng chuyền đứng im (user báo mục 4 + 6).
        beltSpeed: SAND_TUNING.grainBeltSpeed,
        beltCoupling: SAND_TUNING.grainBeltCoupling,
        beltRadialDamping: SAND_TUNING.grainBeltRadialDamping,
        beltTopRelease: SAND_TUNING.grainBeltTopRelease,
        beltTopReleaseStart: SAND_TUNING.grainBeltTopReleaseStart,
        beltTopTangentDamp: SAND_TUNING.grainBeltTopTangentDamp,
        beltSpeedUp: SAND_TUNING.grainBeltUpSpeed,
        beltCouplingUp: SAND_TUNING.grainBeltUpCoupling,
        beltRadialDampingUp: SAND_TUNING.grainBeltUpRadialDamping,
        beltTopReleaseUp: SAND_TUNING.grainBeltUpTopRelease,
        beltTopReleaseStartUp: SAND_TUNING.grainBeltUpTopReleaseStart,
        beltTopTangentDampUp: SAND_TUNING.grainBeltUpTopTangentDamp,
        enforceOneWay: SAND_TUNING.grainBeltOneWay ? 1 : 0,
        // Cửa trượt vẫn TẮT: nó đóng theo tỉ lệ belt-full (conveyorCapacityMode=AutoFillRatio, grainBeltFullEntry
        // /Exit/Timeout) mà mình chưa port bộ đếm đó. Xem SdfBuild.ts — doorThr đã tính sẵn để bật lại.
        //
        // ⚠ SỬA 2026-08-24 (bug thứ 2, cùng ổ với belt): gapBeltTopY = 0 là TRẦN VORTEX khi cửa ĐÓNG. Cửa đang
        // tắt mà vẫn để 0 nghĩa là vĩnh viễn áp hành vi "cửa đóng" cho vùng |x| <= wallX — ĐÚNG dấu chân miệng
        // phễu. integrate.ts dòng 172: beltTopHere = |lp.x|<=wallX ? gapBeltTopY : sdf.beltTopY -> hạt ngay dưới
        // phễu không nhận vortex -> kẹt tại chỗ. Cửa mở thì trần phải là beltTopY nguyên vẹn.
        hasDoor: 0, door: empty, gapBeltTopY: this.rig.sdf.beltTopY,
        hasOcc: 1, occ: this.occ,
        occSnapshot: this.occDilated, occSnapshotRaw: this.occRaw, occNormals: this.occNormals,
        occSlip: SAND_TUNING.grainOccupancySlip,
        wgiEnabled: wgi, wallGrid: grid, wallCellMask: cellMask,
      },

      ccd: {
        dt: SIM_DT,
        ccdGate: SAND_TUNING.grainGrainCcdGate,
        ccdMaxPull: SAND_TUNING.grainGrainCcdMaxPull,
        uniformRadius: SAND_TUNING.grainParticleRadius,
      },

      accumulate: {
        stiffness: SAND_TUNING.grainContactStiffness,
        softness: SAND_TUNING.grainContactSoftness,
        maxPush: SAND_TUNING.grainContactMaxPush,
        intruderBias: SAND_TUNING.grainContactIntruderBias,
        uniformRadius: SAND_TUNING.grainParticleRadius,
      },

      apply: {
        dt: SIM_DT,
        hasOcc: 1, occ: this.occ,
        occSnapshot: this.occDilated, occSnapshotRaw: this.occRaw, occNormals: this.occNormals,
        hasSdf: 1, sdf, segments,
        hasDoor: 0, door: empty,
        wallCompliance: SAND_TUNING.grainWallCompliance,
        wallGrid: grid, wallCellStart: cellStart, wallCellItems: cellItems,
      },

      posFriction: {
        frictionPosMu: SAND_TUNING.grainFrictionPosMu,
        uniformRadius: SAND_TUNING.grainParticleRadius,
      },

      finalize: {
        dt: SIM_DT,
        damping: SAND_TUNING.grainContactDamping,
        absorbCapMul: SAND_TUNING.grainContactAbsorbCapMul,
        frictionVelocity: SAND_TUNING.grainFrictionVelocity,
        frictionSurfaceDrag: SAND_TUNING.grainFrictionSurfaceDrag,
        frictionPos: SAND_TUNING.grainFrictionPosMu,
        settleDamping: SAND_TUNING.grainContactSettleDamping,
        gravityX: 0, gravityY: SAND_TUNING.grainGravityY,
        hasOcc: 1, occ: this.occ,
        occSnapshot: this.occDilated, occSnapshotRaw: this.occRaw, occNormals: this.occNormals,
        occSlip: SAND_TUNING.grainOccupancySlip,
        // SLEEP ĐÃ GỠ KHỎI SOLVER (2026-08-24). Nguồn Unity luôn tắt sleep (ir/tuning.json: grainSleepEnabled =
        // false) nên asleep[] vĩnh viễn toàn 0 -> mọi nhánh theo nó là code chết, đã xoá cả chuỗi (asleep/quadFrames
        // /copyAsleep/inConveyor/countNeighbors + FinalizeParams.gapBeltTopY). Toán tiếp xúc KHÔNG đổi: share 1-vs-½
        // rơi hết về ½. Bật lại sleep = revert commit này, không phải bật cờ.
        hasSdf: 1, sdf,
        uniformRadius: SAND_TUNING.grainParticleRadius,
      },
    };
  }

  /**
   * Backend cát: 1 lệnh emit = 1 HẠT (không phải carriedCount hạt). `carriedCount` là số PIXEL tranh mà hạt đó
   * gánh — lọ có capacity tính theo PIXEL nên hạt to gánh nhiều pixel, đúng nguồn.
   *
   * `ghostReleaseY = NaN` nghĩa là KHÔNG ghost (hợp đồng của SandEmitRequest). Booster đã DROP nên đường ghost
   * thực tế chỉ còn dùng cho auto-swipe (autoSwipeGhostMode = Always), không phải nam châm.
   *
   * pool.emit trả false khi pool ĐẦY -> đếm lại thay vì bỏ im lặng: emit trượt là cát biến mất, phải thấy được số.
   */
  private emitGrain(req: SandEmitRequest): void {
    const ghost = !Number.isNaN(req.ghostReleaseY);
    const ok = this.solver.pool.emit(
      req.x, req.y, req.vx, req.vy,
      SAND_TUNING.grainParticleRadius,
      req.colorId, req.carriedCount,
      ghost, ghost ? req.ghostReleaseY : 0, false,
    );
    if (ok) this.emittedTotal++;
    else this.emitDroppedCount++;
  }

  // ==================================================================== input vuốt

  onEnable(): void {
    input.on(Input.EventType.TOUCH_START, this.onTouchStart, this);
    input.on(Input.EventType.TOUCH_MOVE, this.onTouchMove, this);
    input.on(Input.EventType.TOUCH_END, this.onTouchEnd, this);
    input.on(Input.EventType.TOUCH_CANCEL, this.onTouchEnd, this);
  }

  onDisable(): void {
    input.off(Input.EventType.TOUCH_START, this.onTouchStart, this);
    input.off(Input.EventType.TOUCH_MOVE, this.onTouchMove, this);
    input.off(Input.EventType.TOUCH_END, this.onTouchEnd, this);
    input.off(Input.EventType.TOUCH_CANCEL, this.onTouchEnd, this);
  }

  /** Chạm -> ô tranh. null nếu chưa dựng xong (không đoán toạ độ). */
  private cellOfTouch(e: EventTouch): { x: number; y: number } | null {
    if (!this.ready || this.gameCamera === null) return null;
    const loc = e.getUILocation();
    // z = 0: mặt phẳng gameplay. screenToWorld cần z trong khoảng near..far -> lấy khoảng cách camera tới z=0.
    this.tmpWorld.set(loc.x, loc.y, this.gameCamera.node.worldPosition.z);
    const w = this.gameCamera.screenToWorld(this.tmpWorld, this.tmpWorld);
    const c = this.map.worldToCell(w.x, w.y, { x: 0, y: 0 });
    return { x: Math.round(c.x), y: Math.round(c.y) };
  }

  private onTouchStart(e: EventTouch): void {
    const c = this.cellOfTouch(e);
    if (c === null) return;
    this.touching = true;
    this.strokeArc = 0;
    this.emptyStampStreak = 0;
    // Nguồn OnStrokeBegin: đóng túi của nét TRƯỚC nếu vì lý do bất thường nó còn mở — 2 nét dính vào 1 túi thì
    // thứ tự drain (đo bằng quãng đường ngón tay) trộn của cả hai, cát rơi sai chỗ.
    this.host.closeStroke();
    this.lastCell.x = c.x;
    this.lastCell.y = c.y;
    this.host.carveAt(c.x, c.y, this.brushRadiusCells, this.strokeArc);
  }

  private onTouchMove(e: EventTouch): void {
    if (!this.touching) return;
    const c = this.cellOfTouch(e);
    if (c === null) return;

    // Nội suy theo Ô: ngón đi nhanh + frame drop -> 2 mẫu chạm cách nhau hàng chục ô. Không nội suy thì vệt cào
    // thành các đốm rời, cát chảy ra thành từng cụm chứ không thành dòng.
    const dx = c.x - this.lastCell.x, dy = c.y - this.lastCell.y;
    const steps = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dy * dy)));
    for (let s = 1; s <= steps; s++) {
      const px = Math.round(this.lastCell.x + (dx * s) / steps);
      const py = Math.round(this.lastCell.y + (dy * s) / steps);
      this.strokeArc += Math.sqrt(dx * dx + dy * dy) / steps;
      this.host.carveAt(px, py, this.brushRadiusCells, this.strokeArc);
    }
    this.lastCell.x = c.x;
    this.lastCell.y = c.y;
  }

  private onTouchEnd(_e: EventTouch): void {
    if (!this.touching) return;
    this.touching = false;
    this.emptyStampStreak = 0;
    this.host.closeStroke();
  }

  /**
   * D2 vế (b) — ĐÓNG TÚI GIỮA NÉT. Port `SandSwipeController.OnStrokeApplied`.
   *
   * VÌ SAO CẦN (bug user báo 2026-08-25 "swipe bên Unity tới đâu cát rơi tới đó, bên này chờ vuốt xong"):
   * ConversionFront gate kênh Swipe/Thin theo `hasOpenBatch` (đúng nguồn), mà bản Cocos trước CHỈ đóng túi ở
   * TOUCH_END -> gate chặn suốt cả nét -> toàn bộ cát dồn lại xả 1 phát lúc nhả tay. Nguồn có HAI mốc đóng:
   * nhả tay VÀ mốc rìa này; thiếu mốc rìa là mất luôn cảm giác "vuốt tới đâu rơi tới đó".
   *
   * CHẠY MỖI FRAME (không phải mỗi TOUCH_MOVE): nguồn gọi trong Apply theo frame, nên ngón DỪNG YÊN ngoài vùng
   * sống vẫn đóng được túi. Cocos chỉ bắn TOUCH_MOVE khi ngón DI CHUYỂN -> gắn vào đó là ngón dừng = túi treo.
   *
   * HỎI THEO `lastCell` (vị trí ngón HIỆN TẠI), không đọc cờ cache của nhát cào cuối: ra ngoài field thì carve
   * không chạy -> cờ cache đứng ở true -> streak reset mỗi frame -> lại chỉ đóng lúc nhả tay (đúng bug nguồn
   * đã vấp 2026-07-30).
   */
  private tickStrokeClose(): void {
    if (this.swipeEmptyStampsToClose <= 0) return;
    if (!this.host.hasOpenBatch) return;   // nét này chưa ăn tranh lần nào -> không có gì để đóng
    if (this.host.brushFootprintFullyLive(this.lastCell.x, this.lastCell.y, this.brushRadiusCells)) {
      this.emptyStampStreak = 0;           // "LIÊN TIẾP" = liên tiếp chạm biên túi
      return;
    }
    if (++this.emptyStampStreak < this.swipeEmptyStampsToClose) return;
    // Brush đã ra hẳn vùng Empty/ngoài khung/đã convert -> đóng túi NGAY; nét vẫn tiếp tục và túi đó TAN luôn
    // dù tay còn giữ. Chạm lại tranh thì host tự mở túi MỚI (1 nét qua 3 cụm tranh rời = 3 túi).
    this.host.closeStroke();
    this.emptyStampStreak = 0;
  }

  // ==================================================================== nhịp chạy

  update(dt: number): void {
    if (!this.ready) return;
    if (this.touching) this.tickStrokeClose();

    // Cap catch-up: 1 frame kẹt lâu không được kéo theo hàng chục step (spiral of death). Phần dt vượt trần bị
    // BỎ, tức ad chạy chậm lại thay vì đứng hình — đúng lựa chọn cho ad 15-30s.
    const maxSteps = Math.max(1, SAND_TUNING.grainMaxSolverStepsPerFrame);
    this.simAccum += dt;
    let steps = 0;
    while (this.simAccum >= SIM_DT && steps < maxSteps) {
      this.simAccum -= SIM_DT;
      steps++;
      this.simStep();
    }
    if (this.simAccum > SIM_DT * maxSteps) this.simAccum = SIM_DT * maxSteps;

    // Render + hình tranh + dồn cột lọ: 1 lần/FRAME.
    this.tex.update(dt);
    this.jarColumns?.tickVisual(dt);
    this.jarFly?.tick(dt);
    if (this.renderer !== null) this.renderer.syncFromPool(this.solver.pool);
    if (this.debugHud) this.tickHud(dt);
    if (this.staticProbe) this.tickStaticProbe(dt);
  }

  /** In bảng phân loại hạt tĩnh ra console theo chu kỳ. Xem đầu game/StaticProbe.ts để biết cách đọc. */
  private tickStaticProbe(dt: number): void {
    this.probeTimer += dt;
    const period = Math.max(0.25, this.staticProbePeriod);
    if (this.probeTimer < period) return;
    this.probeTimer = 0;
    const lines = probeStatic(this.solver.pool, this.solverParams.integrate);
    for (const l of lines) console.log(l);
    this.sendProbe(lines);
  }

  /** Đẩy lô log sang sink (nếu có). Fire-and-forget, mọi lỗi bị nuốt — sink chết không được làm ad chết. */
  private sendProbe(lines: string[]): void {
    const url = this.staticProbeSink;
    if (url === '' || typeof fetch !== 'function') return;
    // Bộ đếm 3 cửa hạt đi kèm MỖI lô: pool rỗng mà emit=0 là bug ĐƯỜNG SINH, còn emit lớn mà pool rỗng là
    // bug đường THOÁT — 2 hướng điều tra khác hẳn nhau, không có 2 số này thì đoán mò.
    const mode = `mode=${this.solverMode.toUpperCase()} t=${(this.runner?.secondsElapsed ?? 0).toFixed(1)}s `
      + `emit=${this.emittedTotal} drop=${this.emitDroppedCount} loHut=${this.harvestedTotal} `
      + `roiKhoiRig=${this.killedTotal} respawn=${this.lastRespawned}`;
    try {
      void fetch(url, { method: 'POST', body: `--- ${mode}\n${lines.join('\n')}` }).catch(() => { /* im lặng */ });
    } catch (e) { /* im lặng */ }
  }

  // ==================================================================== BELT-FULL: cửa trượt + boost

  /**
   * SỨC CHỨA BĂNG CHUYỀN — cái thiếu này là thủ phạm "cát trên belt không chạy CCW" (user báo 2026-08-24).
   *
   * Nguồn cấp cho vành một TRẦN CỨNG `ConveyorShape.maxGrainsManual = 2400` hạt. Chạm trần -> `MaxGrainGate`
   * bật belt-full -> (a) cửa SDF TRƯỢT ĐÓNG khe entry đỉnh ring (cát dồn ứ lại trong phễu, không vào thêm)
   * + (b) BOOST 6 knob belt để dọn nhanh chỗ đang có. Tụt dưới `exit` thì mở lại.
   *
   * Bản port trước bỏ CẢ HAI vế, trong khi throttle pool để 6000 hạt = 2.5× trần vành. Kết quả đo headless
   * (scratchpad/belt/dense2.js): vx trung bình trên belt -6.5 ở 1200 hạt -> -1.8 ở 2000 -> ≈ 0 từ 2400 trở lên.
   * Tức là vành chặt cứng rồi cát chỉ khuấy tại chỗ, đúng triệu chứng user tả.
   *
   * KHÔNG nối `onLose`: đây là đường THUA của game gốc, còn kịch bản ad luôn force-win + fallback 30s -> CTA.
   * `pictureCleared` (vế thứ 2 của boostOn bên nguồn) CHƯA nối — ConversionFront chưa phát tín hiệu "tranh tan hết".
   */
  private setupBeltGate(): void {
    this.beltRegion = {
      worldToLocal: this.rig.sdf.worldToLocal,
      beltHalfX: this.rig.sdf.beltHalfX,
      beltTopY: this.rig.sdf.beltTopY,
    };
    const gate = new BeltFullGate({
      entry: SAND_TUNING.grainBeltFullEntry,
      exit: SAND_TUNING.grainBeltFullExit,
      timeoutSeconds: SAND_TUNING.grainBeltFullTimeoutSeconds,
      preLostSeconds: SAND_TUNING.grainBeltFullPreLostSeconds,
    });
    gate.onBeltFullChanged = (full: boolean): void => {
      this.beltFull = full;
      this.doorDesired = full ? 1 : 0;    // ĐẶT CHỖ đích; NO-REVERSAL commit trong tickBeltGate
    };
    gate.begin();
    this.beltGate = gate;
  }

  /** MoveTowards của Unity: tiến về `target` tối đa `maxDelta`, không vọt qua. */
  private static moveTowards(cur: number, target: number, maxDelta: number): number {
    const d = target - cur;
    if (Math.abs(d) <= maxDelta) return target;
    return cur + Math.sign(d) * maxDelta;
  }

  /**
   * 1 nhịp gate — chạy TRƯỚC solver.step để cửa + hệ số boost của step này là bản tươi.
   * Nguồn: GrainFlowBackend.cs §"s2 cửa SDF" (555-576) + §boost (674-689).
   */
  private tickBeltGate(dt: number): void {
    const gate = this.beltGate;
    if (gate === null) return;
    const sdf = this.rig.sdf;

    this.beltGrainCount = countBeltGrains(this.solver.pool, this.beltRegion);
    gate.tick(fillRatio(this.beltGrainCount, CONVEYOR_SHAPE.maxGrains), dt);

    // NO-REVERSAL (nguồn chốt): cửa đang trượt dở KHÔNG quay đầu giữa chừng — đích mới chờ ở doorDesired, chỉ
    // commit khi đã đi hết hành trình. Trễ tối đa 1 hành trình = 1/rate giây.
    if (this.doorOpenness === this.doorTarget) this.doorTarget = this.doorDesired;
    const rate = SAND_TUNING.grainGateWallSpeed > 0 ? SAND_TUNING.grainGateWallSpeed : 1;
    this.doorOpenness = AdRoot.moveTowards(this.doorOpenness, this.doorTarget, rate * dt);

    // Cửa MỞ HẲN -> KHÔNG feed segment. Nguồn ghi rõ vì sao: openness=0 đẩy mép cửa về -3·gapHalf, đoạn đó
    // chặn nhầm vùng tự do trên-trái ring.
    const has = this.doorOpenness > 1e-3 ? 1 : 0;
    if (has !== 0) {
      const xL = -sdf.gapHalf - 2 * sdf.gapHalf * (1 - this.doorOpenness);
      const doorY = sdf.rOut + SAND_TUNING.grainGateWallYOffset;
      this.doorSeg[0] = xL;
      this.doorSeg[1] = doorY;
      this.doorSeg[2] = xL + 2 * sdf.gapHalf;
      this.doorSeg[3] = doorY;
    }
    const ip = this.solverParams.integrate;
    ip.hasDoor = has;
    ip.door = this.doorSeg;
    this.solverParams.apply.hasDoor = has;
    this.solverParams.apply.door = this.doorSeg;

    // BOOST 6 knob khi belt đầy. Nhân từ số NỀN của SAND_TUNING mỗi lần, không nhân dồn lên giá trị cũ.
    const on = this.beltFull;
    const mul = (base: number, rateMul: number): number => (on ? base * Math.max(0, rateMul) : base);
    ip.beltSpeed = mul(SAND_TUNING.grainBeltSpeed, SAND_TUNING.grainBeltSpeedBoostRate);
    ip.beltCoupling = mul(SAND_TUNING.grainBeltCoupling, SAND_TUNING.grainBeltCouplingBoostRate);
    ip.beltRadialDamping = mul(SAND_TUNING.grainBeltRadialDamping, SAND_TUNING.grainBeltRadialDampingBoostRate);
    ip.beltSpeedUp = mul(SAND_TUNING.grainBeltUpSpeed, SAND_TUNING.grainBeltUpSpeedBoostRate);
    ip.beltCouplingUp = mul(SAND_TUNING.grainBeltUpCoupling, SAND_TUNING.grainBeltUpCouplingBoostRate);
    ip.beltRadialDampingUp = mul(SAND_TUNING.grainBeltUpRadialDamping, SAND_TUNING.grainBeltUpRadialDampingBoostRate);
  }

  // ==================================================================== HUD debug

  /**
   * Canvas UI RIÊNG + camera RIÊNG. Cảnh này không có Canvas nào (mọi thứ là node 3D + QuadVisual), mà `Label`
   * là UI renderer nên bắt buộc phải có. Tách camera để không đụng `gameCamera`: camera HUD chỉ thấy UI_2D,
   * camera game chỉ thấy DEFAULT, clearFlags DONT_CLEAR để HUD vẽ ĐÈ chứ không xoá cảnh.
   */
  private buildHud(): void {
    const parent = this.node.parent ?? this.node;

    const camNode = new Node('HudCamera');
    camNode.layer = Layers.Enum.UI_2D;
    camNode.setParent(parent);
    const cam = camNode.addComponent(Camera);
    cam.projection = Camera.ProjectionType.ORTHO;
    cam.clearFlags = Camera.ClearFlag.DONT_CLEAR;
    cam.visibility = Layers.Enum.UI_2D;
    cam.priority = 100;         // vẽ SAU camera game
    cam.near = 1;
    cam.far = 2000;

    const canvasNode = new Node('HudCanvas');
    canvasNode.layer = Layers.Enum.UI_2D;
    canvasNode.setParent(parent);
    const canvas = canvasNode.addComponent(Canvas);
    canvas.cameraComponent = cam;

    const size = view.getVisibleSize();
    const labelNode = new Node('HudLabel');
    labelNode.layer = Layers.Enum.UI_2D;
    labelNode.setParent(canvasNode);
    const ut = labelNode.addComponent(UITransform);
    ut.setAnchorPoint(0, 1);    // neo góc TRÁI-TRÊN
    ut.setContentSize(size.width, size.height);
    labelNode.setPosition(-size.width * 0.5 + 12, size.height * 0.5 - 12, 0);

    const label = labelNode.addComponent(Label);
    label.fontSize = 22;
    label.lineHeight = 26;
    label.horizontalAlign = Label.HorizontalAlign.LEFT;
    label.verticalAlign = Label.VerticalAlign.TOP;
    label.overflow = Label.Overflow.NONE;
    label.color = new Color(120, 255, 140, 255);
    label.string = '';
    this.hudLabel = label;

    // Camera game chỉ nhìn DEFAULT -> không vẽ trùng HUD.
    if (this.gameCamera !== null) this.gameCamera.visibility = Layers.Enum.DEFAULT;
  }

  /** Làm mới 4 lần/giây — quét cả pool mỗi frame là phí, và mắt cũng không đọc kịp nhanh hơn. */
  private tickHud(dt: number): void {
    if (this.hudLabel === null) this.buildHud();
    if (this.hudLabel === null) return;
    this.hudTimer += dt;
    if (this.hudTimer < 0.25) return;
    this.hudTimer = 0;

    const pool = this.solver.pool;
    const n = pool.count;
    let sumSpeed = 0;
    let moving = 0;
    // vx TRUNG BÌNH CÓ DẤU của hạt trong vành = TẢI THẬT của băng chuyền. |v| không dùng được: cát khuấy tại
    // chỗ lúc nghẹt vẫn cho |v| lớn, chỉ vx có dấu mới phân biệt "chạy vòng" với "rung tại chỗ".
    let beltVx = 0;
    let inBelt = 0;
    const region = this.beltRegion;
    for (let i = 0; i < n; i++) {
      const vx = pool.velocities[i * 2], vy = pool.velocities[i * 2 + 1];
      const sp = Math.sqrt(vx * vx + vy * vy);
      sumSpeed += sp;
      if (sp > 0.5) moving++;
      if (region !== null && isInBeltLocal(region, pool.positions[i * 2], pool.positions[i * 2 + 1])) {
        inBelt++;
        beltVx += vx;
      }
    }
    const pct = (a: number, b: number): string => (b > 0 ? String(Math.round((100 * a) / b)) : '0');
    const fill = fillRatio(inBelt, CONVEYOR_SHAPE.maxGrains);
    this.hudLabel.string =
      `song ${n}  |  emit ${this.emittedTotal}  drop ${this.emitDroppedCount}
` +
      `lo hut ${this.harvestedTotal}  |  roi khoi rig ${this.killedTotal}  |  respawn ${this.lastRespawned}
` +
      `BELT ${inBelt}/${CONVEYOR_SHAPE.maxGrains} (fill ${(fill * 100).toFixed(0)}%)  vx tb ${(inBelt > 0 ? beltVx / inBelt : 0).toFixed(2)}
` +
      `cua ${(this.doorOpenness * 100).toFixed(0)}% dong${this.beltFull ? '  [BELT FULL - boost]' : ''}
` +
      `dang chay ${moving} (${pct(moving, n)}%)  |  |v| tb ${(n > 0 ? sumSpeed / n : 0).toFixed(2)}
` +
      `jar cleared ${this.jarColumns?.clearedCount ?? 0}  |  t ${(this.runner?.secondsElapsed ?? 0).toFixed(1)}s`;
  }

  private simStep(): void {
    this.front.tick(SIM_DT);
    this.syncOccupancy();
    this.tickBeltGate(SIM_DT);

    // Đo bằng CHÊNH LỆCH pool.count quanh từng cửa: trong 1 step chỉ có ĐÚNG 2 chỗ gọi pool.removeAt —
    // killBelowY (cuối solver.step) và harvestJar (trong harvest). Nên hiệu số quy được về đúng 1 nguyên nhân.
    const nBeforeStep = this.solver.pool.count;
    this.lastRespawned = this.solver.step(this.solverParams);
    this.killedTotal += nBeforeStep - this.solver.pool.count;

    const nBeforeHarvest = this.solver.pool.count;
    this.jarColumns?.harvest(this.solver.pool, (jar) => {
      // lastHarvested CHỈ hợp lệ ngay sau harvest của chính lọ đó -> đọc trong callback, không gom lại sau.
      this.jarFly?.spawnFrom(jar.lastHarvested, jar.node.worldPosition,
                             hexToColor(hexOfColorName(jar.colorName)));
    });
    this.harvestedTotal += nBeforeHarvest - this.solver.pool.count;
  }

  /**
   * Đồng bộ occupancy tranh -> solver. Nguồn rebuild MỖI STEP và CỐ Ý không dirty-track: snapshot vốn đã full-copy
   * mỗi step, và rebuild-mỗi-step khử 3 nguồn stale mà dirty-track phải bắt từng cái (convert, smoothRadius đọc
   * LIVE, colScrollPy đổi làm normal quanh mép lộ đổi DÙ không carve). Xem refreshOccupancy trong step.ts.
   */
  private syncOccupancy(): void {
    this.host.model.copyFineOccupancyTo(this.occRaw);
    refreshOccupancy(this.occ, this.occRaw, this.occDilated, this.occNormals);
  }
}

/**
 * Bản KHOAN DUNG của loadRes cho asset TUY CHON: thiếu -> null + 1 dòng warn, KHÔNG reject.
 * Dùng cho art CTA: chưa có art thì ad vẫn phải chạy được, chỉ là nút hiện dạng placeholder.
 */
function loadResOpt<T extends Asset>(path: string, type: new () => T): Promise<T | null> {
  return loadRes(path, type).catch(() => {
    console.warn(`[AdRoot] không nạp được asset tuỳ chọn "${path}" — dùng placeholder.`);
    return null;
  });
}

/**
 * resources.load bọc thành Promise. Thiếu file -> reject kèm đường dẫn, không trả null im lặng.
 *
 * Chữ ký thật của resources.load là union nhiều overload (mảng đường dẫn / bundle / progress) nên TS chọn nhầm
 * overload mảng; ép về đúng 1 dạng ở đây thay vì rải cast ở chỗ gọi.
 */
function loadRes<T extends Asset>(path: string, type: new () => T): Promise<T> {
  type LoadOne = (p: string, t: unknown, cb: (e: Error | null, a: T) => void) => void;
  return new Promise<T>((resolve, reject) => {
    (resources.load as unknown as LoadOne)(path, type, (err, asset) => {
      if (err) reject(new Error(`[AdRoot] không nạp được resources/${path}: ${err.message}`));
      else resolve(asset);
    });
  });
}

/** RGB 24-bit (ColorNames.hexOfColorName) -> Color. -1 = tên không có trong bảng -> magenta để thấy ngay. */
function hexToColor(rgb: number): Color {
  if (rgb < 0) return new Color(255, 0, 255, 255);
  return new Color((rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff, 255);
}
