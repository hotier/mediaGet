import type { VideoPlatformKey } from "@/config/video-platforms";

/**
 * 音乐类平台 key（前端音乐解析播放器页使用）
 *
 * 只有「解析结果为音乐内容（音频试听/下载直链）」的平台才能放这里：
 * - qqmusic：QQ 音乐单曲分享链接（y.qq.com / c6.y.qq.com），type: music
 * - qsmusic：汽水音乐单曲分享链接（music.douyin.com），音频直链
 *
 * 注：quanminkge（全民K歌）解析返回的是视频直链（playurl_video），
 * 属于视频/图文内容，因此归「视频解析页」（/），不在此列。
 */
export const MUSIC_PLATFORM_KEYS = [
  "qqmusic",
  "qsmusic",
] as const satisfies readonly VideoPlatformKey[];

export type MusicPlatformKey = (typeof MUSIC_PLATFORM_KEYS)[number];

const MUSIC_KEY_SET = new Set<string>(MUSIC_PLATFORM_KEYS);

/** 是否为受支持的音乐类平台 key */
export function isMusicPlatformKey(key: string | undefined | null): key is MusicPlatformKey {
  return !!key && MUSIC_KEY_SET.has(key);
}
