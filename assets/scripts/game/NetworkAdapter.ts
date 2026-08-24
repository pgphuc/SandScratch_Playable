// Adapter CTA theo network. Mỗi mạng có API mở store riêng; ad build ra 6 variant, mỗi variant nhồi 1 network id.
// Bảng lấy từ scenario.json `cta.perNetwork` (đã duyệt P3) và job.json `inputs.networks`.
//
// ⚠ META KHÔNG NHẬN URL: `FbPlayableAd.onCTAClick()` không có tham số — đích đến cấu hình ở phía Meta ad setup.
// Truyền storeUrl cho meta là vô nghĩa, KHÔNG phải lỗi im lặng, nên adapter bỏ qua url ở variant đó (đúng openItem
// đã ghi trong scenarios/index.json).
//
// Các API này là biến TOÀN CỤC do SDK của mạng bơm vào webview, không có typing -> truy cập qua globalThis có guard.
// Gọi khi SDK vắng (test trên desktop) chỉ log 1 dòng, KHÔNG throw: ném lỗi ở đúng cú chạm CTA là mất click thật.

export type NetworkId = 'applovin' | 'meta' | 'unityads' | 'ironsource' | 'mintegral' | 'pangle';

export const ALL_NETWORKS: readonly NetworkId[] = [
  'applovin', 'meta', 'unityads', 'ironsource', 'mintegral', 'pangle',
];

interface Mraid { open(url: string): void; }
interface Dapi { openStoreUrl(url: string): void; }
interface FbPlayableAd { onCTAClick(): void; }

function g<T>(name: string): T | null {
  const v = (globalThis as unknown as Record<string, unknown>)[name];
  return (v === undefined || v === null) ? null : (v as T);
}

export class NetworkAdapter {
  readonly network: NetworkId;
  readonly storeUrl: string;

  /** Đã mở store lần nào chưa — chống double-fire khi user chạm liên tục. */
  private opened = false;
  /** Đếm số lần gọi mà KHÔNG có SDK — P6 đọc để biết variant nào build sai. */
  missingSdkCount = 0;

  constructor(network: NetworkId, storeUrl: string) {
    this.network = network;
    this.storeUrl = storeUrl;
  }

  /** Mở store. Idempotent: lần thứ 2 trở đi không làm gì. */
  open(): void {
    if (this.opened) return;
    this.opened = true;

    switch (this.network) {
      case 'meta': {
        const fb = g<FbPlayableAd>('FbPlayableAd');
        if (fb !== null && typeof fb.onCTAClick === 'function') { fb.onCTAClick(); return; }
        break;
      }
      case 'mintegral': {
        const install = g<() => void>('install');
        if (typeof install === 'function') { install(); return; }
        break;
      }
      case 'ironsource': {
        // ironSource nhận CẢ HAI: dapi (chuẩn riêng) ưu tiên, rớt về mraid.
        const dapi = g<Dapi>('dapi');
        if (dapi !== null && typeof dapi.openStoreUrl === 'function') { dapi.openStoreUrl(this.storeUrl); return; }
        if (this.tryMraid()) return;
        break;
      }
      case 'pangle': {
        // Pangle/TikTok: SDK bơm `openAppStore` hoặc `download`; chưa chốt bản nào ở P0 (job.json ghi
        // "tiktok-specific"). Thử cả 2 rồi rớt về mraid — thứ tự này là PHỎNG ĐOÁN, phải verify ở P6 bằng
        // validator chính chủ trước khi tin.
        const openAppStore = g<() => void>('openAppStore');
        if (typeof openAppStore === 'function') { openAppStore(); return; }
        const download = g<() => void>('download');
        if (typeof download === 'function') { download(); return; }
        if (this.tryMraid()) return;
        break;
      }
      case 'applovin':
      case 'unityads': {
        if (this.tryMraid()) return;
        break;
      }
    }

    this.missingSdkCount++;
    // Không có SDK (chạy desktop / build sai variant): mở tab thường để vẫn test được luồng.
    const openWin = g<(u: string, t?: string) => unknown>('open');
    if (typeof openWin === 'function' && this.storeUrl.length > 0) openWin(this.storeUrl, '_blank');
    console.warn(`[NetworkAdapter] SDK của "${this.network}" không có trong webview — fallback window.open.`);
  }

  private tryMraid(): boolean {
    const mraid = g<Mraid>('mraid');
    if (mraid !== null && typeof mraid.open === 'function') { mraid.open(this.storeUrl); return true; }
    return false;
  }

  /** Cho ScenarioRunner replay trong lúc dev. */
  resetForReplay(): void { this.opened = false; }
}
