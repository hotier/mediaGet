/**
 * 音乐平台分享链接识别 / 归一化（纯函数，无网络依赖，浏览器与服务端共用）。
 *
 * 用途：链接解析模式。用户粘贴任意平台歌曲分享链接后：
 *   extractMusicUrl    从分享文本中抽出首个 http(s) URL；
 *   parseMusicLink     判断平台并从 URL 中提取曲目 ID（不含重定向跟随）；
 *   isFollowableShareUrl 判断是否属于需「服务端跟随一次重定向」的官方分享短链
 *                      （163cn.tv / t1.kugou.com / c.y.qq.com），由 resolve 路由处理。
 *
 * 平台支持梯度（对齐 app/api/music/resolve/route.js）：
 *   netease  —— 可解析到播放（详情走网易官方 JSON、直链走 GD 源）；
 *   tencent / kugou / kuwo —— 可识别并返回平台/ID，直链引擎接入后点亮。
 */

export type MusicPlatformKey = "netease" | "tencent" | "kugou" | "kuwo";

/** 平台展示元信息：resolve 状态 ready = 当前即可解析到播放 */
export interface MusicPlatformMeta {
  key: MusicPlatformKey;
  label: string;
  resolve: "ready" | "pending";
}

export const MUSIC_PLATFORMS: MusicPlatformMeta[] = [
  { key: "netease", label: "网易云音乐", resolve: "ready" },
  { key: "tencent", label: "QQ音乐", resolve: "pending" },
  { key: "kugou", label: "酷狗音乐", resolve: "pending" },
  { key: "kuwo", label: "酷我音乐", resolve: "pending" },
];

export const MUSIC_PLATFORM_LABEL: Record<MusicPlatformKey, string> = {
  netease: "网易云音乐",
  tencent: "QQ音乐",
  kugou: "酷狗音乐",
  kuwo: "酷我音乐",
};

export interface ParsedMusicLink {
  platform: MusicPlatformKey;
  /** 各平台语义下的曲目 ID（网易=数字 songId / QQ=songmid / 酷狗=hash / 酷我=rid） */
  songId: string;
  /** 解析用完整 URL（原样保留 query/hash） */
  url: string;
  /** URL 主机名 */
  host: string;
}

/** 可从文本中直接识别的平台规则（host 判定 + ID 提取），按顺序匹配 */
interface PlatformRule {
  key: MusicPlatformKey;
  /** hostname 归属判定（含其子域） */
  isHost: (hostname: string) => boolean;
  /** 从「pathname+search+hash」中提取该平台曲目 ID，不支持返回 null */
  idOf: (blob: string) => string | null;
}

/** 网易曲目 ID：songId 数字串。兼容两种真实形态：
 *  1) music.163.com/song?id=xxx / y.music.163.com/m/song?id=xxx&…（id 在任意参数位，
 *     短链落地常把 fx-wechatnew、uct2 等追踪参数排在 id 之前）；
 *  2) music.163.com/#/song?id=xxx（hash 路由，id 在 hash 段内）。 */
const NET_SONG_ID_RE = /\/song[?#](?:[^#]*[?&])?id=(\d{4,12})/;

/** 官方分享短链：本体不含曲目 ID，需服务端跟随一次重定向后重新解析 */
const FOLLOWABLE_HOSTS = /^(163cn\.tv|t1\.kugou\.com|c\.y\.qq\.com)$/i;

const RULES: PlatformRule[] = [
  {
    key: "netease",
    isHost: (h) => h === "music.163.com" || h.endsWith(".music.163.com"),
    idOf: (blob) => {
      const m = NET_SONG_ID_RE.exec(blob);
      return m ? m[1] : null;
    },
  },
  {
    key: "tencent",
    isHost: (h) => h === "qq.com" || h.endsWith(".qq.com"),
    idOf: (blob) => {
      // y.qq.com/n/ryqq/songDetail/<songmid> 详情页
      const a = /\/(?:songDetail|song)\/([A-Za-z0-9]{4,24})/.exec(blob);
      if (a) return a[1];
      // i.y.qq.com/v8/playsong.html?songmid=<songmid>
      const b = /[?&]songmid=([A-Za-z0-9]{4,24})/.exec(blob);
      return b ? b[1] : null;
    },
  },
  {
    key: "kugou",
    isHost: (h) => h === "kugou.com" || h.endsWith(".kugou.com"),
    idOf: (blob) => {
      // www.kugou.com/song/#hash=<32位> 等（hash 为歌曲标识）
      const m = /[?#&/]hash=([A-Za-z0-9]{16,40})/.exec(blob);
      return m ? m[1] : null;
    },
  },
  {
    key: "kuwo",
    isHost: (h) => h === "kuwo.cn" || h.endsWith(".kuwo.cn"),
    idOf: (blob) => {
      // www.kuwo.cn/play_detail/<rid>
      const m = /\/(?:play_detail|detail)\/(\d{5,12})/.exec(blob);
      return m ? m[1] : null;
    },
  },
];

/**
 * 从分享文本中抽出首个 http(s) URL。
 * 容忍：开头说明文字、URL 前后被中文标点 / 引号 / 括号包裹、尾部黏着 @平台等后缀。
 */
export function extractMusicUrl(text: string): string {
  if (typeof text !== "string") return "";
  const cleaned = text.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!cleaned) return "";
  const head = cleaned.match(/https?:\/\//i);
  if (!head || head.index == null) return "";
  // 从首个协议起取到第一个空白 / 全角标点 / 引号 为止
  let url = cleaned
    .slice(head.index)
    .split(/\s|[\u3000-\u303f\uff00-\uffef\u4e00-\u9fa5"'`<>【】「」『』]/)[0];
  if (!url) return "";
  // 剥掉尾部成对的闭合括号，直到不再变化（应对 (…(url)) 嵌套）
  let prev = "";
  while (prev !== url) {
    prev = url;
    url = url.replace(/[)\]}>]+$/, "");
  }
  // 再剥剩余的尾部半角标点与分享语黏连符
  url = url.replace(/[.,;:!?'"@，。；：！？、…~]+$/, "");
  return url.length >= 12 ? url : "";
}

/** 解析单个干净 URL：返回平台与曲目 ID；不可识别返回 null（不会跟随重定向） */
export function parseMusicLink(raw: string): ParsedMusicLink | null {
  const url = String(raw || "").trim();
  if (url.length < 12) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  // pathname+search+hash 拼接后统一做平台 ID 提取（hash 路由歌曲链接 id 在 hash 中）
  const blob = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  for (const rule of RULES) {
    if (!rule.isHost(host)) continue;
    const songId = rule.idOf(blob);
    if (!songId) return null;
    return { platform: rule.key, songId, url, host };
  }
  return null;
}

/** 是否为需服务端跟随一次重定向的官方分享短链（本身不含曲目 ID） */
export function isFollowableShareUrl(raw: string): boolean {
  const url = String(raw || "").trim();
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      FOLLOWABLE_HOSTS.test(parsed.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

/** 归一平台 key：小写 + trim，非法返回空串 */
export function normalizePlatformKey(key: unknown): MusicPlatformKey | "" {
  const v = String(key ?? "").trim().toLowerCase();
  return v in MUSIC_PLATFORM_LABEL ? (v as MusicPlatformKey) : "";
}
