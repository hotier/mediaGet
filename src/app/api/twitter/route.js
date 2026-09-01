import { createApiHandler } from "@/lib/api-middleware";
import { DEFAULT_MOBILE_UA } from "@/lib/default-mobile-ua";
import { getRedirectLocation } from "@/lib/redirect-location";

export const runtime = "nodejs";

/** 视频时长（秒）→ "mm:ss" / "h:mm:ss"，无效返回空串 */
function formatSeconds(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return "";
  const s = Math.round(n);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (x) => String(x).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

/** 数值归一：>0 的有限数字返回原值，其余（缺失/0/非法）返回 undefined */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// ---------------------------------------------------------------------------
// 第三方 fixer 服务列表（参考 FixTweetBot 的多 fixer 策略）：
// 官方 syndication 不可达/缺字段时，用多个 fixer 服务降级补齐，
// 避免单一 api.fxtwitter.com 挂掉导致整个降级路径失效。
// - fxTwitter 家族（api.fxtwitter.com / api.fixupx.com / api.twittpr.com）：
//   响应结构一致 { tweet: {...} }，共用 fxTwitter 适配器，**并发竞速**——
//   任一成功即返回（带完整作者信息：简介/粉丝/关注/互动统计/查看量）；
// - api.vxtwitter.com（BetterTwitFix）：结构为顶层推文对象，走 vxtwitter
//   适配器，不返回作者简介/粉丝数/查看量，仅当 fxTwitter 家族全失败时兜底。
// 请求统一用无需用户名的 /2/status/{id}（api.fxtwitter.com 主站优先走 v2）、
// /status/{id}（其余 fxTwitter 备用站）与 /i/status/{id}（vxtwitter）。
// 可用环境变量 TWITTER_FIXER_SERVICES（逗号分隔 host）覆盖启用列表，
// 某服务失效时动态剔除即可，无需改代码。
// ---------------------------------------------------------------------------
const DEFAULT_FIXER_HOSTS = [
  "api.fxtwitter.com",
  "api.fixupx.com",
  "api.twittpr.com",
  "api.vxtwitter.com",
];
const FIXER_HOSTS = (() => {
  const cfg = process.env.TWITTER_FIXER_SERVICES;
  if (typeof cfg === "string" && cfg.trim()) {
    const hosts = cfg
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (hosts.length > 0) return hosts;
  }
  return DEFAULT_FIXER_HOSTS;
})();

/** 判断 host 是否为 vxtwitter（结构不同，需走独立适配器） */
const IS_VXTWITTER = (host) => host === "api.vxtwitter.com";

/**
 * 判断官方 syndication 响应是否为 tombstone（推文已删除/受限/敏感内容不可见）。
 * 这类响应 HTTP 200 但无正文无媒体（{ "__typename": "TweetTombstone", "tombstone": {} }），
 * 若按成功解析会得到空文本的"纯文字"推文（type=text）——前端拿不到任何媒体。
 */
function isSyndicationTombstone(json) {
  if (!json || typeof json !== "object") return false;
  return json.__typename === "TweetTombstone" || Boolean(json.tombstone);
}

/** 各 fixer 单请求超时（ms）：主站放宽，备用缩短——主服务失败时尽快切下一个 */
const FIXER_TIMEOUT_MS = {
  "api.fxtwitter.com": 10000,
  "api.fixupx.com": 5000,
  "api.twittpr.com": 5000,
  "api.vxtwitter.com": 5000,
};

/** 请求单个 fixer 服务，成功返回解析后的 JSON，任何失败（网络/超时/非 200）返回 null */
async function fetchFixerJson(host, tweetId, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // api.fxtwitter.com 主站优先走 v2 接口 /2/status/{id}
    // （响应为 { status, thread, author }，pickFxTweet / buildFxResult 已兼容该结构）；
    // 其余 fxTwitter 备用站仍用 v1 /status/{id}，vxtwitter 用 /i/status/{id}。
    const path = IS_VXTWITTER(host)
      ? `i/status/${tweetId}`
      : host === "api.fxtwitter.com"
        ? `2/status/${tweetId}`
        : `status/${tweetId}`;
    const res = await fetch(`https://${host}/${path}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 并发竞速：返回第一批 resolve 为非空值的结果，全部失败返回 null。
 * 所有 promise 都不会 reject（fetchFixerJson 已把异常吞成 null），
 * 因此「任一成功即返回」比 Promise.allSettled 快——不会等最慢的失败者。
 */
function firstNonNull(promises) {
  return new Promise((resolve) => {
    let done = 0;
    const total = promises.length;
    if (total === 0) {
      resolve(null);
      return;
    }
    for (const p of promises) {
      Promise.resolve(p).then((v) => {
        if (v) {
          resolve(v);
        } else if (++done === total) {
          resolve(null);
        }
      });
    }
  });
}

/**
 * fxTwitter 家族并发竞速（带完整性校验）。
 *
 * 不同服务返回结构/缓存可能不同：响应缺 media 字段时无法区分「纯文本推文」
 * 与「媒体推文被漏字段」。若把缺 media 的响应直接按 text 短路返回，带媒体推文
 * 会被误判为纯文本且不再尝试其他服务 → 媒体漏收集且无法补救。
 * 规则：
 * - 完整结果（有媒体，或带 media 空结构的确认纯文本）任一返回即竞速胜出；
 * - 疑似不完整（type=text 且响应缺 media 字段）仅记为兜底，等所有服务 settle
 *   后仍无完整结果才返回——既避免漏媒体，又不让纯文本推文解析失败。
 */
async function raceFixerResults(hosts, tweetId) {
  if (hosts.length === 0) return null;
  return new Promise((resolve) => {
    let settled = 0;
    let fallback = null;
    for (const host of hosts) {
      (async () => {
        const json = await fetchFixerJson(
          host,
          tweetId,
          Math.min(FIXER_TIMEOUT_MS[host] || 6000, 6000)
        );
        const t = json ? pickFxTweet(json) : null;
        const result = t ? buildFxResult(t) : null;
        if (!result) {
          if (++settled === hosts.length) resolve(fallback);
          return;
        }
        // 完整结果：有媒体，或带 media 空结构的确认纯文本（t.media 字段存在）
        if (result.data.type !== "text" || t.media != null) {
          resolve(result);
          return;
        }
        // 疑似不完整：text 且缺 media 字段，仅作兜底，继续等完整结果
        if (!fallback) fallback = result;
        if (++settled === hosts.length) resolve(fallback);
      })();
    }
  });
}

/**
 * 从 variants 里挑最高码率的 mp4 直链（忽略 HLS m3u8 等不可下载格式）。
 * 兼容两种字段命名：syndication 标准结构 { content_type, url, bitrate }，
 * 以及官方顶层 video.variants 的 { type, src, bitrate }。
 */
function pickBestMp4(variants) {
  if (!Array.isArray(variants)) return "";
  let best = "";
  let maxBitrate = 0;
  for (const v of variants) {
    const ct = v?.content_type || v?.type || "";
    if (!String(ct).includes("mp4")) continue;
    const br = Number(v.bitrate) || 0;
    const u = v?.url || v?.src || "";
    if (u && (br > maxBitrate || !best)) {
      maxBitrate = br;
      best = u;
    }
  }
  return best;
}

/**
 * 从 fxTwitter 响应的媒体对象构建「路径 → 带 tag URL」修复表。
 *
 * 背景：video.twimg.com 的 mp4 直链必须带 ?tag= 签名参数才可播放——不带 tag 的
 * 请求会被 CDN 重置连接/拒绝（浏览器内嵌播放器直接「无法播放媒体」）。官方
 * syndication 的 variants 恰好不带 tag，而 fxTwitter 的 formats 带真实 tag，
 * 且与 syndication 的 URL 路径完全一致，可据此精确替换。
 */
function buildVideoFixTable(t) {
  const media = t?.media || {};
  const fixTable = new Map();
  const items = [
    ...(Array.isArray(media.videos) ? media.videos : []),
    ...(Array.isArray(media.all) ? media.all : []),
  ];
  for (const v of items) {
    if (v?.url) {
      try {
        fixTable.set(new URL(v.url).pathname, v.url);
      } catch {
        /* 忽略非法 URL */
      }
    }
    for (const f of Array.isArray(v?.formats) ? v.formats : []) {
      if (f?.url) {
        try {
          fixTable.set(new URL(f.url).pathname, f.url);
        } catch {
          /* 忽略非法 URL */
        }
      }
    }
  }
  return fixTable;
}

/**
 * 修复 video.twimg.com 直链：无 ?tag= 签名时，用 fixTable 中同路径的带 tag URL
 * 替换（fxTwitter 的 formats 与 syndication variants 路径一致）。
 * 已带 tag / 非 twimg 域 / 表中无匹配，均原样返回。
 */
function fixTwimgVideoUrl(url, fixTable) {
  if (!url || !fixTable || fixTable.size === 0) return url;
  if (!String(url).includes("video.twimg.com/")) return url;
  try {
    const u = new URL(url);
    if (u.searchParams.has("tag")) return url;
    return fixTable.get(u.pathname) || url;
  } catch {
    return url;
  }
}

/** 解码 syndication 文本中的常见 HTML 实体（text 字段是 HTML 转义后的内容） */
function unescapeHtml(str) {
  return String(str)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

/**
 * 清洗推文文本：解码 HTML 实体 + 移除媒体短链占位 + 折叠多余空白。
 * 带视频/图片的推文 text 末尾常带 "https://t.co/xxx" 占位（实体位于
 * entities.media 或 entities.urls，X 客户端将其渲染为媒体卡片，不属正文），
 * 需从标题中剔除。
 */
function cleanTweetText(text, entities) {
  let cleaned = unescapeHtml(text);
  const shortUrls = [
    ...(Array.isArray(entities?.urls) ? entities.urls : []),
    ...(Array.isArray(entities?.media) ? entities.media : []),
  ];
  for (const u of shortUrls) {
    if (u?.url) cleaned = cleaned.replaceAll(u.url, "");
  }
  // 逐行清洗：折叠行内多余空白、去每行首尾空白，但保留推文原有换行结构。
  // 短链常位于行尾引用块内（如 "> https://t.co/xxx"），剔除后该行可能只剩
  // 孤立的 ">" 引用前缀，此时整行删除（正文中的引用行 "> 文字" 不受影响）；
  // 裁剪首尾空行、连续空行压缩为单个，保留分段空行。
  const lines = cleaned
    .split("\n")
    .map((line) => line.trim().replace(/[ \t]+/g, " "));
  let trimmed = lines;
  while (trimmed.length > 0 && trimmed[0] === "") trimmed = trimmed.slice(1);
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === "")
    trimmed = trimmed.slice(0, -1);
  const result = [];
  for (const line of trimmed) {
    if (line === "" && result[result.length - 1] === "") continue;
    result.push(line);
  }
  return result.filter((line) => !/^>\s*$/.test(line)).join("\n");
}

function getTwitterToken(idStr) {
  const num = parseFloat(idStr);
  if (!Number.isFinite(num)) {
    return "";
  }
  const token = (num / 1e15) * Math.PI;
  let tokenStr = token.toString();
  if (tokenStr.includes("e") || tokenStr.includes("E")) {
    tokenStr = token.toFixed(16).replace(/\.?0+$/, "");
  }
  return tokenStr.replace(/0/g, "").replace(/\./g, "");
}

function extractTweetId(shareUrl) {
  const re = /(?:twitter\.com|x\.com)\/[^/]+\/status(?:es)?\/(\d+)/i;
  const m = shareUrl.match(re);
  return m?.[1] || "";
}

/**
 * 用第三方 fixer 补充作者信息（简介/粉丝数/互动统计）。
 * 官方 syndication 的 user 对象不含 description，故额外请求 fixer。
 * - fxTwitter 家族（api.fxtwitter.com / api.fixupx.com / api.twittpr.com）：
 *   完整作者信息（简介/粉丝/关注 + 互动统计/查看量）。**并发竞速**——任一成功
 *   立即返回，避免某个服务慢/挂时串行阻塞其他可用服务；
 * - vxtwitter（api.vxtwitter.com）：仅互动统计（无简介/粉丝/查看量），
 *   仅在 fxTwitter 家族全部失败后作最后兜底。
 * 全部失败静默返回空对象，不阻塞主解析流程。
 */
async function fetchAuthorProfile(tweetId) {
  if (!tweetId) return {};
  const fxHosts = FIXER_HOSTS.filter((h) => !IS_VXTWITTER(h));
  const vxHost = FIXER_HOSTS.find(IS_VXTWITTER);

  // 第一波：fxTwitter 家族并发，任一成功即返回完整作者信息
  const fx = await firstNonNull(
    fxHosts.map(async (host) => {
      const json = await fetchFixerJson(
        host,
        tweetId,
        Math.min(FIXER_TIMEOUT_MS[host] || 5000, 6000)
      );
      const t = pickFxTweet(json);
      if (!t) return null;
      const author = t.author || {};
      const followers = Number(author.followers);
      const following = Number(author.following);
      return {
        sign: typeof author.description === "string" ? author.description : "",
        followerCount:
          Number.isFinite(followers) && followers > 0 ? followers : undefined,
        followingCount:
          Number.isFinite(following) && following > 0 ? following : undefined,
        // 互动统计（点赞/转发/评论/查看量）：官方 syndication 常缺 reply/view，
        // fixer 一次请求补齐，由官方路径优先官方字段、缺失时用这些兜底
        like: num(t.likes),
        retweets: num(t.reposts ?? t.retweets),
        replies: num(t.replies),
        views: num(t.views),
        // 媒体 URL 修复表：官方 syndication 的 twimg 直链不带 ?tag= 签名（不可播放），
        // fxTwitter 的 formats 带真实 tag 且路径一致，供主路径按路径替换
        videoFixTable: buildVideoFixTable(t),
      };
    })
  );
  if (fx) return fx;

  // 第二波：vxtwitter 兜底（仅互动统计，无简介/粉丝；views 有则尽量补）
  if (vxHost) {
    const json = await fetchFixerJson(vxHost, tweetId, 4000);
    const t = pickVxtweet(json);
    if (t) {
      return {
        like: num(t.likes),
        retweets: num(t.retweets),
        replies: num(t.replies),
        views: num(t.views),
      };
    }
  }
  return {};
}

/**
 * fxTwitter 家族响应取推文对象：兼容新旧两种顶层结构（参考 FxEmbed 官方文档）。
 * - 旧版：{ tweet: {..., author} }（api.fxtwitter.com/status/{id}）
 * - v2：{ status: {...}, author: {...} }（api.fxtwitter.com/2/status/{id}，
 *   作者信息可能只在顶层；status 为 tombstone 时视为不可用）
 * 两者都拿不到时返回 null。
 */
function pickFxTweet(json) {
  if (!json || typeof json !== "object") return null;
  if (json.tweet && typeof json.tweet === "object") {
    // 旧结构 { tweet } 同样可能是 tombstone（删除/不可见），按不可用处理
    return json.tweet.type === "tombstone" ? null : json.tweet;
  }
  const s = json.status;
  if (s && typeof s === "object" && s.type !== "tombstone") {
    // v2 顶层 author 与 status.author 都可能存在，缺哪个补哪个，适配器统一取 status.author
    if (json.author && !s.author) s.author = json.author;
    return s;
  }
  return null;
}

/**
 * fxTwitter 适配器：将 fxTwitter 家族响应的推文对象
 * 构造为与官方路径同结构的 result（媒体直链 + 作者简介/粉丝数 + 互动统计）。
 * 兼容新旧结构：v2 用 reposts 字段（即 retweets）。结构缺失返回 null。
 */
function buildFxResult(t) {
  if (!t || typeof t !== "object") return null;
  // fxTwitter 的 tombstone 结构（删除/不可见）无媒体无正文，不能作为有效结果
  if (t.type === "tombstone") return null;
  const author = t.author || {};
  const authorName = author.name || author.screen_name || "";
  const authorScreenName = author.screen_name || "";
  const authorAvatar = author.avatar_url || "";
  const authorId = String(author.id || "");
  const authorUrl = authorScreenName
    ? `https://x.com/${authorScreenName}`
    : authorId
    ? `https://x.com/${authorId}`
    : "";
  const authorHandle = authorScreenName ? `@${authorScreenName}` : authorId;

  const media = t.media || {};
  const videos = [];
  const images = [];
  const pushVideo = (u, thumb, dur) => {
    const durationSec = Number(dur) > 0 ? Math.round(Number(dur)) : undefined;
    videos.push({
      title: "",
      url: u,
      duration: durationSec,
      durationFormat: formatSeconds(durationSec),
      cover: thumb || "",
    });
  };
  for (const v of Array.isArray(media.videos) ? media.videos : []) {
    if (v?.url) pushVideo(v.url, v.thumbnail_url, v.duration);
  }
  for (const p of Array.isArray(media.photos) ? media.photos : []) {
    if (p?.url) images.push(p.url);
  }
  // 兼容 media.all（混合媒体推文）：无条件遍历，仅补充 photos/videos
  // 未收录的项（按 URL 去重），避免某服务分类子集不全时漏图/漏视频。
  if (Array.isArray(media.all)) {
    const videoUrls = new Set(videos.map((v) => v.url));
    const imageUrls = new Set(images);
    for (const m of media.all) {
      if (!m?.url) continue;
      if (m.type === "video" && !videoUrls.has(m.url)) {
        pushVideo(m.url, m.thumbnail_url, m.duration);
        videoUrls.add(m.url);
      } else if (m.type === "photo" && !imageUrls.has(m.url)) {
        images.push(m.url);
        imageUrls.add(m.url);
      }
    }
  }

  const primary = videos[0];
  const cover = primary?.cover || images[0] || "";
  const type = videos.length > 0 ? "video" : images.length > 0 ? "image" : "text";
  const followers = Number(author.followers);
  const following = Number(author.following);
  const created = t.created_at ? Date.parse(t.created_at) : NaN;

  return {
    code: 200,
    msg: "解析成功",
    data: {
      title: t.text || "",
      author: authorName || authorScreenName,
      avatar: authorAvatar,
      uid: authorHandle,
      authorUrl,
      sign: typeof author.description === "string" ? author.description : undefined,
      followerCount:
        Number.isFinite(followers) && followers > 0 ? followers : undefined,
      followingCount:
        Number.isFinite(following) && following > 0 ? following : undefined,
      like: num(t.likes),
      // v2 结构字段名为 reposts（即 retweets），新旧兼容
      retweets: num(t.reposts ?? t.retweets),
      replies: num(t.replies),
      views: num(t.views),
      cover,
      url: primary?.url || images[0] || "",
      duration: primary?.duration,
      durationFormat: primary?.durationFormat,
      videos: videos.length > 1 ? videos : undefined,
      images: images.length > 0 ? images : undefined,
      type,
      time: Number.isFinite(created) ? created : undefined,
    },
  };
}

/** vxtwitter 顶层可能是数组（历史版本）或对象，统一取推文对象 */
function pickVxtweet(json) {
  if (Array.isArray(json)) return json[0] || null;
  return json && typeof json === "object" ? json : null;
}

/**
 * vxtwitter 适配器：把 BetterTwitFix 的推文对象构造为同结构的 result。
 * vxtwitter 不返回作者简介/粉丝数/查看量，仅互动统计 + 媒体直链，
 * 作为 fxTwitter 家族全挂后的最终兜底。
 */
function buildVxtwitterResult(t) {
  if (!t || typeof t !== "object") return null;
  const authorName = t.user_name || "";
  const authorScreenName = t.user_screen_name || "";
  const authorAvatar = t.user_profile_image_url || "";
  const authorUrl = authorScreenName
    ? `https://x.com/${authorScreenName}`
    : `https://x.com/${t.tweetID || ""}`;
  const authorHandle = authorScreenName ? `@${authorScreenName}` : "";

  const videos = [];
  const images = [];
  for (const m of Array.isArray(t.media_extended) ? t.media_extended : []) {
    if (!m?.url) continue;
    if (m.type === "video") {
      const durationMs = Number(m.duration_millis);
      const durationSec = durationMs > 0 ? Math.round(durationMs / 1000) : undefined;
      videos.push({
        title: "",
        url: m.url,
        duration: durationSec,
        durationFormat: formatSeconds(durationSec),
        cover: m.thumbnail_url || "",
      });
    } else if (m.type === "image") {
      images.push(m.url);
    }
  }
  // mediaURLs 兜底：无 media_extended 时按扩展名粗分视频/图片
  if (videos.length === 0 && images.length === 0 && Array.isArray(t.mediaURLs)) {
    for (const u of t.mediaURLs) {
      if (/\.(mp4|m4v|mov|webm)(\?|$)/i.test(u)) {
        videos.push({ title: "", url: u, cover: "" });
      } else {
        images.push(u);
      }
    }
  }

  const primary = videos[0];
  const cover = primary?.cover || images[0] || "";
  const type = videos.length > 0 ? "video" : images.length > 0 ? "image" : "text";
  const epoch = Number(t.date_epoch);
  const created = epoch > 0 ? epoch * 1000 : NaN;

  return {
    code: 200,
    msg: "解析成功",
    data: {
      title: t.text || "",
      author: authorName || authorScreenName,
      avatar: authorAvatar,
      uid: authorHandle,
      authorUrl,
      like: num(t.likes),
      retweets: num(t.retweets),
      replies: num(t.replies),
      cover,
      url: primary?.url || images[0] || "",
      duration: primary?.duration,
      durationFormat: primary?.durationFormat,
      videos: videos.length > 1 ? videos : undefined,
      images: images.length > 0 ? images : undefined,
      type,
      time: Number.isFinite(created) ? created : undefined,
    },
  };
}

/**
 * 优先解析：fxTwitter 家族并发竞速，任一成功即返回完整 result
 * （媒体带 tag 直链 + 完整作者信息：简介/粉丝/关注 + 互动统计）；
 * vxtwitter：仅当 fxTwitter 家族全部失败才兜底（缺简介/粉丝/查看量）。
 * 全部失败（网络/超时/非 200/结构缺失）返回 null，由调用方降级官方 syndication。
 */
async function parseViaFixer(tweetId) {
  if (!tweetId) return null;
  const fxHosts = FIXER_HOSTS.filter((h) => !IS_VXTWITTER(h));
  const vxHost = FIXER_HOSTS.find(IS_VXTWITTER);

  // fxTwitter 家族并发竞速（带完整性校验：缺 media 的 text 响应不短路，
  // 避免媒体推文被误判为纯文本导致漏收集）
  const fx = await raceFixerResults(fxHosts, tweetId);
  if (fx) return fx;

  if (vxHost) {
    const json = await fetchFixerJson(vxHost, tweetId, 4000);
    if (json) return buildVxtwitterResult(pickVxtweet(json));
  }
  return null;
}

async function parseVideoId(tweetId) {
  // 优先 fixer 服务：fxTwitter 家族并发竞速，vxtwitter 兜底。
  // fixer 返回的数据更完整（媒体带 tag 直链、作者简介/粉丝、互动统计），
  // 且对删除/受限/敏感推文常缓存有完整内容，稳定性优于官方 syndication。
  const fixerResult = await parseViaFixer(tweetId);
  if (fixerResult) return fixerResult;

  // fixer 全部失败 → 官方 syndication 兜底（正文 + 媒体直链）
  return parseViaSyndication(tweetId);
}

/**
 * 官方 syndication 兜底解析：fixer 服务全部失败时才走到这里。
 * 返回正文 + 媒体直链（多视频/图集）；作者简介/粉丝/互动统计等缺失字段
 * 由 fetchAuthorProfile 尽力补齐（fixer 刚全挂时通常也拿不到，静默降级为空）。
 * 任何失败（网络/非 200/tombstone/JSON 解析）直接明确报错，不再降级 fixer（已试过）。
 */
async function parseViaSyndication(tweetId) {
  const token = getTwitterToken(tweetId);
  const apiUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=${token}`;

  let res;
  try {
    res = await fetch(apiUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/json",
        Referer: "https://platform.twitter.com/",
      },
    });
  } catch {
    return { code: 502, msg: "Twitter 接口请求失败，请稍后重试" };
  }
  if (!res.ok) {
    return { code: res.status, msg: `Twitter syndication 请求失败 (${res.status})` };
  }

  let json;
  try {
    json = await res.json();
  } catch {
    return { code: 500, msg: "Twitter 响应解析失败" };
  }

  // 官方 syndication 对已删除/受限/敏感（成人）内容推文返回 200 + TweetTombstone，
  // 无正文无媒体——直接往下走会得到空文本的 type=text，前端拿不到视频。
  if (isSyndicationTombstone(json)) {
    return { code: 404, msg: "该推文已删除或不可见，暂无法解析" };
  }

  const authorName = json.user?.name || "";
  const authorScreenName = json.user?.screen_name || "";
  const authorAvatar = json.user?.profile_image_url_https || "";
  const authorId = json.user?.id_str || "";
  // 博主主页链接：screen_name 拼 x.com 首页（前端可点击跳转）；缺 screen_name 时用数字 id 兜底
  const authorUrl = authorScreenName
    ? `https://x.com/${authorScreenName}`
    : authorId
    ? `https://x.com/${authorId}`
    : "";
  // 前端博主卡展示的用户名：优先 @screen_name，缺省时回退数字 id
  const authorHandle = authorScreenName ? `@${authorScreenName}` : authorId;
  // 解码 HTML 实体 + 剔除媒体短链占位（带媒体推文 text 末尾有 t.co 占位符）
  const title = cleanTweetText(json.text || "", json.entities);

  const videos = [];
  const images = [];

  // mediaDetails：一条推文最多可含 4 个媒体（多视频 / 视频+图片混合 / 图集）。
  // 逐个收集而不是取第一个视频就 break：多视频推文能全量下载，混合推文不丢图。
  // 时长字段位于 media.video_info.duration_millis（毫秒），不在 media 顶层。
  const mediaDetails = Array.isArray(json.mediaDetails) ? json.mediaDetails : [];
  for (const media of mediaDetails) {
    const mediaType = media?.type;
    const src = media?.media_url_https || "";
    if (mediaType === "video" || mediaType === "animated_gif") {
      const mp4 = pickBestMp4(media?.video_info?.variants);
      if (!mp4) continue;
      const durationMs = media?.video_info?.duration_millis;
      const durationSec =
        durationMs != null && durationMs > 0
          ? Math.round(Number(durationMs) / 1000)
          : undefined;
      videos.push({
        title: "",
        url: mp4,
        duration: durationSec,
        durationFormat: formatSeconds(durationSec),
        cover: src,
      });
    } else if (mediaType === "photo" && src) {
      images.push(src);
    }
  }

  // 旧结构兜底：部分接口形态 mediaDetails 无视频项，json.video 提供主视频。
  // 顶层 video.durationMs 为毫秒；variants 字段名为 type/src，pickBestMp4 已兼容。
  if (videos.length === 0 && Array.isArray(json.video?.variants)) {
    const mp4 = pickBestMp4(json.video.variants);
    if (mp4) {
      const durationMs = json.video?.durationMs ?? json.video?.duration_millis;
      const durationSec =
        durationMs != null && durationMs > 0
          ? Math.round(Number(durationMs) / 1000)
          : undefined;
      videos.push({
        title: "",
        url: mp4,
        duration: durationSec,
        durationFormat: formatSeconds(durationSec),
        cover: json.video?.poster || "",
      });
    }
  }

  const primary = videos[0];
  const cover = primary?.cover || images[0] || "";
  // 媒体类型语义：有视频 → video；无视频但有图 → image（url 指向第一张原图）；
  // 纯文字 → text（无可下载媒体，前端展示提示而非解析失败）
  const type = videos.length > 0 ? "video" : images.length > 0 ? "image" : "text";
  const created = json.created_at ? Date.parse(json.created_at) : NaN;

  // 官方 syndication 不返回作者简介/粉丝数，用 fxTwitter 补充（失败静默降级为空）
  const authorProfile = await fetchAuthorProfile(tweetId);
  // twimg 直链必须带 ?tag= 签名才可播放（无 tag 请求被 CDN 重置/拒绝）：
  // 用 fxTwitter 同路径的带 tag URL 精确替换 syndication variants 的直链
  const fixTable = authorProfile.videoFixTable || new Map();
  for (const v of videos) {
    if (v?.url) v.url = fixTwimgVideoUrl(v.url, fixTable);
  }

  return {
    code: 200,
    msg: "解析成功",
    data: {
      title,
      author: authorName || authorScreenName,
      avatar: authorAvatar,
      uid: authorHandle,
      authorUrl,
      sign: authorProfile.sign || undefined,
      followerCount: authorProfile.followerCount,
      followingCount: authorProfile.followingCount,
      // 互动统计：官方 syndication 字段优先，缺失时用 fxTwitter 补充
      like: num(json.favorite_count) ?? authorProfile.like,
      retweets: num(json.retweet_count) ?? authorProfile.retweets,
      replies: num(json.reply_count) ?? authorProfile.replies,
      views: num(json.view_count ?? json.impression_count) ?? authorProfile.views,
      cover,
      url: primary?.url || images[0] || "",
      duration: primary?.duration,
      durationFormat: primary?.durationFormat,
      // 多视频（含 GIF）：videos 列表供前端分P切换/下载；单视频留空走 url 主媒体
      videos: videos.length > 1 ? videos : undefined,
      images: images.length > 0 ? images : undefined,
      type,
      time: Number.isFinite(created) ? created : undefined,
    },
  };
}

async function twitterParse(shareUrl) {
  let url = shareUrl;
  if (url.includes("t.co/")) {
    const loc = await getRedirectLocation(url, {
      "User-Agent": DEFAULT_MOBILE_UA,
    });
    if (!loc) {
      return { code: 400, msg: "t.co 短链解析失败" };
    }
    url = loc;
  }

  const tweetId = extractTweetId(url);
  if (!tweetId) {
    return { code: 400, msg: "无法从 URL 提取推文 ID" };
  }
  // 降级 fixer 解析统一走 /2/status/{id}（fxtwitter 主站）、/status/{id}（fxTwitter 备用站）
  // 与 /i/status/{id}（vxtwitter），无需用户名
  return parseVideoId(tweetId);
}

export const GET = createApiHandler(twitterParse);

// 导出纯函数供单元测试使用（不参与对外 API 面）
export {
  buildFxResult,
  buildVxtwitterResult,
  buildVideoFixTable,
  cleanTweetText,
  fetchAuthorProfile,
  firstNonNull,
  fixTwimgVideoUrl,
  isSyndicationTombstone,
  parseViaFixer,
  parseVideoId,
  pickBestMp4,
  pickFxTweet,
  pickVxtweet,
  raceFixerResults,
};
