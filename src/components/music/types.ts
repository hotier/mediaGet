/**
 * 音乐播放器页共用模型 / 常量
 * - 搜索源（网易云 / 酷我 / JOOX）与音质档位（对齐 /api/music 后端契约）
 * - 结果行与「正在播放」轨道数据结构
 * - 时间 / 大小格式化
 */

/** 当前开放关键词搜索的 source（netease / kuwo / joox，对齐 /api/music 后端契约） */
export type SearchSourceKey = "netease" | "kuwo" | "joox";

export interface SearchSource {
  key: SearchSourceKey;
  label: string;
  color: string;
}

export const SEARCH_SOURCES: SearchSource[] = [
  { key: "netease", label: "网易云音乐", color: "#c20c0c" },
  { key: "kuwo", label: "酷我音乐", color: "#ff7e36" },
  { key: "joox", label: "JOOX", color: "#f5b40f" },
];

/** 音质档位分组 */
export type BrGroup = "standard" | "lossless";

export interface BrOption {
  /** 后端契约的码率值（对应 /api/music 的 br 参数） */
  value: string;
  label: string;
  /** 档位分组：标准音质 / 无损音质 */
  group: BrGroup;
  /** 推荐档位（选择器 / 播放条中标出） */
  recommended?: boolean;
}

/** 音质档位（按码率升序，切换器与直链契约共用 value） */
export const BR_OPTIONS: BrOption[] = [
  { value: "128", label: "128kbps", group: "standard" },
  { value: "192", label: "192kbps", group: "standard" },
  { value: "320", label: "320kbps", group: "standard", recommended: true },
  { value: "740", label: "无损 16bit", group: "lossless" },
  { value: "999", label: "无损 24bit", group: "lossless" },
];

/** 默认音质档 */
export const BR_DEFAULT = "320";

/** 分组展示名 */
export const BR_GROUP_LABEL: Record<BrGroup, string> = {
  standard: "标准音质",
  lossless: "无损音质",
};

export const BR_LABEL: Record<string, string> = Object.fromEntries(
  BR_OPTIONS.map((o) => [o.value, o.label])
);

/** 播放/展示的媒体类型 */
export type PlayMedia = "audio" | "video";

export interface PlayableTrack {
  key: string;
  /** 平台 key：qqmusic / qsmusic / netease / kuwo / joox */
  source: string;
  sourceLabel: string;
  /** 品牌强调色（封面占位 / 轨道底色） */
  color: string;
  title: string;
  artist?: string;
  album?: string;
  cover?: string;
  media: PlayMedia;
  /** 可播放/可下载直链 */
  url: string;
  br?: number;
  brLabel?: string;
  size?: number;
  /** 来源：搜索结果解析 / 链接解析 */
  origin: "search" | "parse";
  /** search 来源二次换取更高音质 / 封面所需 */
  urlId?: string;
  picId?: string;
  /** 无直链可用时的提示文案（如 VIP） */
  audioHint?: string;
}

export function formatTime(sec: number | undefined | null): string {
  if (!sec || !Number.isFinite(sec) || sec <= 0) return "00:00";
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(rest).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatSize(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${units[i]}`;
}
