import type { SearchItem } from "@/lib/music-client";

/** 播放列表会话快照（localStorage 单份 JSON）：最近一次搜索结果（含已翻页累积）。
 * 目的：刷新不摧毁列表；同一关键词 + 来源再次搜索，若首页结果与缓存头部一致，
 * 视为同一份结果，直接沿用缓存里更完整的累积列表，避免重新搜索后只剩第一页。 */
export interface PlaylistSnapshot {
  /** 搜索关键词；链接解析产物列表存空串 */
  kw: string;
  /** 生成该列表时所用的搜索源 chip */
  source: string;
  /** 当前已加载到的页号 */
  page: number;
  hasMore: boolean;
  list: SearchItem[];
}

export const PLAYLIST_CACHE_KEY = "mp-playlist-cache-v2";
/** 防止 localStorage 塞爆：只保留最近的 N 条，正常翻页远达不到该上限 */
const PLAYLIST_CACHE_LIMIT = 400;

export function readPlaylistSnapshot(): PlaylistSnapshot | null {
  try {
    const raw = localStorage.getItem(PLAYLIST_CACHE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<PlaylistSnapshot>;
    if (!d || !Array.isArray(d.list) || typeof d.kw !== "string") return null;
    return {
      kw: d.kw,
      source: typeof d.source === "string" ? d.source : "",
      page: typeof d.page === "number" && d.page >= 1 ? d.page : 1,
      hasMore: Boolean(d.hasMore),
      list: d.list as SearchItem[],
    };
  } catch {
    return null;
  }
}

export function writePlaylistSnapshot(s: PlaylistSnapshot): void {
  try {
    localStorage.setItem(
      PLAYLIST_CACHE_KEY,
      JSON.stringify({
        ...s,
        list:
          s.list.length > PLAYLIST_CACHE_LIMIT
            ? s.list.slice(-PLAYLIST_CACHE_LIMIT)
            : s.list,
      })
    );
  } catch {
    // 隐私模式等写入失败时静默降级，不影响播放
  }
}

export function clearPlaylistSnapshot(): void {
  try {
    localStorage.removeItem(PLAYLIST_CACHE_KEY);
  } catch {
    /* 忽略 */
  }
}

/** 本次搜索首页返回 fresh 是否与缓存列表头部逐条一致（source+id 对齐即可，忽略元数据噪声） */
export function isSameListHead(fresh: SearchItem[], cached: SearchItem[]): boolean {
  if (!fresh.length || fresh.length > cached.length) return false;
  return fresh.every((it, i) => {
    const prev = cached[i];
    return !!prev && prev.source === it.source && prev.id === it.id;
  });
}
