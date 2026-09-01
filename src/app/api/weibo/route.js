import { createApiHandler } from "@/lib/api-middleware";

export const runtime = "nodejs";

/**
 * 微博视频解析（游客模式，无需登录 Cookie）
 *
 * 背景：2026-08 起微博对无 Cookie 的服务端请求全部 302 到登录墙（passport.weibo.com），
 * 旧实现依赖环境变量 WEIBO_COOKIE，未配置时 component 接口拿不到数据 → 全量解析失败。
 *
 * 2026-08-27 修复：旧版「a=enter 一次性下发 Cookie」已失效（现在返回需要执行 JS 指纹的 HTML 页面）。
 * 新版访客流程（与新浪访客系统 JS 一致，weiboSpider 等开源爬虫同款）：
 *  1. POST /visitor/genvisitor 上报伪指纹 → 拿 tid；
 *  2. GET  /visitor/visitor?a=incarnate&t={tid}&w=2&c=100 → 拿 SUB/SUBP 访客 Cookie；
 *  3. 用访客 Cookie + X-Requested-With 请求 m.weibo.cn 公开 JSON（page_info.media_url 即视频直链）；
 *  4. 失败降级 → 访客 Cookie + 旧 tv/api/component。
 *
 * 游客 Cookie 运行时获取并模块级缓存（约 25 分钟），不读环境变量、无持久化。
 */

const UA_MOBILE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";
const UA_DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const TIMEOUT_MS = 8000;

/** 访客 Cookie 模块级缓存（SUB 有效期较长，避免每次解析都跑两趟访客流程） */
let visitorCookieCache = "";
let visitorCookieExpireAt = 0;
const VISITOR_COOKIE_TTL_MS = 25 * 60 * 1000;

/** 微博字符型 mid 的 base62 字符表（数字+小写+大写） */
const MID_BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * 字符型 mid（如 "RfXp5BMsF"）→ 数字 mid（16 位十进制，如 "5336206955708503"）。
 * 微博编码规则：数字 mid 从右往左每 7 位一组 → base62 4 字符；
 * 解码则反向：字符 mid 从右往左每 4 字符一组 → 十进制，除最左组外每组补零到 7 位。
 */
function url2mid(urlMid) {
  if (!urlMid) return "";
  const groups = [];
  for (let i = urlMid.length - 4; i > -4; i -= 4) {
    const start = i > 0 ? i : 0;
    const len = i > 0 ? 4 : i + 4;
    const seg = urlMid.substring(start, start + len);
    let n = 0;
    for (let k = 0; k < seg.length; k++) {
      const idx = MID_BASE62.indexOf(seg[k]);
      if (idx < 0) return ""; // 含非法字符
      n = n * 62 + idx;
    }
    groups.unshift(String(n).padStart(7, "0"));
  }
  // 去掉最左组的前导 0，得到数字 mid
  return groups.join("").replace(/^0+/, "");
}

/**
 * 从各种微博分享链接形态中提取视频 oid（形如 "1034:5336206955708503"）。
 * 支持：tv/show/{id}、show?fid={id}、video.weibo.com/show、纯数字等。
 */
function extractId(rawUrl) {
  let id = null;
  if (rawUrl.includes("show?fid=")) {
    const m = rawUrl.match(/fid=([^&]+)/);
    id = m ? m[1] : null;
  } else if (rawUrl.includes("tv/show/")) {
    const m = rawUrl.match(/tv\/show\/([^?&/]+)/);
    id = m ? m[1] : null;
  } else {
    const m = rawUrl.match(/\d+\:\d+/);
    id = m ? m[0] : null;
  }
  // 兜底：weibo.com/{uid}/{mid} 详情页，取 16 位纯数字 mid
  if (!id) {
    const m = rawUrl.match(/(\d{16})/);
    id = m ? m[1] : null;
  }
  // 字符型 mid：weibo.com/{uid}/{mid}（如 RfXp5BMsF），先转成数字 mid
  if (!id) {
    const m = rawUrl.match(/weibo\.com\/\d+\/([A-Za-z0-9]{5,16})/);
    if (m) {
      id = url2mid(m[1]) || m[1];
    }
  }
  return id ? decodeURIComponent(id) : null;
}

/**
 * 获取微博游客通行凭据（SUB/SUBP）。两段式：
 *  1) POST /visitor/genvisitor 上报伪指纹拿 tid；
 *  2) GET  /visitor/visitor?a=incarnate&t={tid}&w=2&c=100 拿 SUB。
 * 结果模块级缓存约 25 分钟。
 */
async function getVisitorCookie() {
  if (visitorCookieCache && Date.now() < visitorCookieExpireAt) {
    return visitorCookieCache;
  }
  try {
    // 1) genvisitor：上报伪设备指纹，换取 tid
    const fpBody =
      'cb=gen_callback&fp={"os":"1","browser":"Safari16","fonts":"undefined","screen":"*","plugins":""}';
    const res1 = await fetch("https://visitor.passport.weibo.cn/visitor/genvisitor", {
      method: "POST",
      headers: {
        "User-Agent": UA_MOBILE,
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: "https://m.weibo.cn/",
      },
      body: fpBody,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text1 = await res1.text();
    const tid = text1.match(/"tid":"([^"]+)"/)?.[1];
    if (!tid) return "";

    // 2) incarnate：tid 换取 SUB/SUBP 访客 Cookie
    const res2 = await fetch(
      `https://visitor.passport.weibo.cn/visitor/visitor?a=incarnate&t=${encodeURIComponent(
        tid
      )}&w=2&c=100&gc=&cb=cross_domain&from=weibo&_rand=${Math.random()}`,
      {
        headers: { "User-Agent": UA_MOBILE, Referer: "https://m.weibo.cn/" },
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }
    );
    const text2 = await res2.text();
    const sub = text2.match(/"sub":"([^"]+)"/)?.[1];
    const subp = text2.match(/"subp":"([^"]+)"/)?.[1];
    if (!sub) {
      console.log(`[weibo] visitor cookie failed: stage2 status=${res2.status} no SUB`);
      return "";
    }

    const cookie = `SUB=${sub}${subp ? `; SUBP=${subp}` : ""}`;
    visitorCookieCache = cookie;
    visitorCookieExpireAt = Date.now() + VISITOR_COOKIE_TTL_MS;
    console.log(`[weibo] visitor cookie ok (SUB acquired, cached ${VISITOR_COOKIE_TTL_MS / 60000}min)`);
    return cookie;
  } catch (e) {
    console.log(`[weibo] visitor cookie error: ${e?.message || e}`);
    return "";
  }
}

/**
 * 通用 JSON 请求。label 非空时打印生产可见诊断日志（Vercel 等无本地控制台的环境
 * 也能从函数日志定位是哪一步失败：访客 Cookie / component / m.weibo.cn）。
 */
async function fetchJson(url, options = {}, label = "") {
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        "User-Agent": UA_DESKTOP,
        ...(options.headers || {}),
      },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ct = res.headers.get("content-type") || "";
    if (label) console.log(`[weibo] ${label} status=${res.status} ct=${ct.split(";")[0]}`);
    if (!res.ok && !ct.includes("json")) return null;
    const json = await res.json();
    if (label) console.log(`[weibo] ${label} json keys=[${Object.keys(json).join(", ")}]`);
    return json;
  } catch (e) {
    if (label) console.log(`[weibo] ${label} error=${e?.message || e}`);
    return null;
  }
}

/** 规范化微博 CDN 链接（"//xxx" → "https://xxx"） */
function normalizeUrl(u) {
  if (!u) return "";
  return u.startsWith("//") ? `https:${u}` : u;
}

/**
 * 微博计数归一化：兼容数字 / 数字字符串 / 中文单位字符串（"32.1万"、"1.2亿"）。
 * m.weibo.cn 接口对较大的关注/粉丝/互动数会返回带单位的字符串，
 * 直接 Number() 得到 NaN，导致前端按 0 处理隐藏该行。
 */
function parseCount(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v).trim();
  const w = /^([\d.]+)\s*万$/.exec(s);
  if (w) return parseFloat(w[1]) * 10000;
  const y = /^([\d.]+)\s*亿$/.exec(s);
  if (y) return parseFloat(y[1]) * 100000000;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/** 微博图 URL 统一放大尺寸（缩略图 → 原图） */
function normalizeImageUrl(u) {
  const url = normalizeUrl(u);
  if (!url) return "";
  // sinaimg 的尺寸标识：thumb150/bmiddle/orj360 替换为 large（原图）
  return url
    .replace(/\/thumb150\//, "/large/")
    .replace(/\/bmiddle\//, "/large/")
    .replace(/\/orj360\//, "/large/");
}

/** 从 page_info 提取视频直链（media_url / media_info 多级降级，兼容单视频与多视频数组元素） */
function pickMediaUrl(pi) {
  if (!pi) return "";
  const media = pi.media_info || {};
  return (
    pi.media_url ||
    media.stream_url_hd ||
    media.stream_url ||
    media.mp4_hd_url ||
    media.mp4_720p_mp4 ||
    media.mp4_hd_mp4 ||
    media.mp4_ld_mp4 ||
    media.mp4_url ||
    media.mp4_sd_url ||
    media.hd_url ||
    media.ld_url ||
    media.origin_url ||
    ""
  );
}

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

/** 从 mblog 对象提取图片列表（pics[].large.url，兼容字符串项；过滤视频项） */
function extractImagesFromMblog(mblog) {
  if (!Array.isArray(mblog?.pics)) return [];
  const images = [];
  for (const p of mblog.pics) {
    // 多视频帖的每个分P是 pics 里的视频项（type=video + videoSrc 直链），不是图集内容
    if (p?.type === "video" || p?.videoSrc) continue;
    const raw =
      (typeof p === "string" ? p : "") ||
      p?.large?.url ||
      p?.url ||
      "";
    const url = normalizeImageUrl(raw);
    if (url) images.push(url);
  }
  return images;
}

/**
 * 从 mblog 提取视频列表。
 * 多视频帖：每个分P都在 pics 里（type=video + videoSrc 直链），逐个提取；
 * pics 无视频时（图文混排单视频 / 纯单视频），用 page_info 兜底
 * （page_info 仅含主视频且 URL 与 pics[0] 同视频但清晰度不同，不能简单按 URL 去重合并）。
 */
function extractVideosFromMblog(mblog) {
  const videos = [];
  // 1) pics 视频项：多视频帖的所有分P（含主视频）都在这里
  for (const p of Array.isArray(mblog?.pics) ? mblog.pics : []) {
    const videoSrc = normalizeUrl(p?.videoSrc || "");
    if (!videoSrc) continue;
    const coverUrl = normalizeImageUrl(p?.large?.url || p?.url || "");
    videos.push({
      title: "",
      url: videoSrc,
      duration: p?.duration ? Number(p.duration) : undefined,
      durationFormat: formatSeconds(p?.duration),
      cover: proxifyImage(coverUrl),
    });
  }
  // 2) page_info 兜底：pics 无视频项时，提取 page_info 主视频（兼容对象/数组）
  if (videos.length === 0) {
    const pageInfos = Array.isArray(mblog?.page_info)
      ? mblog.page_info
      : mblog?.page_info
        ? [mblog.page_info]
        : [];
    for (const pi of pageInfos) {
      const mediaUrl = normalizeUrl(pickMediaUrl(pi));
      if (!mediaUrl) continue;
      const media = pi.media_info || {};
      const coverUrl = normalizeImageUrl(media.poster || pi.page_pic?.url || "");
      videos.push({
        title: (pi.content1 || pi.title || "").trim(),
        url: mediaUrl,
        duration: media.duration ? Number(media.duration) : undefined,
        durationFormat: formatSeconds(media.duration),
        cover: proxifyImage(coverUrl),
      });
    }
  }
  return videos;
}

/**
 * 新浪图片去重键：sinaimg 同一张图会以多种尺寸标识出现
 * （thumb150 / bmiddle / orj360 / orj480 / large），文件名相同。
 * 取 URL 最后一段文件名（小写）作为比较键，跨尺寸识别同一张图。
 */
function sinaImageKey(u) {
  const url = normalizeUrl(u);
  if (!url) return "";
  const m = /\/[^/]+\.(?:jpe?g|png|gif|webp)$/i.exec(url);
  return m ? m[0].toLowerCase() : url.toLowerCase();
}

/**
 * 把第三方图片 URL 包成站内代理路径，绕过 Referer 防盗链。
 * 微博图床（sinaimg / weibocdn）在 https 页面直链加载会 403，
 * /api/image 代理会带 Referer: weibo.com 回源（与小红书/B站/快手处理一致）。
 */
function proxifyImage(url) {
  if (!url) return "";
  return `/api/image?url=${encodeURIComponent(url)}`;
}

/** 从站内图片代理路径还原原始 URL（封面去重 / 兜底回源时需要） */
function decodeProxiedUrl(u) {
  const prefix = "/api/image?url=";
  return typeof u === "string" && u.startsWith(prefix)
    ? decodeURIComponent(u.slice(prefix.length))
    : u;
}

/**
 * 从 m.weibo.cn 详情 JSON 提取微博信息（statuses/show 的 data 即 mblog 对象）。
 * 按媒体类型返回：
 *  - 有视频直链 → type: video（url/cover）
 *  - 无视频但有图片 → type: image（images 图集 + url/cover 指向第一张）
 *  - 仅有文字 → type: text（无媒体字段，前端展示提示）
 */
function extractFromMWeibo(json) {
  const mblog = json?.data?.mblog || json?.data || null;
  if (!mblog) return null;
  const text = (mblog.text || "").replace(/<[^>]+>/g, "").trim();
  const title = text.slice(0, 120);
  const user = mblog.user || {};
  const author = user.screen_name || "";
  // 头像走站内代理：sinaimg 直链在 https 页面加载会 403（防盗链）
  const avatar = proxifyImage(
    normalizeUrl(
      user.avatar_large ||
        user.avatar_hd ||
        user.profile_image_url ||
        ""
    )
  );
  const time = mblog.created_at || "";
  // 博主主页公开信息（对齐小红书博主卡：可点主页 + 简介 + 关注/粉丝）
  const uid = String(user.idstr || user.id || "");
  const authorUrl = uid ? `https://weibo.com/u/${uid}` : "";
  const sign = user.description || "";
  const followingCount = parseCount(user.follow_count);
  const followerCount = parseCount(user.followers_count);
  // 微博互动统计（对齐小红书信息面板：点赞/评论/转发）
  const like = parseCount(mblog.attitudes_count);
  const reply = parseCount(mblog.comments_count);
  const share = parseCount(mblog.reposts_count);
  const base = {
    title,
    desc: text,
    author,
    authorId: uid,
    authorUrl,
    sign,
    followingCount,
    followerCount,
    avatar,
    time,
    like,
    reply,
    share,
  };

  // 1) 视频：多视频帖每个分P在 pics 里（type=video + videoSrc 直链），
  //    page_info 仅为主视频，pics 有视频项即优先（其 URL 与 pics[0] 同视频但清晰度不同）。
  //    图集 = pics 中非视频项；各视频封面（同文件不同尺寸标识）再按文件名剔除，防止残留。
  const videoItems = extractVideosFromMblog(mblog);
  if (videoItems.length > 0) {
    const videoCoverKeys = new Set();
    for (const v of videoItems) {
      const k = sinaImageKey(decodeProxiedUrl(v.cover || ""));
      if (k) videoCoverKeys.add(k);
    }
    const images = extractImagesFromMblog(mblog)
      .filter((u) => {
        const k = sinaImageKey(u);
        return !k || !videoCoverKeys.has(k);
      })
      .map(proxifyImage);
    const first = videoItems[0];
    return {
      ...base,
      cover: first.cover,
      url: first.url,
      images: images.length > 0 ? images : undefined,
      videos: videoItems.length > 1 ? videoItems : undefined,
      type: "video",
    };
  }

  // 2) 图片：mblog.pics 图集（返回时统一包成站内代理，绕过 sinaimg 防盗链）
  const images = extractImagesFromMblog(mblog).map(proxifyImage);
  if (images.length > 0) {
    return {
      ...base,
      cover: images[0],
      url: images[0],
      images,
      type: "image",
    };
  }

  // 3) 纯文字：无媒体，仅返回元数据
  return { ...base, type: "text" };
}

/** 按清晰度优先级从 component urls 里选直链 */
const QUALITY_ORDER = [
  "超清 2K",
  "超清 1080P",
  "高清 1080P",
  "蓝光",
  "高清 720P",
  "标清 480P",
  "标清",
  "流畅",
];

/** 从官方 tv/api/component 响应提取视频信息（带游客凭据）；同时返回 mid 供二次补全元数据 */
function extractFromComponent(json) {
  const data = json?.data?.Component_Play_Playinfo;
  if (!data || !data.urls) return null;
  const entries = Object.entries(data.urls);
  if (!entries.length) return null;
  let picked = entries[0];
  for (const q of QUALITY_ORDER) {
    const hit = entries.find(([label]) => label.includes(q));
    if (hit) {
      picked = hit;
      break;
    }
  }
  const url = normalizeUrl(picked[1]);
  if (!url) return null;
  return {
    title: (data.title || "").trim(),
    cover: proxifyImage(normalizeUrl(data.cover_image || "")),
    author: data.author || data.nickname || "",
    avatar: proxifyImage(normalizeUrl(data.avatar || "")),
    time: data.real_date ? new Date(Number(data.real_date) * 1000).toISOString() : "",
    url,
    mid: data.mid ? String(data.mid) : "",
    type: "video",
  };
}

async function weibo(url) {
  const id = extractId(url);
  if (!id) return null;

  // 游客凭据（自动获取，无需配置）
  const cookie = await getVisitorCookie();

  // 1) 官方 tv/api/component（oid=fid）：唯一能把 fid（1034:xxx）映射到微博的公开接口，
  //    返回多清晰度直链 + mid（真实 status id）。
  const cJson = await fetchJson(
    `https://weibo.com/tv/api/component?page=/tv/show/${encodeURIComponent(id)}`,
    {
      method: "POST",
      headers: {
        Cookie: cookie,
        Referer: `https://weibo.com/tv/show/${id}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": UA_DESKTOP,
        "X-Requested-With": "XMLHttpRequest",
      },
      body: `data=${encodeURIComponent(
        `{"Component_Play_Playinfo":{"oid":"${id}"}}`
      )}`,
    },
    "component"
  );
  const fromC = extractFromComponent(cJson);
  if (fromC && fromC.url) {
    // 2) 用 mid 再查 m.weibo.cn 详情，补全标题（正文）、头像、时间等元数据
    let meta = fromC;
    if (fromC.mid) {
      const mJson = await fetchJson(
        `https://m.weibo.cn/statuses/show?id=${encodeURIComponent(fromC.mid)}`,
        {
          headers: {
            "User-Agent": UA_MOBILE,
            Cookie: cookie,
            Referer: "https://m.weibo.cn/",
            "X-Requested-With": "XMLHttpRequest",
            "MWeibo-Pwa": "1",
            Accept: "application/json, text/plain, */*",
          },
        },
        "mweibo-meta"
      );
      const fromM = extractFromMWeibo(mJson);
      if (fromM) {
        // 视频场景：url/type 以 component 结果为准（fromM 可能因无视频被归类为 image/text）
        // 图集若包含视频封面（component 主视频封面 + 多视频各分P封面），按文件名一并剔除。
        // 注意：此时封面 / fromM.images 均已包成代理路径，先解码还原原始 URL 再比较。
        const videoCoverKeys = new Set();
        const firstKey = sinaImageKey(decodeProxiedUrl(fromC.cover));
        if (firstKey) videoCoverKeys.add(firstKey);
        for (const v of Array.isArray(fromM.videos) ? fromM.videos : []) {
          const k = sinaImageKey(decodeProxiedUrl(v?.cover || ""));
          if (k) videoCoverKeys.add(k);
        }
        const images = Array.isArray(fromM.images)
          ? fromM.images.filter((u) => {
              const k = sinaImageKey(decodeProxiedUrl(u));
              return !k || !videoCoverKeys.has(k);
            })
          : undefined;
        meta = {
          ...fromC,
          ...fromM,
          url: fromC.url,
          type: "video",
          images: images && images.length > 0 ? images : undefined,
          videos:
            Array.isArray(fromM.videos) && fromM.videos.length > 1
              ? fromM.videos
              : undefined,
        };
      }
    }
    // 剔除 mid 字段（避免冗余，且不在响应中暴露微博内部 id）
    const data = { ...meta };
    delete data.mid;
    return { code: 200, msg: "解析成功", data };
  }

  // 3) 降级：m.weibo.cn 单条详情（id 可能本身是 status mid，如 layerid / weibo.com/{uid}/{mid} 链接）
  //    注意：必须带 X-Requested-With 等 H5 头，否则返回 HTML 错误页而非 JSON
  const uid = id.includes(":") ? id.split(":")[1] : id;
  const mJson = await fetchJson(`https://m.weibo.cn/statuses/show?id=${encodeURIComponent(uid)}`, {
    headers: {
      "User-Agent": UA_MOBILE,
      Cookie: cookie,
      Referer: "https://m.weibo.cn/",
      "X-Requested-With": "XMLHttpRequest",
      "MWeibo-Pwa": "1",
      Accept: "application/json, text/plain, */*",
    },
  }, "mweibo-fallback");
  const fromM = extractFromMWeibo(mJson);
  // 视频 / 图片 / 纯文字微博都算解析成功（data.type 区分媒体类型），
  // 只有完全拿不到内容时才走 null → 外层统一报「解析失败」
  if (fromM) {
    return { code: 200, msg: "解析成功", data: fromM };
  }

  return null;
}

export const GET = createApiHandler(weibo);