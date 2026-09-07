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
 */

import { logger } from "@/lib/api-utils";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const REQUEST_TIMEOUT_MS = Number(process.env.YOUTUBE_SOURCE_TIMEOUT_MS || 6000);

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
    return { formats, title: "", author: "", cover: "", durationMs: 0 };
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
  };
}

/** Piped /streams/{id} 响应 → 同上统一结构（videoStreams/audioStreams） */
export function parsePipedStreams(data) {
  const formats = [];
  if (!data || typeof data !== "object") {
    return { formats, title: "", author: "", cover: "", durationMs: 0 };
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
  };
}

/* ---------------- 候选构建与竞速 ---------------- */

const INVIDIOUS_FIELDS =
  "videoId,title,author,lengthSeconds,thumbnailUrl,formatStreams,adaptiveFormats";

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
async function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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
    };
  } catch (error) {
    return { ok: false, status: error.status || 0 };
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

function buildSuccess(result, meta) {
  const { parsed } = result;
  const { best, audio } = pickYoutubeFormat({ formats: parsed.formats });
  const hasAudioInBest = Boolean(best.acodec && best.acodec !== "none");
  logger.log(
    `[youtube] 解析成功（来源=${result.kind}:${result.base}）：《${(parsed.title || "").slice(0, 30)}》 ${best.height ? `${best.height}p` : "原画"}`
  );
  return {
    code: 200,
    msg: "解析成功",
    data: {
      title: parsed.title || meta?.title || "YouTube 视频",
      author: parsed.author || meta?.author || "",
      cover: parsed.cover || meta?.cover || "",
      url: best.url,
      type: "video",
      duration: parsed.durationMs || 0, // 前端按毫秒处理
      source: `${result.kind}:${result.base}`,
      // 只有分离流（无声视频）时才附带最佳音轨；合流不额外下发
      audioUrl: audio && !hasAudioInBest ? audio.url : undefined,
    },
  };
}

/**
 * 解析 YouTube 视频链接，返回统一结果结构 { code, msg, data }
 * - 200：直链就绪（url/audioUrl）
 * - 201：明确失败（视频不可用 / 全部源暂不可用）
 * - 500：内部异常
 */
export async function parseYoutube(url) {
  const id = extractVideoId(url);
  if (!id) {
    return { code: 201, msg: "解析失败：无法识别的 YouTube 视频链接" };
  }

  const metaP = fetchOembed(id);
  let race;
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

  // 竞速成功即返回（无需等 oEmbed），保证首屏速度
  if (race && race.parsed.formats.length) {
    return buildSuccess(race, null);
  }

  // 竞速失败：结合各源返回文案 + oEmbed 结果给出准确原因与提示
  const meta = await metaP;
  const failure = describeYoutubeFailure(attempts, meta);
  logger.log(`[youtube] 失败类型=${failure.type}`);
  // failType 供前端区分「视频需登录验证 / 解析源故障 / 视频不存在」等失败形态，
  // 从而给出针对性提示（bot-gated 等说明并非解析服务故障，避免用户误判）。
  return { code: 201, msg: failure.msg, failType: failure.type };
}

export const _internal = {
  pickYoutubeFormat,
  extractVideoId,
  normalizeBase,
  buildInvidiousCandidates,
  buildPipedCandidates,
  raceCandidates,
  parseInvidiousStreams,
  parsePipedStreams,
  describeYoutubeFailure,
  fetchOembed,
};
