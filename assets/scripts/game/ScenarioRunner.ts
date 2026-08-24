// Runtime kịch bản: đọc ĐÚNG 1 file scenario mà packer đã nhồi vào build và điều khiển hand-hint / goal /
// fallback / CTA. Runtime KHÔNG biết các kịch bản khác tồn tại (buildContract trong scenarios/index.json).
//
// MÔ HÌNH CTA (sharedContract, chốt 2026-08-22) — cả KB1 và KB2 dùng CHUNG, không phân nhánh theo id:
//   đạt goal (HOẶC fallback 30s) -> CTA ARMED -> cú CHẠM KẾ TIẾP ở BẤT KỲ đâu mở store.
//   KHÔNG có endcard chắn màn; gameplay chạy tiếp tới lúc đó. Nút CTA nổi chỉ là TÍN HIỆU, không phải hitbox.
//
// VÌ SAO fallback là BẮT BUỘC: không đạt goal trong 30s mà không có fallback thì ad KẸT VĨNH VIỄN — không bao giờ
// armed, người xem không có đường ra. Vì vậy thiếu `fallback` ở đây là THROW lúc init, không phải cảnh báo.

import { Component, EventTouch, Input, input, Node, _decorator } from 'cc';
import { NetworkAdapter, type NetworkId } from './NetworkAdapter';

const { ccclass, property } = _decorator;

// ---- hình dạng scenario.json (chỉ field runtime thật đọc) ----

export interface ScenarioHandHint {
  gesture: string;
  loop: boolean;
  hideOnFirstInput: boolean;
  reshowAfterIdleSec: number;
  /** Đường vuốt theo TỈ LỆ màn hình [0..1], gốc dưới-trái. */
  path: [number, number][];
}

export interface ScenarioJson {
  id: string;
  meta: { durationSec: number };
  input: { idleTimeoutSec: number; handHint: ScenarioHandHint };
  goal: { type: 'jars_cleared' | 'swipe_count'; count: number };
  fallback: { type: 'elapsed'; afterSec: number };
  cta: {
    mode: string;
    trigger: string;
    storeUrl: string;
    visualCue?: {
      enabled: boolean;
      marginBottomPct?: number;
      widthPct?: number;
      pulse?: { cycles: number; scaleFrom: number; scaleTo: number; periodSec: number; thenHold: boolean };
    };
  };
}

/** Chữ trên nút CTA — CHỐT 2026-08-24 (user). Art in sẵn chữ vào PNG thì hằng số này chỉ còn là fallback placeholder. */
export const CTA_TEXT = 'PLAY NOW';

export type ScenarioPhase = 'running' | 'armed' | 'opened';

@ccclass('ScenarioRunner')
export class ScenarioRunner extends Component {
  @property({ type: Node, tooltip: 'Nút CTA nổi (tín hiệu). Ẩn cho tới khi armed.' })
  ctaNode: Node | null = null;

  @property({ type: Node, tooltip: 'Vệt bàn tay hint. Ẩn/hiện theo beats.' })
  handHintNode: Node | null = null;

  private scenario!: ScenarioJson;
  /** AdRoot nạp scenario BẤT ĐỒNG BỘ (resources.load) nên component sống trước khi có data — update() phải câm tới lúc đó. */
  private started = false;
  private adapter!: NetworkAdapter;

  private phaseValue: ScenarioPhase = 'running';
  private elapsed = 0;
  private idleFor = 0;
  private sawFirstInput = false;

  private jarsCleared = 0;
  private swipeCount = 0;

  // pulse của nút CTA
  private pulseElapsed = 0;
  private pulseDone = false;

  get phase(): ScenarioPhase { return this.phaseValue; }
  get isArmed(): boolean { return this.phaseValue === 'armed'; }
  get secondsElapsed(): number { return this.elapsed; }

  /**
   * @param json nội dung scenario đã inline (packer nhồi 1 file duy nhất).
   * @param network id variant đang build.
   */
  init(json: ScenarioJson, network: NetworkId): void {
    if (json.fallback === undefined || json.fallback === null || !(json.fallback.afterSec > 0)) {
      throw new Error(`[ScenarioRunner] scenario "${json.id}" thiếu fallback hợp lệ — ad sẽ KẸT VĨNH VIỄN ` +
                      `(không bao giờ arm CTA). Packer phải fail trước khi tới đây.`);
    }
    this.scenario = json;
    this.started = true;
    this.adapter = new NetworkAdapter(network, json.cta.storeUrl ?? '');

    this.phaseValue = 'running';
    this.elapsed = 0;
    this.idleFor = 0;
    this.sawFirstInput = false;
    this.jarsCleared = 0;
    this.swipeCount = 0;
    this.pulseElapsed = 0;
    this.pulseDone = false;

    if (this.ctaNode !== null) this.ctaNode.active = false;
    this.showHandHint(true);   // beat "hint-in" at 0.6s — xem note trong update()
  }

  onEnable(): void {
    // Bắt chạm ở tầng GLOBAL: CTA armed thì chạm CHỖ NÀO cũng mở store, không cần trúng nút.
    input.on(Input.EventType.TOUCH_START, this.onTouchStart, this);
    input.on(Input.EventType.TOUCH_END, this.onTouchEnd, this);
  }

  onDisable(): void {
    input.off(Input.EventType.TOUCH_START, this.onTouchStart, this);
    input.off(Input.EventType.TOUCH_END, this.onTouchEnd, this);
  }

  // ==================================================================== sự kiện gameplay đẩy vào

  /** ColorJar.onFull gọi. Chỉ đếm khi goal là jars_cleared. */
  notifyJarFull(): void {
    this.jarsCleared++;
    this.checkGoal();
  }

  /**
   * Nhấc ngón = 1 swipe. Ngữ nghĩa CHỐT 2026-08-22: mỗi pointer-up tính 1, KỂ CẢ tap rời, KHÔNG có minDistance.
   * Gọi từ onTouchEnd nên tap cũng vào — đúng chủ ý, không phải bug.
   */
  private countSwipe(): void {
    this.swipeCount++;
    this.checkGoal();
  }

  private checkGoal(): void {
    if (this.phaseValue !== 'running') return;
    const g = this.scenario.goal;
    const reached = g.type === 'jars_cleared' ? this.jarsCleared >= g.count
                  : g.type === 'swipe_count' ? this.swipeCount >= g.count
                  : false;
    if (reached) this.armCta('goal');
  }

  // ==================================================================== vòng thời gian

  update(dt: number): void {
    if (!this.started) return;
    this.elapsed += dt;

    // beat "hint-in" at: 0.6s. Trước mốc đó hint ẩn. Sau mốc, hint theo luật idle/first-input.
    // Gộp vào đây thay vì scheduleOnce để replay không phải huỷ timer rời.
    if (this.elapsed < 0.6 && !this.sawFirstInput) this.showHandHint(false);
    else if (!this.sawFirstInput) this.showHandHint(true);

    if (this.sawFirstInput) {
      this.idleFor += dt;
      const back = this.scenario.input.handHint.reshowAfterIdleSec;
      if (back > 0 && this.idleFor >= back) this.showHandHint(true);
    }

    if (this.phaseValue === 'running' && this.elapsed >= this.scenario.fallback.afterSec) {
      this.armCta('fallback');
    }

    if (this.phaseValue === 'armed' && !this.pulseDone) this.tickPulse(dt);
  }

  /** pulse_scale: N nhịp rồi GIỮ (thenHold) — không đập mãi, đập mãi thì mắt bỏ qua nút. */
  private tickPulse(dt: number): void {
    const cue = this.scenario.cta.visualCue;
    const p = cue?.pulse;
    if (this.ctaNode === null || p === undefined || !(p.periodSec > 0)) { this.pulseDone = true; return; }

    this.pulseElapsed += dt;
    const total = p.periodSec * p.cycles;
    if (this.pulseElapsed >= total) {
      this.ctaNode.setScale(p.thenHold ? p.scaleTo : p.scaleFrom, p.thenHold ? p.scaleTo : p.scaleFrom, 1);
      this.pulseDone = true;
      return;
    }
    // Tam giác 0->1->0 trong 1 chu kỳ (không dùng sin: rẻ hơn và nhịp "đập" rõ hơn trên webview 30fps).
    const t = (this.pulseElapsed % p.periodSec) / p.periodSec;
    const k = t < 0.5 ? t * 2 : (1 - t) * 2;
    const s = p.scaleFrom + (p.scaleTo - p.scaleFrom) * k;
    this.ctaNode.setScale(s, s, 1);
  }

  // ==================================================================== input

  private onTouchStart(_e: EventTouch): void {
    if (!this.started) return;
    if (this.phaseValue === 'armed') {
      this.phaseValue = 'opened';
      this.adapter.open();
      return;
    }
    if (!this.sawFirstInput) {
      this.sawFirstInput = true;
      this.showHandHint(false);   // beat "hint-off" when first_swipe
    }
    this.idleFor = 0;
    this.showHandHint(false);
  }

  private onTouchEnd(_e: EventTouch): void {
    if (!this.started) return;
    if (this.phaseValue === 'opened') return;
    this.idleFor = 0;
    this.countSwipe();
  }

  // ==================================================================== CTA

  private armCta(_reason: 'goal' | 'fallback'): void {
    if (this.phaseValue !== 'running') return;
    this.phaseValue = 'armed';
    this.pulseElapsed = 0;
    this.pulseDone = false;
    const cue = this.scenario.cta.visualCue;
    if (this.ctaNode !== null && cue?.enabled !== false) this.ctaNode.active = true;
  }

  private showHandHint(on: boolean): void {
    if (this.handHintNode === null) return;
    if (this.handHintNode.active !== on) this.handHintNode.active = on;
  }
}
