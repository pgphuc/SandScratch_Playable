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
  Asset, Camera, Color, Component, EventTouch, Input, Material, Node, TextAsset, Vec3,
  input, resources, view, _decorator,
} from 'cc';

import { SandSolver, refreshOccupancy, type SolverParams } from '../solver/step';
import { ConversionFront, type SandEmitRequest, type SandFlowBackend } from '../solver/conversionFront';
import type { MouthBounds } from '../solver/counting';
import type { GrainOccupancyField } from '../solver/occupancy';

import {
  SAND_TUNING, RIG_LAYOUT, PICTURE_PIXEL_WORLD, makeConversionFrontConfig, grainPoolCapacity,
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

/** 4 cột lọ, x world. Trải đều trong dấu chân belt (±(halfBody+rOut)·geomScale ≈ ±9.1). */
const JAR_COLUMN_X = [-6.9, -2.3, 2.3, 6.9];
/** Slot đứng của lọ trong 1 cột (y world). Slot 0 = head. */
const JAR_SLOT_Y = [-2.2, -5.4, -8.6];
const JAR_W = 3.6;
const JAR_H = 2.6;

/** z từng lớp — tranh phải Ở SAU hạt, nếu không pass transparent của tranh vẽ đè lên hạt opaque. */
const Z_PICTURE = -0.05;
const Z_GRAIN = 0;
const Z_JAR = 0.2;
const Z_HINT = 1;
const Z_CTA = 1;

@ccclass('AdRoot')
export class AdRoot extends Component {
  @property({ tooltip: 'Đường trong assets/resources tới level đã bake (SLB1 base64)' })
  levelResPath = 'data/level-0001';

  @property({ tooltip: 'Đường trong assets/resources tới scenario đã chọn' })
  scenarioResPath = 'data/scenario';

  @property({ tooltip: 'Bán kính brush vuốt, theo Ô CƠ CHẾ' })
  brushRadiusCells = 3;

  @property({ tooltip: 'network id của variant đang build' })
  network: string = 'applovin';

  // --- state ---
  private level!: LoadedLevel;
  private map!: PictureMap;
  private tex!: PictureTexture;
  private host!: SandPictureHost;
  private front!: ConversionFront;
  private solver!: SandSolver;
  private rig!: SdfRig;
  private renderer: SandGrainRenderer | null = null;
  private runner: ScenarioRunner | null = null;
  private jarColumns: JarColumns | null = null;
  private gameCamera: Camera | null = null;

  private solverParams!: SolverParams;
  private occ!: GrainOccupancyField;
  private occRaw!: Uint8Array;
  private occDilated!: Uint8Array;
  private occNormals!: Float32Array;

  private ready = false;
  private simAccum = 0;
  private touching = false;
  private strokeArc = 0;
  private readonly lastCell = { x: 0, y: 0 };
  private readonly tmpWorld = new Vec3();

  /** Số hạt bị escape-guard giật về miệng phễu ở step gần nhất — P6 đọc (lớn = tường đang rò). */
  lastRespawned = 0;
  /** Số lệnh emit bị trượt vì pool đầy. > 0 = capacity thấp hơn throttle, hoặc throttle không chạy. */
  emitDroppedCount = 0;

  // ==================================================================== khởi tạo

  onLoad(): void {
    this.setupCamera();
    void this.boot();
  }

  /** Nạp asset (bất đồng bộ) rồi dựng. Cờ `ready` gác `update()` để không chạy sim khi chưa có gì. */
  private async boot(): Promise<void> {
    const [levelTxt, scenarioTxt, grainMat, pictureMat] = await Promise.all([
      loadRes(this.levelResPath, TextAsset),
      loadRes(this.scenarioResPath, TextAsset),
      loadRes('mat/grain', Material),
      loadRes('mat/picture', Material),
    ]);

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
    this.solver = new SandSolver();
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

    // --- conversion front ---
    const backend: SandFlowBackend = {
      acceptSand: (req: SandEmitRequest) => this.emitGrain(req),
    };
    this.front = new ConversionFront(model, this.host, backend, makeConversionFrontConfig());
    this.front.begin();

    this.buildPicture(pictureMat);
    this.buildGrainRenderer(grainMat, cap);
    this.buildJars();
    this.setupScenario(scenarioTxt);
    this.syncOccupancy();
    this.ready = true;
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
   * 14 lọ / 4 cột. Hộp hút của MỌI cột = rãnh đáy vành stadium (xem ghi chú đầu JarColumns.ts về việc belt = 0).
   *
   * ⚠ CHỖ ĐỨNG của lọ (JAR_COLUMN_X / JAR_SLOT_Y / cỡ lọ) KHÔNG có nguồn Unity: nó nằm trên prefab
   * ColorJarController (pointA + columnSpacing + headLocalYZ + jarZStep) mà P1 KHÔNG extract prefab. Số ở đây là
   * ĐẶT TAY cho khung hình dọc của ad — không phải bake từ IR. Muốn khớp bản Unity thì phải extract prefab đó.
   */
  private buildJars(): void {
    const jarRoot = new Node('Jars');
    jarRoot.setParent(this.node);

    const sdf = this.rig.sdf;
    const g = RIG_LAYOUT.geomScale;
    // Rãnh ĐÁY vành: từ mép ngoài vành lên tới tâm vành. x phủ trọn dấu chân belt (kể cả 2 chỏm).
    const mouth: MouthBounds = {
      minX: RIG_LAYOUT.rigPositionX - (sdf.halfBody + sdf.rOut) * g,
      maxX: RIG_LAYOUT.rigPositionX + (sdf.halfBody + sdf.rOut) * g,
      minY: RIG_LAYOUT.rigPositionY - sdf.rOut * g,
      maxY: RIG_LAYOUT.rigPositionY,
    };

    const specs: JarColumnSpec[] = [];
    for (let c = 0; c < JAR_COLUMN_X.length; c++) {
      specs.push({
        jars: [],
        slots: JAR_SLOT_Y.map((y) => new Vec3(JAR_COLUMN_X[c], y, Z_JAR)),
        mouth,
      });
    }

    for (const spec of this.level.jars) {
      if (spec.column < 0 || spec.column >= specs.length) {
        console.warn(`[AdRoot] lọ ở cột ${spec.column} vượt ${specs.length} cột layout — bỏ qua.`);
        continue;
      }
      const node = new Node(`Jar_${spec.column}_${spec.slot}_${spec.colorName}`);
      node.setParent(jarRoot);
      attachQuad(node, JAR_W, JAR_H, hexToColor(hexOfColorName(spec.colorName)), null, false);

      const jar = node.addComponent(ColorJar);
      jar.mouthWidth = JAR_W;
      jar.mouthHeight = JAR_H;
      const cid = colorIdOfJarName(this.level, spec.colorName);
      if (cid < 0) {
        console.warn(`[AdRoot] lọ "${spec.colorName}" không map được sang colorId — lọ này sẽ KHÔNG hút hạt.`);
      }
      jar.setup(spec.colorName, cid, spec.capacity);
      jar.node.active = !spec.hidden;
      jar.onFull(() => this.runner?.notifyJarFull());
      specs[spec.column].jars.push(jar);
    }

    this.jarColumns = new JarColumns(specs);
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
    const h = w * 0.24;

    const node = new Node('CtaButton');
    node.setParent(this.node);
    attachQuad(node, w, h, new Color(255, 176, 32, 255));
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
        // Belt = băng chuyền. ConveyorController bên nguồn là shell no-op (manifest P2 đã chốt chuyển sang
        // bake data-only) -> mọi knob belt để 0 = TẮT, không phải chưa điền.
        beltSpeed: 0, beltCoupling: 0, beltRadialDamping: 0,
        beltTopRelease: 0, beltTopReleaseStart: 0, beltTopTangentDamp: 0,
        beltSpeedUp: 0, beltCouplingUp: 0, beltRadialDampingUp: 0,
        beltTopReleaseUp: 0, beltTopReleaseStartUp: 0, beltTopTangentDampUp: 0,
        enforceOneWay: 0,
        // Cửa trượt chỉ đóng khi belt ĐẦY, mà belt không chạy -> không có nguồn điều khiển. Xem SdfBuild.ts.
        hasDoor: 0, door: empty, gapBeltTopY: 0,
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
        hasSdf: 1, sdf, gapBeltTopY: 0,
        sleepEnabled: SAND_TUNING.grainSleepEnabled ? 1 : 0,
        quadrantSleep: SAND_TUNING.grainSleepQuadrant ? 1 : 0,
        sleepDelaySteps: Math.max(1, Math.round(SAND_TUNING.grainSleepDelaySeconds / SIM_DT)),
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
    if (!ok) this.emitDroppedCount++;
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
    this.host.closeStroke();
  }

  // ==================================================================== nhịp chạy

  update(dt: number): void {
    if (!this.ready) return;

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
    if (this.renderer !== null) this.renderer.syncFromPool(this.solver.pool);
  }

  private simStep(): void {
    this.front.tick(SIM_DT);
    this.syncOccupancy();
    this.lastRespawned = this.solver.step(this.solverParams);
    this.jarColumns?.harvest(this.solver.pool);
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
