import { createApiHandler } from "@/lib/api-middleware";
import { logger } from "@/lib/api-utils";
import crypto from "crypto";

export const runtime = "nodejs";

// 从环境变量获取配置
const BILIBILI_USER_AGENT = process.env.BILIBILI_USER_AGENT || 
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.81 Safari/537.36";

// 现代浏览器 UA：部分公开接口（空间信息等）用旧 UA 会被风控拦截（-799 / -401）
const MODERN_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const BILIBILI_COOKIE = process.env.BILIBILI_COOKIE || "";

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

async function bilibiliRequest(url, headers) {
  try {
    const response = await fetch(url, {
      headers: {
        ...headers,
        // 允许调用方指定 UA（如空间信息接口需现代浏览器 UA 规避风控）
        "User-Agent": headers["User-Agent"] || BILIBILI_USER_AGENT,
        // 允许调用方传 Cookie（如拼接 buvid3 规避风控），缺省用环境变量
        Cookie: headers.Cookie || BILIBILI_COOKIE,
      },
    });
    return await response.json();
  } catch (error) {
    logger.error("Error making bilibili request:", error.message);
    return null;
  }
}

/** 获取 buvid3/buvid4（B站公开接口的风控通行证，未登录也返回），模块级缓存 */
let buvidCache = null;
async function getBuvid() {
  if (buvidCache) return buvidCache;
  try {
    const spi = await bilibiliRequest(
      "https://api.bilibili.com/x/frontend/finger/spi",
      {}
    );
    buvidCache = {
      b3: spi?.data?.b_3 || "",
      b4: spi?.data?.b_4 || "",
    };
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
    
    // 获取视频信息
    const videoInfo = await bilibiliRequest(
      `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
      headers
    );
    
    if (!videoInfo || videoInfo.code !== 0) {
      logger.warn("Failed to fetch video info, response:", videoInfo);
      return { code: 0, msg: "解析失败！" };
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
    
    // UP主主页公开统计：关注 / 粉丝 / 获赞（接口可能被风控或需登录，失败不影响主流程）
    const mid = videoInfo.data.owner.mid;
    let followingCount, followerCount, totalFavorited, upSign = "";
    try {
      // 获赞数接口需 wbi 签名（未签名直调被风控拦截），签名失败则跳过该项
      const signedAccQuery = await wbiSign({ mid, platform: "web" }).catch(
        () => ""
      );
      // 带上 buvid 通行证（部分出口 IP 无 cookie 直调会被 -352 风控拦截）
      const { b3, b4 } = await getBuvid();
      const upCookie = [BILIBILI_COOKIE, `buvid3=${b3}`, `buvid4=${b4}`]
        .filter(Boolean)
        .join("; ");
      const [relationStat, accInfo, spaceInfo] = await Promise.allSettled([
        bilibiliRequest(
          `https://api.bilibili.com/x/relation/stat?vmid=${mid}`,
          headers
        ),
        bilibiliRequest(
          `https://api.bilibili.com/x/space/wbi/acc/info?${signedAccQuery}`,
          { Cookie: upCookie, "User-Agent": MODERN_USER_AGENT }
        ),
        // UP主空间公开信息：view 接口的 owner.sign 可能为空，用空间接口签名兜底
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
        followingCount = relationStat.value.data.following;
        followerCount = relationStat.value.data.follower;
      }
      if (accInfo.status === "fulfilled" && accInfo.value?.code === 0) {
        totalFavorited = accInfo.value.data.likes;
      }
      if (spaceInfo.status === "fulfilled" && spaceInfo.value?.code === 0) {
        upSign = spaceInfo.value.data.sign || "";
      }
    } catch (error) {
      logger.error("Failed to fetch up stats:", error.message);
    }
    
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
        sign: upSign || videoInfo.data.owner.sign || "",
        uid: videoInfo.data.owner.mid,
        // UP主主页链接：由 mid 拼 space 首页（前端可点击跳转）
        authorUrl: `https://space.bilibili.com/${mid}`,
        followingCount,
        followerCount,
        totalFavorited,
      },
    };
  } catch (error) {
    logger.error("Error parsing bilibili video:", error.message);
    return { code: 0, msg: "解析失败！" };
  }
}

export const GET = createApiHandler(getBilibiliVideoInfo, {
  shouldCache: false,
  responseHeaders: {
    "Cache-Control": "no-store, no-cache, must-revalidate",
  },
});
