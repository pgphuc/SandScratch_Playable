// JAR COUNTING — port phần SOLVER-SIDE của:
//   · Flow/Grain/GrainFlowBackend.cs §"s4 counting / harvest" (HarvestJar / RecomputeRegionCount /
//     CollectBeltColorCounts / DebugCountJar)
//   · Flow/Counting/MaxGrainGate.cs (hysteresis belt-full + đồng hồ thua)
//
// RANH GIỚI đã cắt ở đâu và VÌ SAO:
//  · ObiJarSink.cs (537 LOC) là MonoBehaviour: vùng miệng jar suy từ Transform head jar, cung bay parabol của grain
//    visual, pool GameObject, gizmo. Toàn bộ phần đó là việc của tầng Cocos (P4b) — ở đây chỉ giữ PHÉP ĐO thuần:
//    "hạt nào trong hộp miệng, đúng màu, còn lọt hạn ngạch". Caller truyền hộp + hạn ngạch vào.
//  · `HarvestDirectToJar` / `DirectJarVerdict` / `BlowerPass` KHÔNG port: chúng phục vụ cụm BOOSTER, mà manifest xếp
//    booster vào giỏ `drop`. Port vào đây là chở theo code không có đường gọi.
//  · Bản `HarvestJarLegacy` KHÔNG port: nguồn tự khai 2 bản BIT-IDENTICAL, `HarvestPath` ship = 1 (Hoisted). Port cả
//    hai là chở theo một nhánh A/B đã có kết luận.
//  · MaxGrainGate: bỏ event-bus, bỏ seam thua (GameplayController.CheckLoseCondition) và bỏ 4 handler booster. GIỮ
//    nguyên 1 boolean `paused` — nguồn dùng nó để ĐÓNG BĂNG đồng hồ suốt lượt booster, bỏ hẳn thì ngữ nghĩa timeout
//    đổi âm thầm. Kịch bản ad không có booster nên nó luôn false; seam vẫn còn cho ad sau.

import type { GrainParticlePool } from './pool';
import { xformPoint, v2, type Mat4, type V2 } from './sdfWalls';

/** Hộp miệng jar trong world (AABB XY). Nguồn dùng `Bounds` với size.z = 1 và điểm test có z = center.z nên vế Z
 *  LUÔN đúng -> bỏ được mà không đổi kết quả (chính nguồn đã chứng minh điều này khi hoist). */
export interface MouthBounds {
  minX: number; maxX: number;
  minY: number; maxY: number;
}

/** Dựng AABB từ tâm + cỡ, đúng công thức Bounds của nguồn (center ∓ extents), bao gồm CẢ 2 mép. */
export function mouthFromCenterSize(cx: number, cy: number, sizeX: number, sizeY: number): MouthBounds {
  const ex = sizeX * 0.5, ey = sizeY * 0.5;
  return { minX: cx - ex, maxX: cx + ex, minY: cy - ey, maxY: cy + ey };
}

/** 1 hạt vừa bị hút — tầng trên dùng để bắn grain visual bay vào lọ. */
export interface HarvestedGrain {
  x: number;
  y: number;
  carried: number;   // số pixel THỰC SỰ lấy của hạt này (đã kẹp theo hạn ngạch)
  colorId: number;
}

/**
 * Hút hạt ĐÚNG MÀU trong hộp miệng, tối đa `maxAcceptPixels` pixel (throttle overshoot).
 *
 * ⚠ Hai luật dễ port sai, nguồn ghi rõ và test ở đây gác:
 *  · hạt bị lấy TRỌN -> `removeAt` (swap-remove) và KHÔNG tăng i — phần tử vừa tráo xuống i CHƯA được xét;
 *  · lấy MỘT PHẦN (carried > hạn ngạch còn lại) -> hạt VẪN SỐNG, chỉ trừ carried, rồi i++.
 * ⚠ `take <= 0` là `break` chứ không phải `continue`: hết hạn ngạch thì dừng cả lượt, không quét nốt pool.
 * ⚠ carried được kẹp sàn 1 (`max(1, carried)`) — hạt carried=0 vẫn tính là 1 pixel, đúng nguồn.
 *
 * @param results nếu truyền, được ĐIỀN từng hạt bị hút (caller clear trước). Thứ tự = thứ tự quét pool.
 * @returns tổng PIXEL đã hút.
 */
export function harvestJar(pool: GrainParticlePool, mouth: MouthBounds, colorId: number, maxAcceptPixels: number,
                           results: HarvestedGrain[] | null = null): number {
  if (!pool.isCreated || maxAcceptPixels <= 0) return 0;
  const colorIds = pool.colorIds;
  const positions = pool.positions;
  const carriedArr = pool.carried;
  const { minX, maxX, minY, maxY } = mouth;

  let got = 0;
  let i = 0;
  let count = pool.count;
  while (i < count) {
    if (colorIds[i] !== colorId) { i++; continue; }
    const px = positions[i * 2], py = positions[i * 2 + 1];
    if (px < minX || px > maxX || py < minY || py > maxY) { i++; continue; }
    const carried = Math.max(1, carriedArr[i]);
    const take = Math.min(carried, maxAcceptPixels - got);
    if (take <= 0) break;   // jar hết chỗ lượt này -> dừng hẳn
    results?.push({ x: px, y: py, carried: take, colorId });
    got += take;
    if (take >= carried) {
      pool.removeAt(i);     // KHÔNG i++ — phần tử tráo xuống i chưa xét
      count--;              // swap-remove -> count giảm ĐÚNG 1
    } else {
      carriedArr[i] = carried - take;
      i++;                  // partial: hạt còn sống, chạy tiếp
    }
  }
  return got;
}

/** Kết quả debugCountJar — object tái dùng, không cấp phát trong vòng. */
export interface JarScanCounts { total: number; matching: number; }

/**
 * (Debug) Đếm hạt sống trong hộp miệng: `total` mọi màu + `matching` đúng colorId. KHÔNG kill.
 * Đây là công cụ soi "vì sao hạt không vào jar": total=0 -> hộp lệch chỗ · total>0 matching=0 -> lệch colorId
 * · matching>0 mà hút=0 -> overshoot (carried > hạn ngạch).
 */
export function debugCountJar(pool: GrainParticlePool, mouth: MouthBounds, colorId: number,
                              out: JarScanCounts): JarScanCounts {
  out.total = 0;
  out.matching = 0;
  if (!pool.isCreated) return out;
  const n = pool.count;
  const positions = pool.positions;
  const colorIds = pool.colorIds;
  for (let i = 0; i < n; i++) {
    const px = positions[i * 2], py = positions[i * 2 + 1];
    if (px < mouth.minX || px > mouth.maxX || py < mouth.minY || py > mouth.maxY) continue;
    out.total++;
    if (colorIds[i] === colorId) out.matching++;
  }
  return out;
}

// ==================================================================== region count (belt) / fill ratio

/** Phần SDF mà phép đếm vùng belt cần — tách hẹp để test không phải dựng cả GrainSdfColliders. */
export interface BeltRegion {
  worldToLocal: Mat4;
  beltHalfX: number;
  beltTopY: number;
}

const _lp: V2 = v2();

/** Hạt ở world (x,y) có nằm trong AABB vùng belt (LOCAL) không. */
export function isInBeltLocal(region: BeltRegion, x: number, y: number): boolean {
  xformPoint(region.worldToLocal, x, y, _lp);
  return Math.abs(_lp.x) <= region.beltHalfX && Math.abs(_lp.y) <= region.beltTopY;
}

/**
 * Đếm SỐ HẠT grain sống trong vùng belt.
 * ⚠ ĐƠN VỊ = SỐ HẠT, KHÔNG phải Σ carried/pixel — sức chứa băng chuyền tính theo grain (nguồn chốt 2026-07-14).
 * `region = null` (level không có SDF) -> đếm CẢ pool, đúng fallback của nguồn.
 */
export function countBeltGrains(pool: GrainParticlePool, region: BeltRegion | null): number {
  if (!pool.isCreated) return 0;
  if (region === null) return pool.count;
  const n = pool.count;
  const positions = pool.positions;
  let c = 0;
  for (let i = 0; i < n; i++) {
    if (isInBeltLocal(region, positions[i * 2], positions[i * 2 + 1])) c++;
  }
  return c;
}

/**
 * Độ đầy vùng belt = số hạt belt / maxGrains, kẹp [0,1]. Nguồn cho hysteresis belt-full.
 * ⚠ Denominator là `maxGrains` (sức chứa belt cấu hình), KHÔNG phải capacity pool.
 */
export function fillRatio(beltGrainCount: number, maxGrains: number): number {
  const r = beltGrainCount / Math.max(1, maxGrains);
  return r < 0 ? 0 : r > 1 ? 1 : r;
}

/**
 * Đếm PIXEL (Σ carried) theo MÀU của hạt ĐANG Ở BELT -> ghi vào `counts` (colorId -> pixel). Caller clear trước.
 * `region = null` -> đếm cả pool (fallback giống countBeltGrains).
 * ⚠ Bỏ qua colorId <= 0 (không màu), và kẹp sàn carried = 1 — đúng nguồn.
 */
export function collectBeltColorCounts(pool: GrainParticlePool, region: BeltRegion | null,
                                       counts: Map<number, number>): void {
  if (!pool.isCreated) return;
  const n = pool.count;
  const positions = pool.positions;
  const colorIds = pool.colorIds;
  const carried = pool.carried;
  for (let i = 0; i < n; i++) {
    if (region !== null && !isInBeltLocal(region, positions[i * 2], positions[i * 2 + 1])) continue;
    const colorId = colorIds[i];
    if (colorId <= 0) continue;
    const c = Math.max(1, carried[i]);
    counts.set(colorId, (counts.get(colorId) ?? 0) + c);
  }
}

// ==================================================================== belt-full gate (hysteresis + đồng hồ thua)

export interface BeltFullGateConfig {
  /** VÀO belt-full khi fill >= entry. */
  entry: number;
  /** RA belt-full khi fill <= exit. entry > exit để chống bật/tắt phập phù. */
  exit: number;
  /** Kẹt belt-full quá số giây này -> báo THUA (1 lần mỗi đợt). */
  timeoutSeconds: number;
  /** Trước đó, quá số giây này -> báo CẢNH BÁO sắp thua (1 lần mỗi đợt). */
  preLostSeconds: number;
}

/**
 * Hysteresis theo ĐỘ ĐẦY vùng belt, điều khiển đồng thời 2 thứ:
 *   (1) BELT-FULL -> `onBeltFullChanged(true)`: backend đóng nắp entry gate + boost tốc belt; tụt -> mở nắp + về nền.
 *   (2) LOSE-TIMER -> kẹt belt-full quá `timeoutSeconds` mà chưa tụt dưới exit -> `onLose()` ĐÚNG 1 LẦN mỗi ĐỢT.
 *
 * ⚠ Guard 1-lần được NHẢ ở cạnh RA của hysteresis, không phải lúc build level. Nguồn ghi rõ đây là bug đã sửa: không
 * nhả ở cạnh RA thì level thua 1 lần xong là không bao giờ thua lại được nữa (dọn belt không rebuild level).
 * ⚠ Đồng hồ là TÍCH LUỸ (cộng dt), không phải mốc thời điểm — mốc thời điểm không pause được.
 *
 * ⚠ KỊCH BẢN AD: đây là đường THUA (hết chỗ). Kịch bản KB1/KB2 đều force-win + fallback timeout->CTA, nên tầng trên
 * nhiều khả năng KHÔNG nối `onLose`. Gate vẫn cần cho vế (1): đóng nắp + boost belt là hành vi nhìn thấy được.
 */
export class BeltFullGate {
  private active = false;
  private beltFullActive = false;
  private beltFullValue = false;
  private lostRaised = false;
  private preLostRaised = false;
  private elapsed = 0;

  /** Đóng băng đồng hồ thua (nguồn: người chơi đang dùng booster). Booster đã drop -> luôn false ở ad này. */
  paused = false;

  onBeltFullChanged: ((full: boolean) => void) | null = null;
  onPreLost: (() => void) | null = null;
  onPreLostEnd: (() => void) | null = null;
  onLose: (() => void) | null = null;

  // Field + gán tường minh, KHÔNG dùng parameter property: type-stripping của Node không hỗ trợ.
  private readonly config: BeltFullGateConfig;

  constructor(config: BeltFullGateConfig) {
    this.config = config;
  }

  /** Belt gần đầy (đã đóng nắp + boost tốc)? */
  get beltFull(): boolean { return this.beltFullValue; }
  /** Đang ở belt-full (đồng hồ thua đang chạy)? */
  get isBeltFullActive(): boolean { return this.beltFullActive; }
  /** Đồng hồ thua đang chạy (belt-full + đợt này chưa báo thua)? */
  get isLoseCountdownActive(): boolean { return this.active && this.beltFullActive && !this.lostRaised; }

  /** Giây CÒN LẠI trước khi thua. 0 khi không ở belt-full. Nguồn cho UI đếm ngược. */
  get remainingLoseSeconds(): number {
    return this.beltFullActive ? Math.max(0, this.config.timeoutSeconds - this.elapsed) : 0;
  }

  /** Bật gate + reset trạng thái. Reset là SILENT: KHÔNG bắn event lúc bind (mặc định coi belt chưa đầy). */
  begin(): void {
    this.active = true;
    this.beltFullActive = false;
    this.beltFullValue = false;
    this.lostRaised = false;
    this.preLostRaised = false;
    this.elapsed = 0;
    this.paused = false;
  }

  /** Ngừng gate (teardown). Không bắn gì thêm. */
  end(): void {
    this.active = false;
    this.beltFullActive = false;
    this.beltFullValue = false;
  }

  /** 1 nhịp. `fill` = fillRatio hiện tại, `dt` = giây trôi qua. */
  tick(fill: number, dt: number): void {
    if (!this.active) return;
    this.updateHysteresis(fill);
    this.checkTimeout(dt);
  }

  private updateHysteresis(fill: number): void {
    const was = this.beltFullActive;
    if (!this.beltFullActive && fill >= this.config.entry) this.beltFullActive = true;
    else if (this.beltFullActive && fill <= this.config.exit) this.beltFullActive = false;

    if (this.beltFullActive && !was) {
      this.elapsed = 0;               // VÀO: bắt đầu đếm giờ thua
      this.setBeltFull(true);
    } else if (!this.beltFullActive && was) {
      // RA = hết đợt -> mở lại quyền THUA cho đợt sau (xem ⚠ ở doc class).
      this.lostRaised = false;
      if (this.preLostRaised) {       // thoát hiểm: tắt cảnh báo (chỉ báo nếu đợt này ĐÃ bật -> không event mồ côi)
        this.preLostRaised = false;
        this.onPreLostEnd?.();
      }
      this.setBeltFull(false);
    }
  }

  private checkTimeout(dt: number): void {
    if (!this.beltFullActive || this.lostRaised) return;
    if (this.paused) return;          // đóng băng đồng hồ (seam booster)
    this.elapsed += dt;

    if (!this.preLostRaised && this.elapsed >= this.config.preLostSeconds) {
      this.preLostRaised = true;
      this.onPreLost?.();
    }
    if (this.elapsed < this.config.timeoutSeconds) return;
    this.lostRaised = true;
    this.onLose?.();
  }

  private setBeltFull(full: boolean): void {
    if (this.beltFullValue === full) return;
    this.beltFullValue = full;
    this.onBeltFullChanged?.(full);
  }
}
