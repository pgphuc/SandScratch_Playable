// PORT Mode A — nguồn: ir/code/!_Game_SDK/SandFlow/Flow/Grain/GrainGrainCcd.cs (162).
//
// J2.5 — CONTINUOUS collision HẠT-HẠT, POSITION-ONLY. Chạy GIỮA build neighbor grid (J2) và vòng contact (J3).
//
// TRIỆU CHỨNG nó chữa: hạt rơi nhanh (emitSpeed 20 + gravity 50) bước 0.02·v có thể VƯỢT TRỌN 1 hạt trong đụn
// (tunnel cần bước > 2·rsum ≈ 0.48) => hạ cánh vào GIỮA đụn thay vì trên MẶT. Vòng contact test 1 ĐIỂM tại pos SAU
// integrate nên mù với ca này; tường SDF + occupancy tranh CÓ sweep pPrev->p, contact hạt-hạt thì KHÔNG.
//
// CÁCH: quét đoạn a = posPrev[i] (đầu step) -> b = positions[i] (sau integrate) trong hệ TƯƠNG ĐỐI với hạt cản j,
// tìm hạt j chắn đường, KẸP positions[i] về ĐIỂM CHẠM ĐẦU TIÊN. KHÔNG đụng velocities — phần hãm rơi ra TỰ NHIÊN ở
// finalize (kẹp về tMin làm |corr| TO HẲN => kill hết bị cap bó => dừng inelastic tại mặt).
//
// LỆCH SO VỚI NGUỒN (có chủ ý):
// - CHỈ port đường LƯỚI ROW-MAJOR (useGrid=1). Đường hashmap của nguồn KHÔNG port: chính nguồn ghi hashmap ĐẾM ĐÔI
//   (2/9 ô đụng math.hash) và lưới row-major là bản thay thế — port cả 2 là chở theo 1 đường đã bị khai tử.
// - IJobParallelFor -> vòng `for`. An toàn hơn nguồn: nguồn phải cấm đọc positions[j] vì race (job ghi positions[i]
//   song song); ở đây tuần tự nên không có race — NHƯNG vẫn đọc posPrev[j]/velocities[j] ĐÚNG như nguồn, vì đổi sang
//   positions[j] sẽ đổi KẾT QUẢ (hạt đã bị kẹp trước đó trong cùng vòng).

import { rowSpan, type GrainCellGrid, type Span } from './neighborGrid';

/** Cờ ĐO per-hạt: 0 = early-out (bước <= gate) · 1 = có quét ô mà không chạm · 2 = có KẸP. */
export const CCD_DIAG_EARLY_OUT = 0;
export const CCD_DIAG_SWEPT = 1;
export const CCD_DIAG_CLAMPED = 2;

export interface CcdParams {
  dt: number;
  /**
   * Ngưỡng chạy theo BÁN KÍNH: chỉ sweep hạt bước > ccdGate·radius. Đụn nằm yên |d|≈0 -> early-out ~0 phí (đòn bẩy
   * cho phép job chạy trên toàn pool mà không đánh thuế phần tĩnh). 0 = KHÔNG chạy job (gate ở backend).
   */
  ccdGate: number;
  /**
   * TRẦN quãng GIẬT LÙI theo BÁN KÍNH — chống "hạt bật nảy". 0 = KHÔNG kẹp = lùi trọn về điểm chạm.
   * ⚠ maxPush của vòng contact KHÔNG thay được knob này: nó kẹp TỐC ĐỘ đẩy/frame, không kẹp QUÃNG đẩy tổng.
   */
  ccdMaxPull: number;
  /** radii[] hằng -> scalar, bỏ gather; bit-identical khi mọi hạt cùng bán kính. */
  uniformRadius: number;
}

const _span: Span = { begin: 0, end: 0 };

/**
 * Quét CCD cho [0..count). Chỉ ĐỌC posPrev/velocities/radii, chỉ GHI positions (và `diag` nếu truyền).
 * `grid` + `cellStart` + `entryIdx` = kết quả buildNeighborGrid của CHÍNH step này.
 */
export function grainGrainCcd(positions: Float32Array, posPrev: Float32Array, velocities: Float32Array,
                              radii: Float32Array, count: number,
                              grid: GrainCellGrid, cellStart: Int32Array, entryIdx: Int32Array,
                              p: CcdParams, diag?: Uint8Array): void {
  const dt = p.dt;
  const ring = grid.ring;
  const cell = grid.cellSize;

  for (let i = 0; i < count; i++) {
    if (diag) diag[i] = CCD_DIAG_EARLY_OUT;     // ghi TRƯỚC mọi early-out
    const i2 = i * 2;
    const ax = posPrev[i2], ay = posPrev[i2 + 1];
    const bx = positions[i2], by = positions[i2 + 1];
    const dix = bx - ax, diy = by - ay;         // dịch chuyển THẬT của i trong step (dùng cho kẹp vị trí)
    const ddi = dix * dix + diy * diy;
    const ri = radii[i];
    const gate = p.ccdGate * ri;
    if (ddi <= gate * gate) continue;           // bước quá ngắn để tunnel -> bỏ
    if (diag) diag[i] = CCD_DIAG_SWEPT;         // vượt gate = hạt PHẢI trả tiền quét ô
    const viStepX = velocities[i2] * dt;        // dịch chuyển ước lượng của i theo v (cho hệ TƯƠNG ĐỐI)
    const viStepY = velocities[i2 + 1] * dt;

    // Ô lưới đoạn a->b có thể chạm hạt cản = AABB của {ca, cb} NỚI ±ring ô. Ô lưới MỊN (2r/subdiv) nên phải nới
    // ±grid.ring — nới ±1 chỉ phủ 1 ô mịn = 2r/m < R, sẽ SÓT hạt cản. Mỗi hàng là 1 DẢI LIÊN TỤC -> 1 span/hàng.
    const cax = Math.floor(ax / cell), cay = Math.floor(ay / cell);
    const cbx = Math.floor(bx / cell), cby = Math.floor(by / cell);
    const gloX = Math.min(cax, cbx) - ring, gloY = Math.min(cay, cby) - ring;
    const ghiX = Math.max(cax, cbx) + ring, ghiY = Math.max(cay, cby) + ring;

    let tMin = 1;                               // 1 = không chạm; <1 = kẹp về điểm chạm đầu tiên
    for (let cy = gloY; cy <= ghiY; cy++) {
      if (!rowSpan(grid, cellStart, cy, gloX, ghiX, _span)) continue;
      for (let e = _span.begin; e < _span.end; e++) {
        const j = entryIdx[e];
        if (j === i) continue;
        // --- TestCandidate: sớm nhất mà VỊ TRÍ TƯƠNG ĐỐI (i so với j) cắt đĩa R = ri + rj ---
        const j2 = j * 2;
        const mx = ax - posPrev[j2];            // vị trí TƯƠNG ĐỐI đầu step
        const my = ay - posPrev[j2 + 1];
        const relX = viStepX - velocities[j2] * dt;    // dịch chuyển TƯƠNG ĐỐI/step (khử co-moving)
        const relY = viStepY - velocities[j2 + 1] * dt;
        const aa = relX * relX + relY * relY;
        // GATE VẬN TỐC TƯƠNG ĐỐI — chỗ chữa "rơi cực chậm" THẬT SỰ. Cột cát rơi là đám hạt CHẠM NHAU (cc≈0);
        // tunneler thì đâm 1 hạt gần TĨNH bằng vận tốc LỚN. Hai ca chỉ khác nhau ở |rel|:
        //   · cột co-moving: v_i≈v_j -> |rel| bé -> BỎ (nếu không: t≈0 -> kẹp về a -> hạt ĐỨNG YÊN mỗi step);
        //   · faller vs mặt đụn tĩnh: v_j≈0 -> |rel|≈|v_i·dt| LỚN -> giữ lại -> kẹp ở mặt (đúng mục tiêu).
        // |rel| bé KHÔNG THỂ tunnel -> BỎ là an toàn, không sót tunneler thật.
        const relGate = p.ccdGate * ri;
        if (aa <= relGate * relGate) continue;
        const rsum = ri + p.uniformRadius;
        const cc = mx * mx + my * my - rsum * rsum;
        if (cc <= 0) continue;                  // đã chồng SẴN từ đầu step -> vòng contact gỡ
        const bb = mx * relX + my * relY;       // = B/2 (hệ tương đối)
        if (bb >= 0) continue;                  // đang RỜI XA nhau (tương đối)
        const disc = bb * bb - aa * cc;         // (B/2)² - A·C
        if (disc < 0) continue;                 // trượt qua, không cắt
        const t = (-bb - Math.sqrt(disc)) / aa; // nghiệm NHỎ NHẤT = điểm VÀO
        if (t < tMin) tMin = t;                 // t>=1 (chạm ngoài step) không hạ tMin=1 -> tự bỏ
      }
    }
    if (tMin >= 1) continue;                    // không chạm ai trong step -> để nguyên

    // TRẦN QUÃNG LÙI: quãng lùi = (1-tMin)·|d|. Hạt rơi nhanh |d| ≈ 3 bán kính => lùi TRỌN về điểm chạm là đâm NGƯỢC
    // vào hạt theo sau (nó KHÔNG bị kẹp: cặp co-moving) => bơm overlap đúng bằng quãng lùi => vòng contact gỡ = đội
    // hạt trên lên = "NẢY".
    if (p.ccdMaxPull > 0) {
      const tFloor = 1 - p.ccdMaxPull * ri / Math.sqrt(ddi);   // ddi > gate² > 0 -> không chia 0
      if (tMin < tFloor) tMin = tFloor;                        // trần >= |d| -> tFloor <= 0 < tMin -> lùi trọn
    }
    positions[i2] = ax + tMin * dix;            // kẹp theo dịch chuyển THẬT của i
    positions[i2 + 1] = ay + tMin * diy;
    if (diag) diag[i] = CCD_DIAG_CLAMPED;
  }
}
