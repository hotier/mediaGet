/**
 * 音乐播放器页共用模型 / 常量
 * - 搜索源：GD 聚合源（网易云 / 酷我 / JOOX）+ 自研直连搜索源（QQ音乐 / 酷狗 / 咪咕，
 *   见 SELF_SEARCH_SOURCES）与音质档位
 * - 结果行与「正在播放」轨道数据结构
 * - 时间 / 大小格式化
 */

/** 关键词搜索的 source key（key 一律沿用 GD 直链通道命名）。
 *  GD 聚合上游开放搜索：netease / kuwo / joox；
 *  自研直连搜索（服务端直连音源，不经 GD）：tencent / kugou / migu（独立 chips），
 *  netease / kuwo 双通道——搜索以自研为主、GD 搜索引擎兜底（见 music-client 分派）。
 *  配置洛雪(lx-music)生态音源脚本后，会额外出现脚本声明的扩展源 key（如 qsvip / qdy），
 *  因此保留内置字面量提示的同时允许任意字符串。 */
export type SearchSourceKey =
  | "netease"
  | "tencent"
  | "kugou"
  | "kuwo"
  | "migu"
  | "joox"
  | (string & {});

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

/**
 * 内置自研直连搜索源 chips（服务端直连各音源搜索接口取回，不经 GD 上游；对应用户侧音源
 * 命名 wy/tx/kg/mg 的 tx/kg/mg）。netease / kuwo 不做独立 chips：搜索在 music-client 里按
 * 「自研为主 + GD 引擎兜底」双通道处理（netease 直链仍经 GD 主通道服务）。
 * - tencent / kuwo / netease 的自研搜索结果可复用既有 GD 直链 / 歌词 / 封面通道；
 * - kugou / migu 无内置直链引擎：搜索结果默认只识别展示；配置对应 lx 音源脚本兜底后
 *   （sources 目录 urlFallbacks，见 music-client requestPlayDirect）点播会自动改由音源脚本取链。
 * 搜索源映射：tx→tencent、kg→kugou、mg→migu。
 */
export const SELF_SEARCH_SOURCES: SearchSource[] = [
  { key: "tencent", label: "QQ音乐", color: "#31c27c" },
  { key: "kugou", label: "酷狗音乐", color: "#0fa5e9" },
  { key: "migu", label: "咪咕音乐", color: "#ee3a8a" },
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
