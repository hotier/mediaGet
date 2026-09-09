/**
 * 前端「平台引擎开关」控制器（能力矩阵 client）。
 *
 * 单一真源在服务端（src/lib/music-platform-flags.js 读 MUSIC_PLATFORM_SEARCH /
 * MUSIC_PLATFORM_PLAY），本模块负责：
 *   1. 内置一份与后端完全一致的默认矩阵（平台全集见 music-platform-flags.js）——
 *      UI 首帧即按默认过滤（含默认停用的 tencent），避免“先闪出后消失”；
 *   2. 启动时 GET /api/music/caps 拉取部署期真实矩阵，成功后覆盖并触发重渲染；
 *      失败/未到达保持默认——默认值与后端实际行为一致，不会产生误导。
 *
 * 边界语义：非内置平台 key（lx 脚本扩展源、GD-only 的 bilibili/tidal 等）不在平台全集
 * 内，不受平台开关约束（返回 true，由其自身通道/目录配置决定），避免误伤。
 */
import {
  MUSIC_FLAG_PLATFORM_KEYS,
  MUSIC_PLATFORM_DEFAULT_FLAGS,
} from "@/lib/music-platform-flags";

export interface MusicPlatformFlags {
  search: Record<string, boolean>;
  play: Record<string, boolean>;
}

/** 与后端一致的默认矩阵（副本，防止被测试/外部改写污染） */
function cloneDefaults(): MusicPlatformFlags {
  return {
    search: { ...MUSIC_PLATFORM_DEFAULT_FLAGS.search },
    play: { ...MUSIC_PLATFORM_DEFAULT_FLAGS.play },
  };
}

const PLATFORM_SET = new Set(MUSIC_FLAG_PLATFORM_KEYS);

/** 当前生效矩阵（默认 → 拉取成功后覆盖） */
let caps: MusicPlatformFlags = cloneDefaults();
let inflight: Promise<MusicPlatformFlags> | null = null;

/** 当前生效的平台开关矩阵（只读使用） */
export function getPlatformCaps(): MusicPlatformFlags {
  return caps;
}

/** 平台 key 是否在引擎开关全集内（否则不受平台开关约束） */
export function isFlaggedPlatform(key: string): boolean {
  return PLATFORM_SET.has(key);
}

/** 平台搜索引擎是否启用（lx 扩展源等非全集平台恒视为启用）。
 *  缺省读模块当前生效矩阵；显式传入矩阵可让调用方（如把矩阵放进 React state 的组件）驱动判定。 */
export function isPlatformSearchOn(
  key: string,
  matrix: MusicPlatformFlags = caps
): boolean {
  return isFlaggedPlatform(key) ? matrix.search[key] === true : true;
}

/** 平台播放引擎是否启用（lx 扩展源等非全集平台恒视为启用） */
export function isPlatformPlayOn(key: string): boolean {
  return isFlaggedPlatform(key) ? caps.play[key] === true : true;
}

/** 拉取一次部署期能力矩阵；失败保持默认。共享 inflight，无取消（数据源极小） */
export function refreshPlatformCaps(): Promise<MusicPlatformFlags> {
  if (inflight) return inflight;
  inflight = fetch("/api/music/caps", {
    headers: { accept: "application/json" },
    cache: "no-store",
  })
    .then(async (res) => {
      if (!res.ok) throw new Error(`caps http ${res.status}`);
      const json = (await res.json()) as {
        data?: { flags?: Partial<MusicPlatformFlags> };
      };
      const flags = json?.data?.flags;
      if (!flags) throw new Error("caps 缺少 flags");
      caps = {
        search: { ...cloneDefaults().search, ...(flags.search || {}) },
        play: { ...cloneDefaults().play, ...(flags.play || {}) },
      };
      return caps;
    })
    .catch(() => caps) // 通道故障 / 部署关闭端点时保持默认矩阵
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** 测试用：整体重置为默认 */
export function resetPlatformCapsForTest(): void {
  caps = cloneDefaults();
  inflight = null;
}

/** 测试用：注入指定矩阵（合并到默认之上） */
export function setPlatformCapsForTest(flags: Partial<MusicPlatformFlags>): void {
  caps = {
    search: { ...cloneDefaults().search, ...(flags.search || {}) },
    play: { ...cloneDefaults().play, ...(flags.play || {}) },
  };
}
