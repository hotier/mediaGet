/**
 * YouTube 解析：纯 HTTP 多源方案（适配 Vercel / CF Workers serverless）
 *
 * 背景（2026-09 实测）：Vercel / CF Workers 无法运行 yt-dlp；YouTube 官方对
 * 匿名访问全面签名/POToken 风控，纯自制解析不可行。因此采用业界通用 serverless
 * 路线：oEmbed 拿元数据 + 多个公开/自托管 Invidious / Piped 实例「并发竞速」取
 * 直链，任何一个实例恢复可用即自动生效。
 *
 * 注意（真实情况，2026-09 实测）：YouTube 会针对「数据中心/代理出口 IP」随机对
 * 部分视频（尤其年龄受限或新上热播）下发 LOGIN_REQUIRED / “Sign in to confirm
 * that you're not a bot”，此类视频任何匿名实例都无法解析（返回 500 + 错误文案，
 * 不是实例故障）。加上公共实例普遍维护差（大量 403/401/502/530），公共源不可
 * 100% 依赖。因此：
 *   - 失败时按实例返回的原始错误区分「视频被风控需登录」与「实例不可用」，
 *     给出准确提示（见 describeYoutubeFailure）；
 *   - 来源做成可配置：YOUTUBE_PIPED_HOSTS / YOUTUBE_INVIDIOUS_HOSTS 支持完整
 *     https base（如 https://pipedapi.example.com，也兼容自托管实例）；部署了
 *     自托管 Piped/Invidious 时把它加进环境变量即可稳定解析。
 *   - 官方元数据增强（可选）：配置 YOUTUBE_API_KEY 后，YouTube Data API v3 作为
 *     「优先元数据源」——标题/简介/频道真实头像/播放/点赞/发布时间/订阅以官方为准
 *     （v3 权威稳定，不随公共实例波动）；直链下载仍由 Piped/Invidious 竞速提供，
 *     官方源不可用/超时时静默回退 oEmbed 兜底，行为与未配置时完全一致。
 *
 * 在线播放稳定性（2026-09 增强）：官方 embed 不依赖任何第三方解析源——成功结果
 * 始终附带 videoId 与 embedUrl（youtube-nocookie.com/embed/{id}，无需 API Key）；
 * 当竞速源全部不可用但 oEmbed 确认视频存在时，降级返回「仅官方嵌入」成功结果
 * （data.embedOnly=true，无 url/audioUrl），保证用户至少能在线播放。该降级结果
 * 不写入缓存（见 api-middleware），解析源恢复后用户重试即可重新获得下载直链。
 */

import { logger } from "@/lib/api-utils";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const REQUEST_TIMEOUT_MS = Number(process.env.YOUTUBE_SOURCE_TIMEOUT_MS || 6000);

// 官方 YouTube Data API v3（可选元数据源）：配置 YOUTUBE_API_KEY 后启用，解析成功时
// 元数据以官方为准（v3 更权威稳定，公共实例常缺字段/波动）；videos+channels 两次请求
// 共享一个整体超时预算（YOUTUBE_API_TIMEOUT_MS），超时自动放弃并静默回退原链路。
// key 只放服务端环境变量，绝不进前端。注意：v3 只给元数据、不给媒体直链，下载直链
// 仍由 Piped/Invidious 竞速负责（见 fetchOfficialMeta）。
const YOUTUBE_API_KEY = String(process.env.YOUTUBE_API_KEY || "").trim();
const YOUTUBE_API_TIMEOUT_MS = Number(process.env.YOUTUBE_API_TIMEOUT_MS || 5000);

// 默认候选（2026-09 实测刷新）：
// - Invidious：官方 docs.invidious.io/instances 登记的 Clearnet 实例仅 5 个
//   （inv.nadeko.net / invidious.nerdvpn.de / yt.chocolatemoo53.com /
//   invidious.tiekoetter.com / invidious.f5.si），从数据中心出口实测匿名 /api/v1/videos
//   全部被拒：403 Endpoint disabled、401 需 Basic Auth、403 Forbidden(CF)、
//   "Making sure you're not a bot" 反爬页。官方亦建议「尽量自部署而非依赖公共实例」。
//   故默认不启用，只有用户通过 YOUTUBE_INVIDIOUS_HOSTS 显式配置（含自托管）才参与竞速。
// - Piped：Piped 官方同源为 piped.video 项目（API 走 pipedapi.<域名>），仍有匿名可用的
//   社区实例（见 https://github.com/TeamPiped/Piped/wiki/Instances），按实测保留下列候选。
const DEFAULT_INVIDIOUS_HOSTS = [];
const DEFAULT_PIPED_HOSTS = [
  "pipedapi.ducks.party",
  "pipedapi.leptons.xyz",
  "pipedapi.projectsegfau.lt",
];

const splitEnv = (raw) =>
  String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const INVIDIOUS_HOSTS = splitEnv(process.env.YOUTUBE_INVIDIOUS_HOSTS);
const PIPED_HOSTS = splitEnv(process.env.YOUTUBE_PIPED_HOSTS);

/** 把配置项归一化为可拼接的 https 根地址 */
export function normalizeBase(input) {
  const s = String(input || "").trim();
  if (!s) return "";
  return /^https?:\/\//i.test(s) ? s.replace(/\/+$/, "") : `https://${s.replace(/\/+$/, "")}`;
}

/** 从各类 YouTube 链接提取视频 id，失败返回 null */
export function extractVideoId(url) {
  if (!url) return null;
  const str = String(url);
  // youtu.be/ID、watch?v=ID、shorts/ID、embed/ID、live/ID
  const m =
    str.match(/youtu\.be\/([\w-]{6,})/) ||
    str.match(/[?&]v=([\w-]{6,})/) ||
    str.match(/youtube\.com\/(?:shorts|embed|live|v)\/([\w-]{6,})/);
  return m ? m[1] : null;
}

/** 从 yt-dlp/公共实例的 formats 里选最佳直链：优先带音轨的 mp4，其次音视频分离流 */
export function pickYoutubeFormat(info) {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const has = (f, k) => f[k] && f[k] !== "none";

  const progressive = formats
    .filter(
      (f) =>
        (f.ext === "mp4" || f.ext === "webm" || !f.ext) &&
        has(f, "acodec") &&
        has(f, "vcodec") &&
        f.url
    )
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  const videoOnly = formats
    .filter((f) => has(f, "vcodec") && !has(f, "acodec") && f.url)
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  const audio = formats
    .filter((f) => has(f, "acodec") && !has(f, "vcodec") && f.url)
    .sort((a, b) => (b.abr || 0) - (a.abr || 0));

  const best = progressive[0] || videoOnly[0];
  return {
    best,
    progressive,
    videoOnly,
    audio: audio[0] || null,
  };
}

/* ---------------- 元数据归一化（简介 / 头像 / 订阅 / 时间 / 计数） ----------------
 * 目标：与 B站解析结果对齐 —— 直链源（Piped / Invidious）响应里现成的视频简介、
 * 频道真实头像、播放量 / 点赞 / 发布时间 / 订阅数，统一抽出来后随 data 下发，
 * 前端频道卡与信息面板即可按 B站模式展示。oEmbed（官方嵌入降级）只有标题/作者/
 * 封面/频道页，故 embedOnly 场景这些富字段天然缺失（源本身拿不到）。
 */

/** 频道头像可能为字符串（Piped）或缩略图数组（Invidious authorThumbnails），统一取高清晰 URL */
function pickAvatar(input) {
  if (!input) return "";
  if (typeof input === "string") return input.trim();
  if (Array.isArray(input) && input.length) {
    const sorted = [...input].sort((a, b) => (b.width || 0) - (a.width || 0));
    return sorted[0]?.url || "";
  }
  if (input && typeof input === "object" && typeof input.url === "string") return input.url;
  return "";
}

/** 订阅/计数归一为数字：Piped 直接给数字，Invidious 给 "3.3M" 这类缩写文本 */
function toCount(input) {
  if (typeof input === "number") {
    return Number.isFinite(input) && input > 0 ? Math.round(input) : 0;
  }
  const m = /^\s*([\d.]+)\s*([KMB])?\s*$/i.exec(String(input ?? ""));
  if (!m) return 0;
  const mult = { K: 1e3, M: 1e6, B: 1e9 };
  const n = parseFloat(m[1]) * (m[2] ? mult[m[2].toUpperCase()] || 1 : 1);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** 频道主页链接：源可能给 "/channel/UCxxx" 相对路径或完整 URL，统一为完整链接 */
function channelUrl(input) {
  const s = String(input || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  return `https://www.youtube.com${s.startsWith("/") ? "" : "/"}${s}`;
}

/* ---------------- 纯解析（把公共实例 JSON 归一化为 formats 列表） ---------------- */

const AUDIO_CODEC_RE = /mp4a|opus|vorbis|m4a|ac-?3|flac|aac/i;
const VIDEO_CODEC_RE = /avc1|avc3|vp9|vp8|av01|hevc|hvc1|h264/i;

function mimeToExt(mime) {
  if (!mime) return null;
  const m = /^\w+\/([a-z0-9]+)/i.exec(String(mime));
  return m ? m[1].toLowerCase() : null;
}

/** 从 type/codecs/encoding 里取首个视频编码名 */
function videoCodec(type, encoding) {
  const src = String(encoding || type || "");
  const m = /codecs="?([a-z0-9._-]+)/i.exec(src);
  const codec = (m ? m[1] : src.trim().split(/\s+/)[0] || "avc1").toLowerCase();
  return VIDEO_CODEC_RE.test(codec) ? codec : "avc1";
}

/** 从 qualityLabel / quality / resolution / height 解析出高度数字 */
function pickHeight(qualityLabel, resolution, height) {
  const n = Number(height);
  if (n > 0) return n;
  const q = String(qualityLabel || "");
  if (q) {
    const m = /^(\d{3,4})/.exec(q);
    if (m) return Number(m[1]);
  }
  const r = String(resolution || "");
  const rm = /^(\d{3,4})x(\d{3,4})/.exec(r);
  if (rm) return Number(rm[2]);
  const qm = /^(\d{3,4})p/.exec(String(qualityLabel || resolution || ""));
  return qm ? Number(qm[1]) : 0;
}

const kb = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // 公共实例的 bitrate 单位不一：audio 常见 128kbps，也有按 bit/s（如 128000）。
  // 统一换算为 kbps 量纲（≥1000 视为 bit/s），仅用于排序，不要求精确。
  return n >= 1000 ? Math.round(n / 1000) : Math.round(n);
};

/**
 * Invidious /api/v1/videos/{id} 响应 → { formats, title, author, cover, durationMs }
 * formatStreams：合流（含音轨）；adaptiveFormats：音视频分离流
 */
export function parseInvidiousStreams(data) {
  const formats = [];
  if (!data || typeof data !== "object") {
    return {
      formats,
      title: "",
      author: "",
      cover: "",
      durationMs: 0,
      avatar: "",
      authorUrl: "",
      desc: "",
      published: undefined,
      viewCount: 0,
      likeCount: 0,
      subscriberCount: 0,
    };
  }

  for (const s of data.formatStreams || []) {
    if (!s || !s.url) continue;
    const type = String(s.type || "");
    const isAudio = AUDIO_CODEC_RE.test(type);
    const isVideo = /video\//.test(type) || s.qualityLabel || s.resolution || s.encoding;
    if (!isVideo) continue;
    formats.push({
      format_id: `fs-${formats.length}`,
      ext: s.container || mimeToExt(type) || "mp4",
      vcodec: videoCodec(type, s.encoding),
      acodec: isAudio ? "mp4a" : "none",
      height: pickHeight(s.qualityLabel, s.resolution, s.height),
      abr: kb(s.bitrate),
      url: s.url,
    });
  }

  for (const s of data.adaptiveFormats || []) {
    if (!s || !s.url) continue;
    const type = String(s.type || "");
    const enc = String(s.encoding || "");
    const isAudio =
      AUDIO_CODEC_RE.test(type) || AUDIO_CODEC_RE.test(enc) || s.audioQuality || s.audioSampleRate;
    const isVideo =
      /video\//.test(type) || VIDEO_CODEC_RE.test(enc) || s.qualityLabel || s.resolution;

    if (isAudio && !isVideo) {
      formats.push({
        format_id: `au-${formats.length}`,
        ext: s.container === "webm" ? "webm" : "m4a",
        vcodec: "none",
        acodec: "mp4a",
        abr: kb(s.bitrate),
        url: s.url,
      });
    } else if (isVideo) {
      formats.push({
        format_id: `ad-${formats.length}`,
        ext: s.container || mimeToExt(type) || "mp4",
        vcodec: videoCodec(type, enc),
        acodec: isAudio ? "mp4a" : "none",
        height: pickHeight(s.qualityLabel, s.resolution, s.height),
        url: s.url,
      });
    }
  }

  const seconds = Number(data.lengthSeconds || data.duration || 0);
  return {
    formats,
    title: data.title || "",
    author: data.author || "",
    cover: data.thumbnailUrl || data.thumbnail || "",
    durationMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0,
    // —— B站对齐富信息（Invidious /api/v1/videos 现成字段）——
    avatar: pickAvatar(data.authorThumbnails),
    authorUrl: channelUrl(data.authorUrl),
    desc: String(data.description || "").trim(),
    published: Number(data.published) > 0 ? Number(data.published) : undefined,
    viewCount: toCount(data.viewCount),
    likeCount: toCount(data.likeCount),
    subscriberCount: toCount(data.subCountText),
  };
}

/** Piped /streams/{id} 响应 → 同上统一结构（videoStreams/audioStreams） */
export function parsePipedStreams(data) {
  const formats = [];
  if (!data || typeof data !== "object") {
    return {
      formats,
      title: "",
      author: "",
      cover: "",
      durationMs: 0,
      avatar: "",
      authorUrl: "",
      desc: "",
      published: undefined,
      viewCount: 0,
      likeCount: 0,
      subscriberCount: 0,
    };
  }

  for (const s of data.videoStreams || []) {
    if (!s || !s.url) continue;
    const mime = String(s.mimeType || "");
    // Piped 的 videoStreams 默认是「仅视频」分离流；仅当显式声明非 videoOnly，
    // 或 mime codecs 里出现音频编码时才视为合流
    const hasAudioMime = AUDIO_CODEC_RE.test(mime) || AUDIO_CODEC_RE.test(String(s.codec || ""));
    const videoOnly = s.videoOnly === true || (s.videoOnly !== false && !hasAudioMime);
    formats.push({
      format_id: `pv-${formats.length}`,
      ext: mimeToExt(mime) || "mp4",
      vcodec: videoCodec(mime, s.codec),
      acodec: videoOnly ? "none" : "mp4a",
      height: pickHeight(s.quality, "", s.height),
      abr: kb(s.bitrate),
      url: s.url,
    });
  }

  for (const s of data.audioStreams || []) {
    if (!s || !s.url) continue;
    formats.push({
      format_id: `pa-${formats.length}`,
      ext: /webm/.test(String(s.mimeType || "")) ? "webm" : "m4a",
      vcodec: "none",
      acodec: "mp4a",
      abr: kb(s.bitrate),
      url: s.url,
    });
  }

  const seconds = Number(data.duration || data.lengthSeconds || 0);
  return {
    formats,
    title: data.title || data.name || "",
    author: data.uploader || data.uploaderName || data.author || "",
    cover: data.thumbnailUrl || data.thumbnail || "",
    durationMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0,
    // —— B站对齐富信息（Piped /streams 现成字段）——
    avatar: pickAvatar(data.uploaderAvatar),
    authorUrl: channelUrl(data.uploaderUrl),
    desc: String(data.description || "").trim(),
    published: data.uploadDate || undefined,
    viewCount: toCount(data.views),
    likeCount: toCount(data.likes),
    subscriberCount: toCount(data.uploaderSubscriberCount),
  };
}

/* ---------------- 候选构建与竞速 ---------------- */

const INVIDIOUS_FIELDS =
  "videoId,title,author,authorId,authorUrl,authorThumbnails,description,lengthSeconds,thumbnailUrl,subCountText,viewCount,likeCount,published,formatStreams,adaptiveFormats";

export function buildInvidiousCandidates(id, hosts = INVIDIOUS_HOSTS.length ? INVIDIOUS_HOSTS : DEFAULT_INVIDIOUS_HOSTS) {
  return (Array.isArray(hosts) ? hosts : []).filter(Boolean).map((base) => {
    const root = normalizeBase(base);
    return {
      kind: "invidious",
      base: root,
      url: `${root}/api/v1/videos/${encodeURIComponent(id)}?fields=${encodeURIComponent(INVIDIOUS_FIELDS)}`,
    };
  });
}

export function buildPipedCandidates(id, hosts = PIPED_HOSTS.length ? PIPED_HOSTS : DEFAULT_PIPED_HOSTS) {
  return (Array.isArray(hosts) ? hosts : []).filter(Boolean).map((base) => {
    const root = normalizeBase(base);
    return { kind: "piped", base: root, url: `${root}/streams/${encodeURIComponent(id)}` };
  });
}

/**
 * 带超时的 JSON fetch。
 * 失败时抛出 Error，附带 status 与 reason：reason 优先取实例返回的 JSON
 * error/message（用于识别「Sign in to confirm you're not a bot」等风控文案）。
 */
async function fetchJson(url, timeoutMs, externalSignal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  // 外部信号（如官方 v3 的整体预算）触发时同样中断本次请求
  const onExternalAbort = () => ctrl.abort();
  if (externalSignal) {
    if (externalSignal.aborted) ctrl.abort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": UA },
      signal: ctrl.signal,
      cache: "no-store",
      redirect: "follow",
    });
    const text = await res.text();
    if (!res.ok) {
      let reason = `HTTP ${res.status}`;
      try {
        const body = JSON.parse(text);
        if (body && typeof body === "object" && (body.error || body.message)) {
          reason = String(body.error || body.message).slice(0, 300);
        }
      } catch {
        if (text.trim().length > 0 && text.trim().length < 200) {
          reason += ` ${text.trim().slice(0, 120)}`;
        }
      }
      const err = new Error(reason);
      err.status = res.status;
      throw err;
    }
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("非 JSON 响应（疑似反爬/错误页）");
    }
    if (!data || typeof data !== "object") throw new Error("响应结构异常");
    return data;
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * 并发请求所有候选源：首个成功即返回；全部失败时抛出 Error（.attempts 含每个
 * 源的 tag/status/reason，供日志与用户提示做风控判定）。
 */
async function raceCandidates(id, hosts = { invidious: [], piped: [] }) {
  const invidiousHosts = hosts.invidious?.length
    ? hosts.invidious
    : INVIDIOUS_HOSTS.length
      ? INVIDIOUS_HOSTS
      : DEFAULT_INVIDIOUS_HOSTS;
  const pipedHosts = hosts.piped?.length
    ? hosts.piped
    : PIPED_HOSTS.length
      ? PIPED_HOSTS
      : DEFAULT_PIPED_HOSTS;
  const candidates = [
    ...buildInvidiousCandidates(id, invidiousHosts),
    ...buildPipedCandidates(id, pipedHosts),
  ];
  if (!candidates.length) throw new Error("NO_SOURCES_CONFIGURED");

  const attempts = [];
  let success = null;
  await new Promise((resolve) => {
    let pending = candidates.length;
    for (const c of candidates) {
      const tag = `${c.kind}:${c.base}`;
      fetchJson(c.url, REQUEST_TIMEOUT_MS)
        .then((raw) => {
          const parsed =
            c.kind === "piped" ? parsePipedStreams(raw) : parseInvidiousStreams(raw);
          if (!parsed.formats.length) {
            const e = new Error("实例未返回可播放直链");
            throw e;
          }
          attempts.push({ tag, ok: true });
          success = { kind: c.kind, base: c.base, parsed };
          resolve();
        })
        .catch((error) => {
          attempts.push({
            tag,
            ok: false,
            status: error.status || 0,
            reason: String(error.message || error).slice(0, 200),
          });
          if (--pending === 0) resolve();
        });
    }
  });

  if (!success) {
    const err = new Error(
      attempts.map((a) => `${a.tag} ${a.status || "-"} ${a.reason || ""}`).join(" | ")
    );
    err.attempts = attempts;
    throw err;
  }
  return success;
}

/** oEmbed：确认视频存在并兜底标题/作者/封面 */
async function fetchOembed(id) {
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(
    `https://www.youtube.com/watch?v=${id}`
  )}&format=json`;
  try {
    const data = await fetchJson(url, 6000);
    return {
      ok: true,
      title: data.title || "",
      author: data.author_name || "",
      cover: data.thumbnail_url || "",
      authorUrl: data.author_url || "",
    };
  } catch (error) {
    return { ok: false, status: error.status || 0 };
  }
}

/* ---------------- 官方 YouTube Data API v3（可选元数据源） ----------------
 * 定位：仅提供权威元数据，不提供媒体直链（下载直链仍由 Piped/Invidious 竞速负责）。
 * 配置 YOUTUBE_API_KEY 后启用：videos.list 拿视频元数据，再按 channelId 查一次
 * channels.list 补频道信息（头像 / 订阅 / @频道号 / 简介 / 投稿数 / 累计播放，
 * 全部来自现有 snippet,statistics 一次请求，不加配额；每次解析约 2 配额单位）。
 * 任一请求失败/超时均静默返回 { ok:false }，由调用方回退原链路，绝不阻塞解析。
 */

/** videos.list 请求地址（每次请求约 1 配额单位） */
export function officialVideosUrl(id, key) {
  const k = String(key || "").trim();
  return `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${encodeURIComponent(
    id
  )}&key=${encodeURIComponent(k)}`;
}

/** channels.list 请求地址（按 video 的 channelId 补齐频道头像 / 订阅数） */
export function officialChannelsUrl(channelId, key) {
  const k = String(key || "").trim();
  return `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${encodeURIComponent(
    channelId
  )}&key=${encodeURIComponent(k)}`;
}

/** v3 contentDetails.duration（ISO-8601，如 "PT4M13S"）→ 毫秒；无法解析返回 0 */
export function parseV3IsoDuration(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(
    String(iso || "")
  );
  if (!m) return 0;
  const [d, h, min, s] = [m[1], m[2], m[3], m[4]].map((x) => Number(x || 0));
  const ms = ((d * 24 + h) * 3600 + min * 60 + s) * 1000;
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0;
}

/** 统计字段为字符串（"12345"），统一转正数；缺失/0 返回 undefined（前端按无值隐藏） */
function v3Num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

/** v3 缩略图对象 { default/medium/high/standard/maxres: {url} } → 最高清 URL */
function v3Thumb(thumbs) {
  if (!thumbs || typeof thumbs !== "object") return "";
  for (const k of ["maxres", "standard", "high", "medium", "default"]) {
    if (thumbs[k] && typeof thumbs[k].url === "string" && thumbs[k].url) {
      return thumbs[k].url;
    }
  }
  return "";
}

/** videos.list 响应 → 统一元数据（published 归一为秒级时间戳）；缺 items 返回 null */
export function normalizeV3Video(payload) {
  const item = payload?.items?.[0];
  if (!item) return null;
  const snippet = item.snippet || {};
  const contentDetails = item.contentDetails || {};
  const statistics = item.statistics || {};
  const publishedMs = Date.parse(String(snippet.publishedAt || ""));
  const published =
    Number.isFinite(publishedMs) && publishedMs > 0
      ? Math.floor(publishedMs / 1000)
      : undefined;
  return {
    ok: true,
    official: true,
    title: snippet.title || "",
    author: snippet.channelTitle || "",
    channelId: snippet.channelId || "",
    authorUrl: snippet.channelId
      ? `https://www.youtube.com/channel/${snippet.channelId}`
      : "",
    cover: v3Thumb(snippet.thumbnails),
    avatar: "",
    // 简介可能很长，控制下发体积（前端 TruncatedText/line-clamp 展示）
    desc: String(snippet.description || "")
      .trim()
      .slice(0, 5000),
    durationMs: parseV3IsoDuration(contentDetails.duration),
    published,
    viewCount: v3Num(statistics.viewCount),
    likeCount: v3Num(statistics.likeCount),
  };
}

/** channels.list 响应 → 在视频元数据上补频道信息（失败不阻塞已拿到的视频元数据）：
 * 头像 / 订阅数（隐藏则不覆盖）/ 频道号 @handle → authorId + 更友好的 handle 主页链接 /
 * 频道简介 sign（截断下发）/ 投稿数 videoCount / 频道累计播放 channelViews。
 * 统计字段 0 / 缺失按无值，前端据此自动隐藏，不虚报。 */
export function normalizeV3Channel(payload, meta) {
  const item = payload?.items?.[0];
  if (!item || !meta || typeof meta !== "object") return meta;
  const snippet = item.snippet || {};
  const statistics = item.statistics || {};
  const next = { ...meta };
  next.avatar = v3Thumb(snippet.thumbnails) || next.avatar || "";
  // 订阅数隐藏的频道 v3 不下发真实值，此时保留原值（可能来自直链源 / 缺失）
  if (statistics.hiddenSubscriberCount !== true) {
    const sub = v3Num(statistics.subscriberCount);
    if (sub !== undefined) next.subscriberCount = sub;
  }
  // 频道号（customUrl，如 "@MrBeast"）：去 @ 前缀存 authorId，前端展示时补 @；
  // 有频道号时主页链接用更友好的 handle 形式（https://www.youtube.com/@handle）
  const handle = String(snippet.customUrl || "").trim().replace(/^@/, "");
  if (handle) {
    next.authorId = handle;
    next.authorUrl = `https://www.youtube.com/@${handle}`;
  }
  // 频道简介（个人签名，与 B 站 UP 主 sign 对齐）；超长截断，控制下发体积
  const channelDesc = String(snippet.description || "").trim();
  if (channelDesc) next.sign = channelDesc.slice(0, 500);
  // 投稿数 / 频道累计播放（官方统计）
  const videoCount = v3Num(statistics.videoCount);
  if (videoCount !== undefined) next.videoCount = videoCount;
  const channelViews = v3Num(statistics.viewCount);
  if (channelViews !== undefined) next.channelViews = channelViews;
  return next;
}

/**
 * 拉取官方 v3 元数据（videos.list + channels.list，共享整体超时预算）。
 * 任意失败返回 { ok:false, official:true, status }，绝不 throw —— 供调用方静默
 * 回退到「直链源解析 + oEmbed 兜底」，不让官方源可用性影响主链路。
 */
export async function fetchOfficialMeta(id) {
  if (!YOUTUBE_API_KEY) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), YOUTUBE_API_TIMEOUT_MS);
  try {
    const videoPayload = await fetchJson(
      officialVideosUrl(id, YOUTUBE_API_KEY),
      REQUEST_TIMEOUT_MS,
      ctrl.signal
    );
    let meta = normalizeV3Video(videoPayload);
    if (!meta) {
      // videos.list 对「不存在 / 私密 / 不公开」返回 200 + 空 items，等价 oEmbed 404
      return { ok: false, official: true, status: 404, reason: "videos.list 未返回该视频" };
    }
    if (meta.channelId) {
      try {
        const channelPayload = await fetchJson(
          officialChannelsUrl(meta.channelId, YOUTUBE_API_KEY),
          REQUEST_TIMEOUT_MS,
          ctrl.signal
        );
        meta = normalizeV3Channel(channelPayload, meta);
      } catch {
        // 频道详情失败：视频元数据仍可用
      }
    }
    return meta;
  } catch (error) {
    return {
      ok: false,
      official: true,
      status: error.status || 0,
      reason: String(error.message || error).slice(0, 200),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** YouTube 专有风控文案关键词：实例到达 YouTube 但该视频被要求登录确认 */
const BOT_GATED_RE =
  /LOGIN_REQUIRED|SignInConfirm|Sign in to confirm|not a bot|age-?restricted|isn't available for anonymous/i;

/**
 * 依据各源失败详情 + oEmbed 结果，区分失败类型并给出准确用户提示。
 * @returns {{ type: string, msg: string }}
 */
export function describeYoutubeFailure(attempts, meta) {
  if (!Array.isArray(attempts) || !attempts.length) {
    return {
      type: "no-sources",
      msg: "解析失败：未配置任何可用解析源，请通过 YOUTUBE_PIPED_HOSTS 配置自托管 Piped 实例",
    };
  }
  const botGated = attempts.some((a) => BOT_GATED_RE.test(String(a.reason || a.status || "")));
  if (botGated) {
    return {
      type: "bot-gated",
      msg: "解析失败：该视频被 YouTube 判定需登录验证（「确认您不是机器人」或年龄受限，数据中心/代理出口的匿名访问常被要求登录），暂无法匿名解析。可稍后重试；仍失败请配置带登录会话的解析实例（YOUTUBE_PIPED_HOSTS）",
    };
  }
  if (meta?.ok) {
    return {
      type: "sources-down",
      msg: "解析失败：解析源暂不可用（YouTube 对自动化请求风控较严），请稍后重试；仍失败可配置 YOUTUBE_PIPED_HOSTS / YOUTUBE_INVIDIOUS_HOSTS 接入自托管解析实例",
    };
  }
  if (meta?.status === 404) {
    return {
      type: "not-found",
      msg: "解析失败：视频不存在、已删除、私密或受地区/会员限制",
    };
  }
  return {
    type: "unreachable",
    msg: "解析失败：无法连接解析源，请检查网络后稍后重试",
  };
}

/** 非空判断：null / undefined / 空字符串均视为无值 */
function hasVal(v) {
  return v !== undefined && v !== null && v !== "";
}

/**
 * 竞速成功的直链结果。meta 为「已就绪」的元数据兜底（oEmbed 或官方 v3）：
 * 官方 v3（meta.official=true）时元数据以官方为准（优先覆盖实例字段），否则保留
 * 实例解析值、oEmbed 仅兜底缺失项。videoId/embedUrl 恒定附带，供前端官方嵌入播放。
 */
/**
 * 合流（含音轨）直链 → 可下载清晰度档位（与 B站 qualities 同构）：
 * 按高度降序、同高度去重（同高优先 mp4，webm 次之）；当前 best 档保证在列且居首
 * （下载行默认选第一档）。不足 2 档返回 undefined —— 前端走 qualityLabel 徽标，
 * 不渲染 B站同款清晰度下拉（下拉仅在真正可切换档位时出现）。
 */
export function toDownloadQualities(progressive, best) {
  const list = (Array.isArray(progressive) ? progressive : []).filter(
    (f) => f && f.url
  );
  if (!list.length) return undefined;
  const sorted = [...list].sort(
    (a, b) =>
      (b.height || 0) - (a.height || 0) ||
      (b.ext === "mp4" ? 1 : 0) - (a.ext === "mp4" ? 1 : 0)
  );
  const seen = new Set();
  const qualities = [];
  for (const f of sorted) {
    const h = f.height || 0;
    if (seen.has(h)) continue;
    seen.add(h);
    qualities.push({
      quality: h,
      label: h ? `${h}p` : "默认",
      url: f.url,
    });
  }
  if (best?.url && !qualities.some((q) => q.url === best.url)) {
    qualities.unshift({
      quality: best.height || 0,
      label: best.height ? `${best.height}p` : "默认",
      url: best.url,
    });
  }
  return qualities.length >= 2 ? qualities : undefined;
}

export function buildSuccess(result, meta, id) {
  const { parsed } = result;
  const { best, audio, progressive } = pickYoutubeFormat({
    formats: parsed.formats,
  });
  const hasAudioInBest = Boolean(best.acodec && best.acodec !== "none");
  const md = meta?.ok ? meta : null;
  const official = md?.official === true;
  logger.log(
    `[youtube] 解析成功（来源=${result.kind}:${result.base}）：《${(parsed.title || "").slice(0, 30)}》 ${best.height ? `${best.height}p` : "原画"}`
  );

  // 文本字段：官方 v3 优先取 meta，否则实例解析为主、meta 兜底
  const takeText = (field, fallback = "") => {
    if (official && hasVal(md[field])) return String(md[field]);
    const p = parsed[field];
    return hasVal(p) ? String(p) : hasVal(md[field]) ? String(md[field]) : fallback;
  };
  // 计数/订阅字段：>0 才下发（0 / 缺失按无值隐藏，前端据此隐藏徽标）
  const takeCount = (field) => {
    let v;
    if (official && hasVal(md[field])) v = md[field];
    else v = hasVal(parsed[field]) ? parsed[field] : md[field];
    return Number(v) > 0 ? Math.round(Number(v)) : undefined;
  };
  const time = official
    ? hasVal(md.published)
      ? md.published
      : parsed.published || undefined
    : parsed.published || md?.published || undefined;
  const durationMs = official
    ? Number(md.durationMs) > 0
      ? md.durationMs
      : parsed.durationMs || 0
    : parsed.durationMs || md?.durationMs || 0;

  return {
    code: 200,
    msg: "解析成功",
    data: {
      videoId: id,
      embedUrl: `https://www.youtube-nocookie.com/embed/${id}`,
      title: takeText("title", "YouTube 视频"),
      author: takeText("author"),
      cover: takeText("cover"),
      // —— B站对齐富信息：直链源/oEmbed 兜底，官方 v3 存在时以官方为准 ——
      authorUrl: takeText("authorUrl"),
      avatar: takeText("avatar"),
      desc: takeText("desc"),
      time: time || undefined,
      views: takeCount("viewCount"),
      like: takeCount("likeCount"),
      subscriberCount: takeCount("subscriberCount"),
      // 频道级信息（官方 v3 独有，走 channelId 的 channels.list）：@频道号 authorId /
      // 频道简介 sign / 投稿数 / 累计播放。直链源与 oEmbed 无这些字段，不虚报为空
      ...(official
        ? {
            authorId: md.authorId ? String(md.authorId) : undefined,
            sign: md.sign || undefined,
            videoCount:
              Number(md.videoCount) > 0 ? Math.round(Number(md.videoCount)) : undefined,
            channelViews:
              Number(md.channelViews) > 0
                ? Math.round(Number(md.channelViews))
                : undefined,
          }
        : {}),
      url: best.url,
      type: "video",
      duration: durationMs, // 前端按毫秒处理
      // 清晰度展示（下载选项区徽标），解析源不给清晰度时省略
      qualityLabel: best.height ? `${best.height}p` : "",
      // B站同款可下载档位：解析源提供的全部「合流（含音轨）」直链按高度降序去重，
      // ≥2 档时前端渲染行内清晰度下拉；单档仍由 qualityLabel 徽标展示。
      // 仅视频分离流无声、不可直接下载，不入列。
      qualities: toDownloadQualities(progressive, best),
      source: `${result.kind}:${result.base}`,
      // 只有分离流（无声视频）时才附带最佳音轨；合流不额外下发
      audioUrl: audio && !hasAudioInBest ? audio.url : undefined,
    },
  };
}

/**
 * 官方嵌入降级结果：oEmbed 确认视频存在（HTTP 200），但所有直链解析源不可用。
 * 返回可「在线播放」的成功结果（videoId/embedUrl/元数据），不带 url/audioUrl。
 * data.embedOnly=true 供中间件跳过缓存（避免降级态粘住 24h/数分钟），
 * 解析源恢复后用户重试即重新竞速取直链。
 */
export function buildEmbedOnlyResult(id, meta) {
  const md = meta?.ok ? meta : null;
  const official = md?.official === true;
  return {
    code: 200,
    msg: "解析成功（在线播放可用）",
    data: {
      videoId: id,
      embedUrl: `https://www.youtube-nocookie.com/embed/${id}`,
      title: md?.title || "YouTube 视频",
      author: md?.author || "",
      cover: md?.cover || "",
      // oEmbed 只给标题/作者/封面/频道主页；官方 v3 则能补齐真实头像/简介/统计/订阅
      // /时长/时间 —— 即便直链源全挂（embedOnly），富信息卡仍可与 B站模式一致展示。
      // oEmbed 无这些字段，自然保持缺失（不虚报为空）。
      authorUrl: md?.authorUrl || "",
      ...(official
        ? {
            avatar: md.avatar || undefined,
            desc: md.desc || undefined,
            duration: md.durationMs || undefined,
            time: md.published || undefined,
            views: Number(md.viewCount) > 0 ? Number(md.viewCount) : undefined,
            like: Number(md.likeCount) > 0 ? Number(md.likeCount) : undefined,
            subscriberCount:
              Number(md.subscriberCount) > 0 ? Number(md.subscriberCount) : undefined,
            // 频道级信息（官方 v3 独有）：@频道号 authorId / 频道简介 sign / 投稿数 / 累计播放
            authorId: md.authorId || undefined,
            sign: md.sign || undefined,
            videoCount:
              Number(md.videoCount) > 0 ? Math.round(Number(md.videoCount)) : undefined,
            channelViews:
              Number(md.channelViews) > 0 ? Math.round(Number(md.channelViews)) : undefined,
          }
        : {}),
      type: "video",
      embedOnly: true,
      source: official ? "youtube-v3" : "oembed",
    },
  };
}

/**
 * 解析 YouTube 视频链接，返回统一结果结构 { code, msg, data }
 * - 200：成功。两类——直链就绪（url/audioUrl 齐全），或「仅官方嵌入」降级
 *   （embedOnly=true，无 url/audioUrl，元数据源确认存在但竞速源不可用，前端以官方 iframe 播放）
 * - 201：明确失败（无法识别链接 / 视频不存在 / 元数据源也无法确认可用）
 * - 500：内部异常
 */
export async function parseYoutube(url) {
  const id = extractVideoId(url);
  if (!id) {
    return { code: 201, msg: "解析失败：无法识别的 YouTube 视频链接" };
  }

  // oEmbed 与直链竞速并行发起。oEmbed 用途：（1）竞速失败时确认视频是否真的存在
  // （404 = 不存在/私密）；（2）确认存在后降级为官方嵌入播放；（3）兜底元数据。
  // settledMeta 是同步快照：竞速成功时若 oEmbed 已返回则顺手兜底标题/作者/封面，
  // 未返回也不等待——保住首屏速度（oEmbed 超时上限与单源一致，绝不能拖慢成功链路）。
  let settledMeta = null;
  const metaP = fetchOembed(id).then((m) => {
    settledMeta = m;
    return m;
  });

  // 官方 v3 元数据（可选）：配置 YOUTUBE_API_KEY 后启用，与竞速并行发起；
  // 竞速成功时优先等其落地、以官方元数据覆盖（整体受 YOUTUBE_API_TIMEOUT_MS 约束）。
  const v3P = YOUTUBE_API_KEY ? fetchOfficialMeta(id) : null;

  let race = null;
  let attempts = [];
  try {
    race = await raceCandidates(id);
  } catch (error) {
    race = null;
    attempts = Array.isArray(error?.attempts) ? error.attempts : [];
    // 汇总每个源的具体失败原因，替代晦涩的 "All promises were rejected"
    logger.warn(
      `[youtube] 全部解析源失败：\n` +
        (attempts.length
          ? attempts
              .map((a) => `  ${a.tag} → ${a.status || "ERR"} ${a.reason || ""}`)
              .join("\n")
          : `  ${String(error?.message || error).slice(0, 120)}`)
    );
  }

  // 竞速成功：已配置官方 v3 时等待其完成并优先采用（官方源失败/超时则回退原链路，
  // 不影响直链返回）；未配置时保持「不等 oEmbed、首屏直出」的原行为。
  if (race && race.parsed.formats.length) {
    if (v3P) {
      const v3 = await v3P;
      if (v3?.ok) return buildSuccess(race, v3, id);
    }
    return buildSuccess(race, settledMeta?.ok ? settledMeta : null, id);
  }

  // 竞速失败：等两个元数据源就绪。任一确认视频存在即降级官方嵌入播放——
  // 官方 v3 优先（富信息齐全，desc/头像/统计照常展示），oEmbed 次之。
  const oembed = await metaP;
  const v3 = v3P ? await v3P : null;
  const meta = v3?.ok ? v3 : oembed;
  if (meta?.ok) {
    logger.log(`[youtube] 解析源不可用，降级为官方嵌入播放 id=${id}`);
    return buildEmbedOnlyResult(id, meta);
  }

  // 两个元数据源都失败：优先按 404 判定不存在（v3 空 items 与 oEmbed 404 同义）
  const failureMeta =
    v3?.status === 404 ? v3 : oembed?.status === 404 ? oembed : oembed || v3;
  const failure = describeYoutubeFailure(attempts, failureMeta);
  logger.log(`[youtube] 失败类型=${failure.type}`);
  // failType 供前端区分「视频需登录验证 / 解析源故障 / 视频不存在」等失败形态，
  // 从而给出针对性提示（bot-gated 等说明并非解析服务故障，避免用户误判）。
  return { code: 201, msg: failure.msg, failType: failure.type };
}

export const _internal = {
  pickYoutubeFormat,
  toDownloadQualities,
  extractVideoId,
  normalizeBase,
  buildInvidiousCandidates,
  buildPipedCandidates,
  raceCandidates,
  parseInvidiousStreams,
  parsePipedStreams,
  describeYoutubeFailure,
  fetchOembed,
  buildSuccess,
  buildEmbedOnlyResult,
  // 官方 YouTube Data API v3（可选元数据源）纯函数，供测试注入
  officialVideosUrl,
  officialChannelsUrl,
  parseV3IsoDuration,
  normalizeV3Video,
  normalizeV3Channel,
  fetchOfficialMeta,
};
