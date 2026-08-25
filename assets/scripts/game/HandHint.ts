// Vệt hand-hint: chấm chạy dọc đường vuốt của scenario, lặp.
//
// `ScenarioRunner` chỉ BẬT/TẮT node hint (nó là bộ điều phối beat, không phải bộ vẽ). File này lo phần chuyển
// động, nên đổi kiểu hint (chấm -> bàn tay PNG -> vệt trail) không phải đụng vào ScenarioRunner.
//
// Đường đi đến từ `scenario.input.handHint.path`, đơn vị là TỈ LỆ MÀN HÌNH [0..1] gốc dưới-trái. Việc đổi sang
// world do AdRoot làm (nó là chỗ duy nhất biết camera ortho rộng bao nhiêu) rồi bơm xuống đây.

import { Component, Vec3, _decorator } from 'cc';

const { ccclass } = _decorator;

/**
 * 1 vòng vuốt + quãng nghỉ trước khi lặp — MẶC ĐỊNH, ghi đè bằng `scenario.input.handHint.strokeSec/restSec`.
 * TỐC ĐỘ tính theo GIÂY/LƯỢT chứ không phải world/giây: đường vuốt đo theo tỉ lệ màn hình, nên đổi độ dài
 * đường mà vẫn giữ nguyên nhịp vuốt trên mọi tỉ lệ màn.
 */
export const HAND_STROKE_SEC = 1.1;
export const HAND_REST_SEC = 0.45;

@ccclass('HandHint')
export class HandHint extends Component {
  private path: Vec3[] = [];
  private segLen: number[] = [];
  private total = 0;
  private t = 0;
  private strokeSec = HAND_STROKE_SEC;
  private restSec = HAND_REST_SEC;

  /**
   * Nhịp vuốt. `strokeSec` <= 0 bị bỏ qua (giữ mặc định) — chia cho 0 thì hint đứng chết ở điểm đầu và
   * không ai đoán ra vì sao.
   */
  setTiming(strokeSec: number, restSec: number): void {
    if (strokeSec > 0) this.strokeSec = strokeSec;
    if (restSec >= 0) this.restSec = restSec;
  }

  /** `points` = đường vuốt ĐÃ đổi sang world. < 2 điểm -> hint đứng yên tại điểm đầu. */
  setPath(points: Vec3[]): void {
    this.path = points;
    this.segLen = [];
    this.total = 0;
    for (let i = 0; i + 1 < points.length; i++) {
      const d = Vec3.distance(points[i], points[i + 1]);
      this.segLen.push(d);
      this.total += d;
    }
    this.t = 0;
    if (points.length > 0) this.node.setWorldPosition(points[0]);
  }

  onEnable(): void { this.t = 0; }

  update(dt: number): void {
    if (this.path.length < 2 || this.total <= 0) return;
    this.t += dt;
    const cycle = this.strokeSec + this.restSec;
    const local = this.t % cycle;
    // Trong quãng nghỉ thì đứng ở điểm cuối rồi nhảy về đầu — nhảy giữa vòng làm mắt bám nhầm hướng vuốt.
    const k = local >= this.strokeSec ? 1 : local / this.strokeSec;

    let want = k * this.total;
    for (let i = 0; i < this.segLen.length; i++) {
      if (want <= this.segLen[i] || i === this.segLen.length - 1) {
        const f = this.segLen[i] > 0 ? Math.min(1, want / this.segLen[i]) : 0;
        const a = this.path[i], b = this.path[i + 1];
        this.node.setWorldPosition(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, a.z + (b.z - a.z) * f);
        return;
      }
      want -= this.segLen[i];
    }
  }
}
