// BOOTSTRAP của ad: nối level -> carve model -> ConversionFront -> SandSolver -> renderer -> lọ -> ScenarioRunner.
// Đây là file DUY NHẤT biết thứ tự khởi tạo và nhịp chạy; các file khác không tự gọi nhau.
//
// ============ NHỊP CHẠY (docs/cocos-conventions.md, mục perf webview) ============
// Sim FIXED-STEP 30Hz tách khỏi render 60fps, cap catch-up = grainMaxSolverStepsPerFrame (= 2).
// Vì sao tách: solver là PBD — dt đổi thì kết quả đổi. Chạy theo dt của frame là để vật lý phụ thuộc máy người xem,
// và ad chạy trên webview bị throttle nên dt nhảy rất bạo. Cap catch-up chống "spiral of death" khi 1 frame kẹt lâu.
// Renderer đồng bộ 1 lần/FRAME (không phải mỗi step): 2 step trong 1 frame ghi mesh 2 lần cho cùng 1 hình.
//
// ============ ⚠ TRẠNG THÁI: SIM CHƯA CÓ TƯỜNG (hasSdf = 0) ============
// `GrainSdfColliders.cs` (1137 dòng) bên Unity chứa BUILDER dựng `segments` phễu/chute/khung + wall-grid. P4a chỉ
// port phần CLAMP (`solver/sdfWalls.ts`), KHÔNG port builder. Không có segments thì:
//   · hạt KHÔNG bị phễu/khung giữ -> rơi tự do khỏi vùng tranh rồi bị killBelowY loại;
//   · `escapeGuard` không chạy (nó cần hasSdf=1), nên không có tái tuần hoàn.
// Chạy ở chế độ này VẪN xác thực được đường ống: swipe -> carve -> convert -> emit -> solver step -> mesh gộp ->
// hộp miệng lọ. Đó là lý do nó được bật thay vì chặn cứng. Lọ chỉ nhận hạt nếu hộp miệng nằm trên đường rơi.
// KHÔNG dùng số đo từ chế độ này làm parity P6.

import { Component, Node, TextAsset, EventTouch, Input, input, Camera, Vec3, _decorator } from 'cc';

import { SandSolver, refreshOccupancy, type SolverParams } from '../solver/step';
import { ConversionFront, type SandEmitRequest, type SandFlowBackend } from '../solver/conversionFront';
import { mat4Identity, type GrainSdfField, type GrainWallGrid } from '../solver/sdfWalls';
import type { GrainOccupancyField } from '../solver/occupancy';

import { SAND_TUNING, makeConversionFrontConfig, grainPoolCapacity } from './SandTuning';
import { loadLevel, buildCarveModel, colorIdOfJarName, type LoadedLevel } from './LevelLoad';
import { PictureMap } from './PictureMap';
import { PictureTexture } from './PictureTexture';
import { SandPictureHost } from './SandPictureHost';
import { SandGrainRenderer } from './SandGrainRenderer';
import { ColorJar } from './ColorJar';
import { ScenarioRunner, type ScenarioJson } from './ScenarioRunner';
import type { NetworkId } from './NetworkAdapter';

const { ccclass, property } = _decorator;

/** Sim 30Hz. Số này là MỘT PHẦN CỦA VẬT LÝ (PBD), không phải knob perf — đổi nó là đổi hành vi cát. */
const SIM_DT = 1 / 30;

@ccclass('AdRoot')
export class AdRoot extends Component {
  @property({ type: TextAsset, tooltip: 'assets/data/levels/level-0001.txt (base64 SLB1)' })
  levelAsset: TextAsset | null = null;

  @property({ type: TextAsset, tooltip: 'scenario đã được packer inline (1 file duy nhất)' })
  scenarioAsset: TextAsset | null = null;

  @property({ type: Camera, tooltip: 'Camera để đổi toạ độ chạm -> world' })
  gameCamera: Camera | null = null;

  @property({ type: Node, tooltip: 'Node mang SandGrainRenderer' })
  grainRendererNode: Node | null = null;

  @property({ type: Node, tooltip: 'Node cha của các lọ (mỗi con có ColorJar)' })
  jarRoot: Node | null = null;

  @property({ tooltip: 'Bề rộng world mà tranh phải fit vào' })
  pictureFrameWidth = 8;

  @property({ tooltip: 'Bề cao world mà tranh phải fit vào' })
  pictureFrameHeight = 8;

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
  private renderer: SandGrainRenderer | null = null;
  private runner: ScenarioRunner | null = null;
  private readonly jars: ColorJar[] = [];

  private solverParams!: SolverParams;
  private occ!: GrainOccupancyField;
  private occRaw!: Uint8Array;
  private occDilated!: Uint8Array;
  private occNormals!: Float32Array;

  private simAccum = 0;
  private touching = false;
  private strokeArc = 0;
  private readonly lastCell = { x: 0, y: 0 };
  private readonly tmpWorld = new Vec3();

  /** Số hạt bị escape-guard giật về miệng phễu ở step gần nhất — P6 đọc (lớn = tường đang rò). */
  lastRespawned = 0;

  // ==================================================================== khởi tạo

  onLoad(): void {
    if (this.levelAsset === null) throw new Error('[AdRoot] thiếu levelAsset.');
    this.level = loadLevel(this.levelAsset.text);

    // --- tranh: map + texture ---
    this.map = PictureMap.fitCentered(
      this.level.mechWidth, this.level.mechHeight,
      this.pictureFrameWidth, this.pictureFrameHeight,
      this.node.worldPosition.x, this.node.worldPosition.y,
      this.level.viewportRows,
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

    // --- renderer ---
    if (this.grainRendererNode !== null) {
      this.renderer = this.grainRendererNode.getComponent(SandGrainRenderer);
      this.renderer?.init(cap, this.level.palette);
    }

    this.setupJars();
    this.setupScenario();
    this.syncOccupancy(true);
  }

  private makeSolverParams(): SolverParams {
    // ⚠ SDF RỖNG — xem khối cảnh báo đầu file. hasSdf/hasDoor = 0 nên mọi field hình học dưới đây KHÔNG bị đọc;
    // để 0 thay vì số bịa, và `segments` dài 0 để nếu ai bật hasSdf=1 mà chưa port builder thì hạt bay tự do
    // ngay lập tức (thấy sai liền) chứ không bị tường ảo giữ.
    const sdf: GrainSdfField = {
      worldToLocal: mat4Identity(), localToWorld: mat4Identity(),
      halfBody: 0, rIn: 0, rOut: 0, gapHalf: 0,
      edgeRadius: SAND_TUNING.edgeRadius,
      radiusLocal: SAND_TUNING.grainParticleRadius,
      doorThr: 0, beltHalfX: 0, beltTopY: 0, segmentCount: 0,
      respawnLocalX: 0, respawnLocalY: 0, chuteInHalf: 0,
      wallX: 0, chuteTopY: 0, funnelTopY: 0, wallTop: 0, hasTopWall: 0, bboxHalfX: 0,
    };
    const wallGrid: GrainWallGrid = {
      originX: 0, originY: 0, cellSize: 1, nx: 1, ny: 1, roam: 0, enabled: 0, maskValid: 0,
    };
    const empty = new Float32Array(0);
    const emptyI = new Int32Array(0);
    const emptyU = new Uint32Array(0);

    // frictionKeep: nguồn quy đổi SẴN = pow(1 - f, 1/substeps) vì clamp tường chạy MỖI substep; truyền (1-f)
    // thẳng vào sẽ ma sát mạnh gấp `substeps` lần.
    const frictionKeep = Math.pow(1 - SAND_TUNING.grainWallFriction, 1 / SAND_TUNING.grainSubsteps);

    return {
      iterations: SAND_TUNING.grainContactIterations,
      subdiv: SAND_TUNING.grainNeighborGridEnabled ? SAND_TUNING.grainNeighborGridSubdiv : 1,
      cellSize: 2 * SAND_TUNING.grainParticleRadius,
      hasSdf: 0,
      killBelowY: SAND_TUNING.grainDespawnY,

      integrate: {
        gravityX: 0, gravityY: SAND_TUNING.grainGravityY,
        dt: SIM_DT, substeps: SAND_TUNING.grainSubsteps,
        hasSdf: 0, sdf, segments: empty,
        restitution: SAND_TUNING.grainWallRestitution,
        frictionKeep,
        // Belt = băng chuyền. ConveyorController bên nguồn là shell no-op (manifest P2 đã chốt chuyển sang
        // bake data-only) -> mọi knob belt để 0 = TẮT, không phải chưa điền.
        beltSpeed: 0, beltCoupling: 0, beltRadialDamping: 0,
        beltTopRelease: 0, beltTopReleaseStart: 0, beltTopTangentDamp: 0,
        beltSpeedUp: 0, beltCouplingUp: 0, beltRadialDampingUp: 0,
        beltTopReleaseUp: 0, beltTopReleaseStartUp: 0, beltTopTangentDampUp: 0,
        enforceOneWay: 0,
        hasDoor: 0, door: empty, gapBeltTopY: 0,
        hasOcc: 1, occ: this.occ,
        occSnapshot: this.occDilated, occSnapshotRaw: this.occRaw, occNormals: this.occNormals,
        occSlip: SAND_TUNING.grainOccupancySlip,
        wgiEnabled: 0, wallGrid, wallCellMask: emptyU,
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
        hasSdf: 0, sdf, segments: empty,
        hasDoor: 0, door: empty,
        wallCompliance: 0,
        wallGrid, wallCellStart: emptyI, wallCellItems: emptyI,
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
        hasSdf: 0, sdf, gapBeltTopY: 0,
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

  /** Số lệnh emit bị trượt vì pool đầy. > 0 = capacity thấp hơn throttle, hoặc throttle không chạy. */
  emitDroppedCount = 0;

  private setupJars(): void {
    if (this.jarRoot === null) return;
    const specs = this.level.jars;
    const nodes = this.jarRoot.children;
    // Ghép theo THỨ TỰ: node thứ k <-> spec thứ k. Lệch số lượng = scene chưa khớp level -> báo số, không đoán.
    if (nodes.length !== specs.length) {
      console.warn(`[AdRoot] jarRoot có ${nodes.length} node nhưng level có ${specs.length} lọ — ` +
                   `ghép theo min và bỏ phần lẻ.`);
    }
    const n = Math.min(nodes.length, specs.length);
    for (let i = 0; i < n; i++) {
      const jar = nodes[i].getComponent(ColorJar);
      if (jar === null) continue;
      const s = specs[i];
      const cid = colorIdOfJarName(this.level, s.colorName);
      if (cid < 0) {
        console.warn(`[AdRoot] lọ "${s.colorName}" không map được sang colorId — lọ này sẽ KHÔNG hút hạt.`);
      }
      jar.setup(s.colorName, cid, s.capacity);
      jar.node.active = !s.hidden;
      jar.onFull(() => this.runner?.notifyJarFull());
      this.jars.push(jar);
    }
  }

  private setupScenario(): void {
    this.runner = this.getComponent(ScenarioRunner);
    if (this.runner === null || this.scenarioAsset === null) return;
    const json = JSON.parse(this.scenarioAsset.text) as ScenarioJson;
    this.runner.init(json, this.network as NetworkId);
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

  /** Chạm -> ô tranh. null nếu không có camera (không đoán toạ độ). */
  private cellOfTouch(e: EventTouch): { x: number; y: number } | null {
    if (this.gameCamera === null) return null;
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

    // Render + hình tranh: 1 lần/FRAME.
    this.tex.update(dt);
    if (this.renderer !== null) this.renderer.syncFromPool(this.solver.pool);
  }

  private simStep(): void {
    this.front.tick(SIM_DT);
    this.syncOccupancy(false);
    this.lastRespawned = this.solver.step(this.solverParams);
    for (let i = 0; i < this.jars.length; i++) this.jars[i].harvest(this.solver.pool);
  }

  /**
   * Đồng bộ occupancy tranh -> solver. Nguồn rebuild MỖI STEP và CỐ Ý không dirty-track: snapshot vốn đã full-copy
   * mỗi step, và rebuild-mỗi-step khử 3 nguồn stale mà dirty-track phải bắt từng cái (convert, smoothRadius đọc
   * LIVE, colScrollPy đổi làm normal quanh mép lộ đổi DÙ không carve). Xem refreshOccupancy trong step.ts.
   */
  private syncOccupancy(_first: boolean): void {
    this.host.model.copyFineOccupancyTo(this.occRaw);
    refreshOccupancy(this.occ, this.occRaw, this.occDilated, this.occNormals);
  }
}
