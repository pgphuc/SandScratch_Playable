// Hạt VISUAL bay từ chỗ bị hút vào lọ — port phần VFX mà JarColumns.ts:21 ghi là "KHÔNG port".
//
// VÌ SAO CẦN: hộp hút nằm ở RÃNH ĐÁY BELT chứ không ở chỗ đứng của lọ (ObiJarSink, autoMouthOffset (0,5,0)).
// Không có cung bay thì hạt chạm rãnh đáy là BIẾN MẤT tại chỗ — đo 2026-08-24 xác nhận phép cộng
// emit = lọ hút + sống khớp CHÍNH XÁC, tức không mất hạt nào; mắt thấy "bốc hơi" thuần tuý vì thiếu lớp này.
// Nguồn Unity: JarGrainVisual + parabol SandJump. Hạt là MESH CẦU unlit (không phải quad) — đúng nhánh
// "MeshRenderer sphere" mà JarGrainVisual.cs mô tả cho prefab, và comment nguồn dặn material phải UNLIT để màu
// phẳng như cát. Đổi từ quad sang cầu 2026-08-25 theo yêu cầu user ("hạt vào lọ là prefab 3D").
//
// KHÔNG ĐỘNG VÀO SỐ ĐẾM: lớp này chỉ đọc `ColorJar.lastHarvested` (đã có sẵn, ColorJar.ts:118) rồi vẽ.
// Hạt đã bị pool.removeAt từ trước — đây thuần tuý là trang trí, xoá đi thì số liệu QC không đổi.
//
// NGÂN SÁCH: 1 lượt hút có thể tới hàng nghìn hạt (đo: 2000+/step lúc vuốt mạnh). Vẽ hết là vô nghĩa lẫn
// tốn kém -> LẤY MẪU: mỗi `sampleEvery` hạt lấy 1, và trần `capacity` cung bay cùng lúc. Cát nhìn vẫn "chảy"
// vào lọ vì mắt đọc DÒNG chứ không đếm hạt.

import { Color, MeshRenderer, Node, Vec3 } from 'cc';
import { attachSphere } from './QuadVisual';
import type { HarvestedGrain } from '../solver/counting';

/** Thời gian bay 1 cung. Ngắn hơn thì đọc thành "hút", dài hơn thì cát lững lờ không giống bị hút. */
const FLIGHT_SEC = 0.38;
/** Độ vồng parabol theo tỉ lệ quãng ngang — 0 = bay thẳng. */
const ARC_HEIGHT = 0.45;
/** Đường kính 1 hạt visual (world). Nhỉnh hơn hạt sim để nhìn thấy khi bay nhanh. */
const FLY_SIZE = 0.42;

interface Flyer {
  node: Node;
  fromX: number; fromY: number;
  toX: number; toY: number;
  arc: number;
  t: number;          // 0..1; <0 = đang rảnh
}

export class JarFlyVisual {
  private readonly flyers: Flyer[] = [];
  private readonly renderers: MeshRenderer[] = [];
  private readonly root: Node;
  private readonly z: number;
  /** Cứ `sampleEvery` hạt bị hút thì bắn 1 cung. Bộ đếm dồn qua các lượt để không mất mẫu ở lượt nhỏ. */
  private readonly sampleEvery: number;
  private carry = 0;

  constructor(parent: Node, z: number, capacity = 64, sampleEvery = 12) {
    this.root = new Node('JarFly');
    this.root.setParent(parent);
    this.z = z;
    this.sampleEvery = Math.max(1, sampleEvery);

    for (let i = 0; i < capacity; i++) {
      const n = new Node(`fly_${i}`);
      n.setParent(this.root);
      n.active = false;
      this.renderers.push(attachSphere(n, FLY_SIZE, new Color(255, 255, 255, 255)));
      this.flyers.push({ node: n, fromX: 0, fromY: 0, toX: 0, toY: 0, arc: 0, t: -1 });
    }
  }

  /**
   * Xếp cung bay cho lượt hút vừa xong. `grains` = ColorJar.lastHarvested (CHỈ hợp lệ ngay sau harvest).
   * `target` = chỗ đứng của lọ. `color` = màu lọ.
   */
  spawnFrom(grains: readonly HarvestedGrain[], target: Vec3, color: Color): void {
    if (grains.length === 0) return;
    this.carry += grains.length;
    let take = Math.floor(this.carry / this.sampleEvery);
    if (take <= 0) return;
    this.carry -= take * this.sampleEvery;

    // Trải mẫu ĐỀU trên lượt hút thay vì lấy N hạt đầu — N hạt đầu hay nằm chụm 1 góc hộp.
    const stride = grains.length / take;
    for (let k = 0; k < take; k++) {
      const fi = this.acquire();
      if (fi < 0) break;                           // hết cung rảnh -> bỏ phần còn lại, không cấp phát thêm
      const f = this.flyers[fi];
      const gi = Math.min(grains.length - 1, Math.floor(k * stride));
      const g = grains[gi];
      f.fromX = g.x; f.fromY = g.y;
      f.toX = target.x; f.toY = target.y;
      f.arc = Math.abs(target.x - g.x) * ARC_HEIGHT + FLY_SIZE;
      f.t = 0;
      f.node.active = true;
      f.node.setPosition(g.x, g.y, this.z);
      this.renderers[fi].getMaterialInstance(0)?.setProperty('mainColor', color);
    }
  }

  /** Chạy theo FRAME. Cung bay là trang trí -> dùng dt thật, KHÔNG bám nhịp sim 30Hz. */
  tick(dt: number): void {
    const inv = 1 / FLIGHT_SEC;
    for (const f of this.flyers) {
      if (f.t < 0) continue;
      f.t += dt * inv;
      if (f.t >= 1) { f.t = -1; f.node.active = false; continue; }
      const u = f.t;
      const x = f.fromX + (f.toX - f.fromX) * u;
      // parabol: 4u(1-u) đỉnh 1 tại u=0.5 -> cung vồng lên rồi rơi vào miệng lọ
      const y = f.fromY + (f.toY - f.fromY) * u + f.arc * 4 * u * (1 - u);
      f.node.setPosition(x, y, this.z);
    }
  }

  /** Chỉ số cung rảnh, -1 = hết. Trả INDEX chứ không trả object vì caller cần cả renderer cùng chỉ số. */
  private acquire(): number {
    for (let i = 0; i < this.flyers.length; i++) if (this.flyers[i].t < 0) return i;
    return -1;
  }
}
