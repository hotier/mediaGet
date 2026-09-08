/**
 * 音乐解析播放器页 —— 搜索/直链/封面 客户端请求层
 *
 * 对应后端 /api/music（src/app/api/music/route.js）：
 * - action=search  按关键词分页搜索（netease / kuwo / joox）
 * - （无 action）   按 source+id+br 取试听直链
 * - action=pic     按 source+id 换专辑封面 URL
 */
import { BR_OPTIONS, type SearchSourceKey } from "@/components/music/types";

export const PAGE_SIZE = 10;

export interface SearchItem {
  id: string;
  urlId: string;
  name: string;
  artist: string[];
  album: string;
  source: string;
  /** 专辑封面 pic_id，需经 action=pic 二次换取真实图片 URL */
  picId?: string;
  /** 歌词 id，用于 action=lyric 获取歌词 */
  lyricId?: string;
}

/** /api/music?action=search 返回的 data 契约（后端提供 page/hasMore 供逐页拉取） */
export interface SearchData {
  source: string;
  keyword: string;
  page?: number;
  hasMore?: boolean;
  count?: number;
  items: SearchItem[];
}

export interface DirectData {
  url: string;
  br: number;
  size: number;
  source: string;
  id: string;
}

export interface PicData {
  url: string;
}

export interface LyricData {
  lyric: string;
}

/** 请求指定页码的搜索结果；code != 200 或响应异常时抛出可读错误 */
export async function requestSearchPage(
  src: string,
  kw: string,
  targetPage: number,
  signal: AbortSignal
): Promise<SearchData> {
  const qs = new URLSearchParams({
    action: "search",
    source: src,
    keyword: kw,
    page: String(targetPage),
    count: String(PAGE_SIZE),
  });
  const res = await fetch(`/api/music?${qs.toString()}`, { signal });
  const payload: { code: number; msg?: string; data?: SearchData } = await res.json();
  if (payload.code === 200 && payload.data) return payload.data;
  throw new Error(payload.msg || "搜索失败，请稍后重试");
}

/** 取指定 source+id 在 br 档位下的试听直链 */
export async function requestDirect(
  source: string,
  id: string,
  br: string,
  signal: AbortSignal
): Promise<DirectData> {
  const qs = new URLSearchParams({ source, id, br });
  const res = await fetch(`/api/music?${qs.toString()}`, { signal });
  const payload: { code: number; msg?: string; data?: DirectData } = await res.json();
  if (payload.code === 200 && payload.data?.url) return payload.data;
  throw new Error(payload.msg || "获取试听直链失败，请稍后重试");
}

/** 取专辑封面真实图片 URL */
export async function requestPic(
  source: string,
  picId: string,
  signal: AbortSignal
): Promise<string> {
  const qs = new URLSearchParams({ action: "pic", source, id: picId, size: "300" });
  const res = await fetch(`/api/music?${qs.toString()}`, { signal });
  const payload: { code: number; msg?: string; data?: PicData } = await res.json();
  if (payload.code === 200 && payload.data?.url) return payload.data.url;
  throw new Error(payload.msg || "封面获取失败");
}

/** 取歌词文本（LRC 格式） */
export async function requestLyric(
  source: string,
  lyricId: string,
  signal: AbortSignal
): Promise<string> {
  const qs = new URLSearchParams({ action: "lyric", source, id: lyricId });
  const res = await fetch(`/api/music?${qs.toString()}`, { signal });
  const payload: { code: number; msg?: string; data?: LyricData } = await res.json();
  if (payload.code === 200 && typeof payload.data?.lyric === "string") {
    return payload.data.lyric.trim();
  }
  throw new Error(payload.msg || "歌词获取失败");
}

/** 音质档位详情 */
export function brInfo(value: string): { label: string; br: number } {
  const opt = BR_OPTIONS.find((o) => o.value === value);
  return { label: opt?.label ?? `${value}kbps`, br: Number(value) || 320 };
}

export function brIsSupported(value: string): boolean {
  return BR_OPTIONS.some((o) => o.value === value);
}

export type { SearchSourceKey };
