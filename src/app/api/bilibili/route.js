import { createApiHandler } from "@/lib/api-middleware";
import { logger } from "@/lib/api-utils";
import crypto from "crypto";
import { classifyOpusDetail } from "@/lib/bilibili-opus";
import {
  classifyBiliFailure,
  createBiliCookieGuard,
  createBiliHealthProbe,
} from "@/lib/bilibili-cookie-guard";

export const runtime = "nodejs";

// 从环境变量获取配置
const BILIBILI_USER_AGENT = process.env.BILIBILI_USER_AGENT || 
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.81 Safari/537.36";

// 现代浏览器 UA：部分公开接口（空间信息等）用旧 UA 会被风控拦截（-799 / -401）
const MODERN_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const BILIBILI_COOKIE = process.env.BILIBILI_COOKIE || "";

// —— 简易 Cookie 池 ——
// B站按请求出口 IP + Cookie 决定是否放行：无 Cookie 的数据中心/海外出口 IP
// 直调 api.bilibili.com 常被 WAF 拦成 HTML（<!DOCTYPE ...> 风控页）而非 JSON。
// Node fetch 不会自动保存 Cookie，这里把各响应 set-cookie（buvid3/buvid4 等）
// 累积进池，后续请求统一带上，作为匿名“风控通行证”。
const cookiePool = {};

function absorbSetCookies(response) {
  try {
    const list =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [];
    for (const raw of list) {
      const pair = String(raw).split(";")[0].trim();
      const name = pair.split("=")[0]?.trim();
      if (!name) continue;
      cookiePool[name] = pair;
    }
  } catch {
    // 忽略吸收失败，不影响主流程
  }
}

/** 合并多段 Cookie，同名以最后传入者为准（等价浏览器“最近设置者覆盖”） */
function buildCookieString() {
  const parts = [];
  for (const arg of arguments) {
    if (!arg) continue;
    for (const seg of String(arg).split(";")) {
      const kv = seg.trim();
      if (kv) parts.push(kv);
    }
  }
  const map = {};
  for (const kv of parts) {
    const name = kv.split("=")[0];
    if (name) map[name] = kv;
  }
  return Object.values(map).join("; ");
}

function pooledCookie() {
  return Object.values(cookiePool).join("; ");
}

// B站按请求出口 IP 分配 CDN 节点：海外出口（如本服务器在新加坡）拿到 akamaized.net
// 海外节点，大陆用户浏览器无法播放。直链签名（upsig/uparams）不绑定 host，
// 把海外 host 归一化为国内镜像节点（bilivideo.com）即可在大陆正常播放。
const BILI_CN_HOST = "upos-sz-mirrorbd.bilivideo.com";

function normalizeCdnHost(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith(".akamaized.net")) {
      parsed.hostname = BILI_CN_HOST;
      return parsed.toString();
    }
  } catch (error) {
    logger.error("Error normalizing CDN host:", error.message);
  }
  return url;
}

function cleanUrlParameters(url) {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/$/, "");
    return parsed.toString();
  } catch (error) {
    logger.error("Error cleaning URL:", error.message);
    return url;
  }
}

// B站 API 返回的图片地址（头像 face / 封面 pic）协议不稳定，部分为 http:// 开头，
// 在 https 页面直链会被浏览器「混合内容」拦截导致破图。
// 统一包成站内 /api/image 代理（同源 https 返回，且可兜底图床防盗链），与小红书处理一致。
function proxifyImage(url) {
  if (!url) return "";
  return `/api/image?url=${encodeURIComponent(url)}`;
}

// B站部分无简介视频的 desc 为 "-"（单个连字符）或纯空白，
// 归一化为空串，避免前端展示无意义占位（卡片右侧大片空白）。
function normalizeDesc(desc) {
  if (typeof desc !== "string") return "";
  const t = desc.trim();
  if (!t || t === "-") return "";
  return desc;
}

// —— wbi 签名（B站风控接口需签名，未登录也可获取 UP主获赞等公开数据）——
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

let wbiKeysCache = null;

/** 获取 wbi 签名 keys（nav 接口即使未登录也返回 wbi_img），缓存 1 小时 */
async function getWbiKeys() {
  if (wbiKeysCache && Date.now() - wbiKeysCache.ts < 3600 * 1000) {
    return wbiKeysCache;
  }
  const nav = await bilibiliRequest(
    "https://api.bilibili.com/x/web-interface/nav",
    {}
  );
  const imgUrl = nav?.data?.wbi_img?.img_url || "";
  const subUrl = nav?.data?.wbi_img?.sub_url || "";
  const imgKey = imgUrl.split("/").pop().split(".")[0];
  const subKey = subUrl.split("/").pop().split(".")[0];
  if (!imgKey || !subKey) throw new Error("Failed to get wbi keys");
  wbiKeysCache = { imgKey, subKey, ts: Date.now() };
  return wbiKeysCache;
}

/** 由 64 位原始 key 混出 32 位 mixin key */
function getMixinKey(orig) {
  let s = "";
  for (const i of MIXIN_KEY_ENC_TAB) s += orig[i];
  return s.slice(0, 32);
}

/** 为请求参数追加 wts 与 w_rid，返回完整 query 字符串 */
async function wbiSign(params) {
  const { imgKey, subKey } = await getWbiKeys();
  const mixinKey = getMixinKey(imgKey + subKey);
  const query = [`wts=${Math.round(Date.now() / 1000)}`];
  for (const key of Object.keys(params)) {
    query.push(`${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`);
  }
  query.sort();
  const queryString = query.join("&");
  const wRid = crypto
    .createHash("md5")
    .update(queryString + mixinKey)
    .digest("hex");
  return `${queryString}&w_rid=${wRid}`;
}

async function bilibiliRequest(url, headers = {}) {
  // 无 Cookie 出口被 WAF 拦成 HTML 时，首次请求的 set-cookie 已吸收进池，
  // 用池内 Cookie 自动重试一次即可放行（最多 2 次）。
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          ...headers,
          // 允许调用方指定 UA（如空间信息接口需现代浏览器 UA 规避风控）
          "User-Agent": headers["User-Agent"] || BILIBILI_USER_AGENT,
          // 补齐浏览器请求特征头，降低被风控误判的概率
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          Referer: headers.Referer || "https://www.bilibili.com/",
          // 允许调用方传 Cookie（如拼接 buvid3 规避风控），同名以调用方为准
          Cookie: buildCookieString(
            pooledCookie(),
            BILIBILI_COOKIE,
            headers.Cookie
          ),
        },
        redirect: "follow",
      });
      // 先把 set-cookie（buvid3 等）吸收进池，供重试与后续请求使用
      absorbSetCookies(response);

      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        return await response.json();
      }
      // 非 JSON：多半是 WAF/风控 HTML 页。截取片段便于诊断；首次被拦时重试
      const snippet = (await response.text()).slice(0, 200).replace(/\s+/g, " ");
      logger.warn(
        `bilibili ${new URL(url).pathname} got status=${response.status} ${contentType}: ${snippet}`
      );
      if (attempt === 1) continue;
      return null;
    } catch (error) {
      logger.error(
        `Error making bilibili request (attempt ${attempt}):`,
        error.message
      );
      if (attempt === 1) continue;
      return null;
    }
  }
  return null;
}

// —— BILIBILI_COOKIE 失效自检 ——
// 登录 Cookie 会过期（数月至一年）。配置后若连续命中风控 / nav 探测 isLogin=false，
// 判定失效并告警（只告警一次，任一次成功解析后自动复位），提醒维护者低频更新即可。
// 判定与状态机逻辑抽在 lib/bilibili-cookie-guard（纯逻辑，可单测）。
const hasBiliCookie = Boolean(
  BILIBILI_COOKIE && /SESSDATA=[^;]+/.test(BILIBILI_COOKIE)
);

const biliCookieGuard = createBiliCookieGuard({
  threshold: 5,
  warn: (streak) =>
    logger.warn(
      `[bilibili] BILIBILI_COOKIE 疑似失效：连续 ${streak} 次带 Cookie 请求仍被 B 站风控拦截。` +
        `请登录 bilibili.com（勾选「记住我」延长有效期），复制含 SESSDATA 的完整 Cookie ` +
        `更新环境变量 BILIBILI_COOKIE 后重新部署`
    ),
});

// 显式健康探测：nav 接口的 data.isLogin 精确反映 SESSDATA 是否仍有效（TTL 内缓存）
const probeBiliCookieHealth = createBiliHealthProbe({
  fetchNav: () =>
    bilibiliRequest("https://api.bilibili.com/x/web-interface/nav", {}),
});

/** 获取 buvid3/buvid4（B站公开接口的风控通行证，未登录也返回），模块级缓存 */
let buvidCache = null;
async function getBuvid() {
  if (buvidCache) return buvidCache;
  try {
    const spi = await bilibiliRequest(
      "https://api.bilibili.com/x/frontend/finger/spi",
      {}
    );
    const b3 = spi?.data?.b_3 || "";
    const b4 = spi?.data?.b_4 || "";
    // 写入 Cookie 池，让后续所有接口请求默认携带 buvid 通行证
    if (b3) cookiePool.buvid3 = `buvid3=${b3}`;
    if (b4) cookiePool.buvid4 = `buvid4=${b4}`;
    buvidCache = { b3, b4 };
  } catch {
    buvidCache = { b3: "", b4: "" };
  }
  return buvidCache;
}

async function getBilibiliVideoInfo(url) {
  try {
    const cleanUrl = cleanUrlParameters(url);
    const parsedUrl = new URL(cleanUrl);
    let bvid;
    
    if (parsedUrl.hostname === "b23.tv") {
      const response = await fetch(url, { redirect: "follow" });
      const redirectUrl = new URL(response.url);
      bvid = redirectUrl.pathname;
    } else if (
      parsedUrl.hostname === "www.bilibili.com" ||
      parsedUrl.hostname === "m.bilibili.com"
    ) {
      bvid = parsedUrl.pathname;
    } else {
      return { code: -1, msg: "视频链接好像不太对！" };
    }
    
    // 图文动态（/opus/<id>）：先于视频校验分流；非纯图文类型（专栏文章/视频动态等）
    // 由 classifyOpusDetail 给出针对性提示
    const opusMatch = bvid.match(/\/(?:opus|dynamic)\/(\d+)/);
    if (opusMatch) {
      return parseBilibiliOpus(url, opusMatch[1]);
    }

    if (!bvid.includes("/video/")) {
      return { code: -1, msg: "好像不是视频链接" };
    }
    
    // 提取 BV 号：b23.tv 重定向后 pathname 形如 /video/BV1sK826SENY/（带尾斜杠），
    // 简单地 replace("/video/","") 会残留 "/" 导致 B站 API 返回 code=-400 请求错误
    // （2026-08-25 实测：BV1sK826SENY/ → -400，BV1sK826SENY → 0 OK）。
    const bvidMatch = bvid.match(/\/(video|bilibili)\/([A-Za-z0-9_]+)\/?/);
    bvid = (bvidMatch ? bvidMatch[2] : bvid).replace(/\/+$/, "");
    logger.log("Processing bilibili video, bvid:", bvid);
    
    const headers = { "Content-Type": "application/json;charset=UTF-8" };
    
    // 数据中心/海外出口无 Cookie 直调 view 接口常被 WAF 拦成 HTML，
    // 先取 spi 的 buvid 写入 Cookie 池，再请求视频信息。
    await getBuvid();

    // 获取视频信息
    const videoInfo = await bilibiliRequest(
      `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
      headers
    );
    
    if (!videoInfo || videoInfo.code !== 0) {
      logger.warn("Failed to fetch video info, response:", videoInfo);
      // 按原因分级提示：区分「服务器没配 Cookie / Cookie 失效 / 视频不存在 /
      // 其它失败」，让访问者知道该稍后重试还是联系站长，站长能一眼定位该换 Cookie
      const failure = classifyBiliFailure({
        cookieConfigured: hasBiliCookie,
        jsonCode: videoInfo ? videoInfo.code : null,
      });
      let msg = failure.msg;
      if (failure.cookieStale) {
        // 已配 Cookie 仍被风控：用 nav 的 isLogin 精确判定是否 Cookie 已过期，
        // 能确认失效时给出明确提示并告警一次（而非含糊的「请稍后重试」）
        const health = await probeBiliCookieHealth();
        if (health && health.ok === false) {
          msg = "B站解析失败：服务器 Cookie 已失效，请稍后重试";
          logger.warn(
            "[bilibili] BILIBILI_COOKIE 已失效（nav isLogin=false）：请登录 bilibili.com（勾选「记住我」）复制含 SESSDATA 的完整 Cookie 更新环境变量 BILIBILI_COOKIE"
          );
        }
        biliCookieGuard.note({
          configured: hasBiliCookie,
          succeeded: false,
          challenged: true,
        });
      }
      return { code: 0, msg };
    }
    
    // 并行获取所有分P的播放地址（含各清晰度直链）
    const playUrlPromises = videoInfo.data.pages.map(async (page) => {
      const playUrlBase = `https://api.bilibili.com/x/player/playurl?otype=json&fnver=0&fnval=3&player=3&qn=112&bvid=${bvid}&cid=${page.cid}&platform=html5&high_quality=1`;
      const playUrl = await bilibiliRequest(playUrlBase, headers);

      if (!playUrl || !playUrl.data?.durl?.[0]?.url) return null;

      // 可用清晰度：accept_quality（如 [64,16]）与 accept_description 一一对应
      const qualityIds = Array.isArray(playUrl.data.accept_quality)
        ? playUrl.data.accept_quality
        : [playUrl.data.quality ?? 64];
      const descByQuality = {};
      (playUrl.data.accept_quality || []).forEach((q, i) => {
        descByQuality[q] = playUrl.data.accept_description?.[i] || `${q}P`;
      });

      // 逐档请求拿对应直链（无大会员时多档会返回相同 url，去重后保留高档描述）
      const qualityResponses = await Promise.all(
        qualityIds.map((qn) =>
          bilibiliRequest(playUrlBase.replace("qn=112", `qn=${qn}`), headers)
        )
      );
      const qualities = [];
      const seenUrls = new Set();
      for (let i = 0; i < qualityIds.length; i++) {
        const qn = qualityIds[i];
        const resp = qualityResponses[i];
        if (resp && resp.data?.durl?.[0]?.url) {
          const url = normalizeCdnHost(resp.data.durl[0].url);
          if (!seenUrls.has(url)) {
            seenUrls.add(url);
            qualities.push({
              quality: qn,
              label: descByQuality[qn] || `${qn}P`,
              url,
            });
          }
        }
      }

      // 主直链取最高可用清晰度（与历史行为一致，供卡片内嵌播放）
      const video_url =
        qualities[0]?.url || normalizeCdnHost(playUrl.data.durl[0].url);

      return {
        title: page.part,
        duration: page.duration,
        durationFormat: new Date((page.duration - 1) * 1000)
          .toISOString()
          .substr(11, 8),
        // 分P封面：B站分P 封面可能为空，回退到视频总封面
        pic: page.pic ? proxifyImage(page.pic) : proxifyImage(videoInfo.data.pic),
        accept: playUrl.data.accept_description,
        video_url,
        qualities,
      };
    });
    
    const bilijson = (await Promise.all(playUrlPromises)).filter(Boolean);
    
    logger.log("Successfully parsed bilibili video, pages:", bilijson.length);

    // 带 Cookie 解析成功 → 出口可用，复位失效告警计数（见 biliCookieGuard）
    biliCookieGuard.note({
      configured: hasBiliCookie,
      succeeded: true,
      challenged: false,
    });

    // UP主主页公开统计：关注 / 粉丝 / 获赞 / 简介（接口可能被风控或需登录，失败不影响主流程）
    const mid = videoInfo.data.owner.mid;
    const upStats = await fetchBilibiliUpStats(mid);

    return {
      code: 1,
      msg: "解析成功！",
      title: videoInfo.data.title,
      imgurl: proxifyImage(videoInfo.data.pic),
      desc: normalizeDesc(videoInfo.data.desc),
      // 元数据：发布时间(unix秒) / 总时长(毫秒) / 分区 / 版权(1自制2转载) / 互动统计 / UID
      pubdate: videoInfo.data.pubdate,
      duration: videoInfo.data.duration * 1000,
      tname: videoInfo.data.tname,
      copyright: videoInfo.data.copyright,
      stat: videoInfo.data.stat || {},
      data: bilijson,
      user: {
        name: videoInfo.data.owner.name,
        user_img: proxifyImage(videoInfo.data.owner.face),
        sign: upStats.sign || videoInfo.data.owner.sign || "",
        uid: videoInfo.data.owner.mid,
        // UP主主页链接：由 mid 拼 space 首页（前端可点击跳转）
        authorUrl: `https://space.bilibili.com/${mid}`,
        followingCount: upStats.followingCount,
        followerCount: upStats.followerCount,
        totalFavorited: upStats.totalFavorited,
      },
    };
  } catch (error) {
    logger.error("Error parsing bilibili video:", error.message);
    return { code: 0, msg: "解析失败！" };
  }
}

/**
 * UP主主页公开统计：关注 / 粉丝 / 获赞 / 简介（空间首页公开数据，匿名可获取）。
 * 接口可能被风控或需登录，静默失败不影响主流程（返回空对象，缺失字段前端自动隐藏）。
 * 网页端「用户卡片」接口：wbi + buvid 即可匿名返回 card.sign（UP主简介）/
 * follower（粉丝）/ like_num（获赞），是空间页首屏数据源，对访客最宽容；
 * 而 space/wbi/acc/info 自 2026 年起对访客普遍返回 -352，仅作简介兜底。
 * 供视频解析与图文动态（/opus/）解析共用。
 */
async function fetchBilibiliUpStats(mid) {
  const stats = {};
  try {
    // 带上 buvid 通行证（部分出口 IP 无 cookie 直调会被 -352 风控拦截）
    const { b3, b4 } = await getBuvid();
    const upCookie = [BILIBILI_COOKIE, `buvid3=${b3}`, `buvid4=${b4}`]
      .filter(Boolean)
      .join("; ");
    const headers = { "Content-Type": "application/json;charset=UTF-8" };
    const signedCardQuery = await wbiSign({ mid }).catch(() => "");
    const cardUrl = signedCardQuery
      ? `https://api.bilibili.com/x/web-interface/card?${signedCardQuery}`
      : `https://api.bilibili.com/x/web-interface/card?mid=${mid}`;
    const [relationStat, cardInfo, legacySpaceInfo] = await Promise.allSettled([
      bilibiliRequest(
        `https://api.bilibili.com/x/relation/stat?vmid=${mid}`,
        headers
      ),
      bilibiliRequest(cardUrl, {
        Cookie: upCookie,
        "User-Agent": MODERN_USER_AGENT,
      }),
      // 空间旧接口：部分出口（如家宽 IP）无需 wbi 也能返回 sign，作为简介兜底
      bilibiliRequest(
        `https://api.bilibili.com/x/space/acc/info?mid=${mid}`,
        {
          "User-Agent": MODERN_USER_AGENT,
          Referer: `https://space.bilibili.com/${mid}`,
          Origin: "https://space.bilibili.com",
        }
      ),
    ]);
    if (relationStat.status === "fulfilled" && relationStat.value?.code === 0) {
      stats.followingCount = relationStat.value.data.following;
      stats.followerCount = relationStat.value.data.follower;
    }
    if (cardInfo.status === "fulfilled" && cardInfo.value?.code === 0) {
      const cardData = cardInfo.value.data || {};
      stats.sign = cardData.card?.sign || "";
      stats.totalFavorited = cardData.like_num;
      // card 的粉丝数兜底（relation/stat 被风控时仍可展示）
      if (stats.followerCount == null && typeof cardData.follower === "number") {
        stats.followerCount = cardData.follower;
      }
    }
    // legacy 空间接口返回简介时覆盖（个别出口 card 被拦但该接口可用）
    if (
      legacySpaceInfo.status === "fulfilled" &&
      legacySpaceInfo.value?.code === 0 &&
      legacySpaceInfo.value?.data?.sign
    ) {
      stats.sign = legacySpaceInfo.value.data.sign;
    }
  } catch (error) {
    logger.error("Failed to fetch up stats:", error.message);
  }
  return stats;
}

/**
 * 图文动态（/opus/<id>）解析：detail 接口无 cookie 即可访问（带上 buvid 通行证更稳）。
 * 纯图文返回统一契约 { code:200, data:{ type:"image", ... } }，
 * 走 normalizeResult 通用分支透传（不新增特例）；非纯图文返回 code:0 + 明确 msg。
 */
async function parseBilibiliOpus(url, opusId) {
  try {
    // 数据中心/海外出口无 Cookie 直调会被 WAF 拦成 HTML，先取 buvid 写入 Cookie 池
    await getBuvid();
    // detail 接口对旧 UA 会被风控拦截（-352），与现代浏览器 UA 放行（与下方空间接口同源）
    const headers = {
      "Content-Type": "application/json;charset=UTF-8",
      "User-Agent": MODERN_USER_AGENT,
    };
    const detail = await bilibiliRequest(
      `https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=${opusId}&features=itemOpusStyle`,
      headers
    );
    if (!detail || detail.code !== 0 || !detail.data?.item) {
      logger.warn("Failed to fetch opus detail, response:", detail);
      // 非 JSON（WAF 拦截）且带 Cookie → 记入连续失败，辅助 Cookie 失效自检
      if (!detail) {
        biliCookieGuard.note({
          configured: hasBiliCookie,
          succeeded: false,
          challenged: true,
        });
      }
      return { code: 0, msg: "解析失败！" };
    }
    const outcome = classifyOpusDetail(detail);
    if (!outcome.ok) return { code: 0, msg: outcome.msg };
    const data = outcome.data;
    // UP主主页公开统计与简介：detail 接口仅给 mid/name/face，粉丝/关注/获赞/简介
    // 需补调空间公开接口（匿名可获取；被风控时静默失败，缺失字段前端自动隐藏）。
    // 平铺进 data 与视频解析归一化后的 ParseData 字段对齐（author/sign/followingCount/...）
    const upStats = await fetchBilibiliUpStats(data.authorId);
    data.sign = upStats.sign || undefined;
    data.followingCount = upStats.followingCount;
    data.followerCount = upStats.followerCount;
    data.totalFavorited = upStats.totalFavorited;
    logger.log(`Successfully parsed bilibili opus ${opusId}, images: ${data.images.length}`);
    // 带 Cookie 解析成功 → 复位失效告警计数（图文与视频共享同一出口状态）
    biliCookieGuard.note({
      configured: hasBiliCookie,
      succeeded: true,
      challenged: false,
    });
    return { code: 200, msg: "解析成功！", data };
  } catch (error) {
    logger.error("Error parsing bilibili opus:", error.message);
    return { code: 0, msg: "解析失败！" };
  }
}

export const GET = createApiHandler(getBilibiliVideoInfo, {
  shouldCache: false,
  responseHeaders: {
    "Cache-Control": "no-store, no-cache, must-revalidate",
  },
});
