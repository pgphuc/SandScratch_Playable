// PORT Mode A — nguồn: ir/code/!_Game_SDK/SandFlow/Flow/Grain/GrainParticlePool.cs (184 dòng).
// SoA phẳng, append-only + swap-remove. NativeArray<T> -> TypedArray cấp 1 lần (Alloc), KHÔNG cấp phát trong vòng update.
// float2 -> 2 slot liền nhau trong Float32Array: x tại 2i, y tại 2i+1.
//
// LỆCH SO VỚI NGUỒN (có chủ ý, ghi để P6 parity không bất ngờ): Unity tính trung gian bằng float32; JS tính bằng
// float64 rồi mới làm tròn xuống f32 lúc GHI vào Float32Array. Kết quả KHÔNG bit-identical, chỉ xấp xỉ ~1e-7 mỗi phép.
// Tuning dùng lại verbatim vẫn hợp lệ; parity đo bằng số liệu hành vi (fill ratio / throughput), không so bit.

export class GrainParticlePool {
  positions!: Float32Array;   // float2 x capacity
  velocities!: Float32Array;  // float2 x capacity
  radii!: Float32Array;
  colorIds!: Int32Array;
  carried!: Int32Array;       // số pixel gốc gom vào hạt (jar capacity)
  ghost!: Uint8Array;         // booster: đang xuyên tranh
  ghostReleaseY!: Float32Array;
  directJar!: Uint8Array;     // booster: rút khỏi pool bay thẳng vào lọ

  private _capacity = 0;
  private _count = 0;
  private _created = false;

  get isCreated(): boolean { return this._created; }
  get count(): number { return this._count; }
  get capacity(): number { return this._capacity; }

  /** Cấp phát pool. Gọi lại = thay mảng cũ (JS có GC nên không cần Dispose thủ công như NativeArray). */
  alloc(capacity: number): void {
    const cap = Math.max(1, capacity | 0);
    this._capacity = cap;
    this.positions = new Float32Array(cap * 2);
    this.velocities = new Float32Array(cap * 2);
    this.radii = new Float32Array(cap);
    this.colorIds = new Int32Array(cap);
    this.carried = new Int32Array(cap);
    this.ghost = new Uint8Array(cap);
    this.ghostReleaseY = new Float32Array(cap);
    this.directJar = new Uint8Array(cap);
    this._count = 0;
    this._created = true;
  }

  /** Ghi 1 hạt vào cuối pool. false = pool đầy (throttle cứng theo capacity, đúng hành vi s1 nguồn). */
  emit(px: number, py: number, vx: number, vy: number, radius: number, colorId: number, carried: number,
       ghost = false, ghostReleaseY = 0, directJar = false): boolean {
    if (!this._created || this._count >= this._capacity) return false;
    const i = this._count;
    this.positions[i * 2] = px;
    this.positions[i * 2 + 1] = py;
    this.velocities[i * 2] = vx;
    this.velocities[i * 2 + 1] = vy;
    this.radii[i] = radius;
    this.colorIds[i] = colorId;
    this.carried[i] = carried;
    this.ghost[i] = ghost ? 1 : 0;
    this.ghostReleaseY[i] = ghostReleaseY;
    this.directJar[i] = directJar ? 1 : 0;
    this._count++;
    return true;
  }

  /** Swap-remove phần tử i. Caller KHÔNG advance i (phần tử vừa tráo xuống i chưa xét). */
  removeAt(i: number): void {
    if (!this._created || i < 0 || i >= this._count) return;
    const last = this._count - 1;
    if (i !== last) {
      this.positions[i * 2] = this.positions[last * 2];
      this.positions[i * 2 + 1] = this.positions[last * 2 + 1];
      this.velocities[i * 2] = this.velocities[last * 2];
      this.velocities[i * 2 + 1] = this.velocities[last * 2 + 1];
      this.radii[i] = this.radii[last];
      this.colorIds[i] = this.colorIds[last];
      this.carried[i] = this.carried[last];
      this.ghost[i] = this.ghost[last];
      this.ghostReleaseY[i] = this.ghostReleaseY[last];
      this.directJar[i] = this.directJar[last];
    }
    this._count--;
  }

  /** Loại mọi hạt có y < minY (rơi khỏi màn) -> pool bounded. Không advance i khi vừa tráo. */
  killBelowY(minY: number): void {
    if (!this._created) return;
    let i = 0;
    while (i < this._count) {
      if (this.positions[i * 2 + 1] < minY) this.removeAt(i);
      else i++;
    }
  }

  /** Gỡ cờ "đi thẳng vào lọ" -> hạt thành hạt thường (không còn lọ cùng màu đủ chỗ). */
  clearDirectJar(i: number): void {
    if (!this._created || i < 0 || i >= this._count) return;
    this.directJar[i] = 0;
  }

  killAll(): void { this._count = 0; }
}
