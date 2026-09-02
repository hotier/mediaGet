/**
 * B 站图文动态（/opus/<id>）detail 响应分类与归一 —— 纯函数，不发起网络请求，
 * 供 route.js 调用与单元测试直接 import。
 *
 * 输入：x/polymer/web-dynamic/v1/detail 的 JSON（code 应为 0）
 * 输出：
 *   - 纯图文（DYNAMIC_TYPE_DRAW / DYNAMIC_TYPE_OPUS 且 pics 非空）
 *     → { ok: true, data: { type:"image", title, desc, cover, images, author,
 *        authorId, authorUrl, avatar, time, stat } }（data 即统一 ParseData 形状）
 *   - 其余 → { ok: false, msg }
 *
 * 实测结构：detail.data.item = {
 *   type: "DYNAMIC_TYPE_DRAW" | "DYNAMIC_TYPE_OPUS" | "DYNAMIC_TYPE_ARTICLE" | ...,
 *   modules: {
 *     module_author: { mid, name, face, pub_ts },
 *     module_dynamic: { major: { opus: { title, pics: [{ url }], summary: { text } } } },
 *     module_stat: { like: {count}, comment: {count}, forward: {count} },
 *   },
 * }
 * 边界：ARTICLE（专栏文章）pics 只是封面入口图，正文图需走已风控的专栏接口，明确拒绝。
 */

/** http → https：hdslb 图床图片 http 直链在 https 页面会被混合内容拦截破图 */
function toHttps(url) {
  if (typeof url !== "string") return "";
  return url.replace(/^http:\/\//i, "https://");
}

/** 空串 / "-" / 纯空白视为无文案（与视频 desc 归一行为一致） */
function cleanText(text) {
  if (typeof text !== "string") return "";
  const t = text.trim();
  if (!t || t === "-") return "";
  return text;
}

/** B 站头像 face 可能为 http 直链，统一走站内图片代理（同源返回 + 防盗链兜底） */
function proxifyImage(url) {
  const httpsUrl = toHttps(url);
  if (!httpsUrl) return "";
  return `/api/image?url=${encodeURIComponent(httpsUrl)}`;
}

/** 统计计数：仅保留正数，缺失/异常返回 undefined（前端该行自动隐藏） */
function positiveCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function classifyOpusDetail(detail) {
  const item = detail?.data?.item;
  if (!item) return { ok: false, msg: "解析失败！" };

  const type = item.type || "";
  const modules = item.modules || {};
  const opus = modules.module_dynamic?.major?.opus || {};
  const pics = (Array.isArray(opus.pics) ? opus.pics : [])
    .map((pic) => toHttps(pic?.url))
    .filter(Boolean);

  // 白名单之外的类型一律拒绝（专栏文章封面图只是入口图，正文需另走已风控接口）
  if (!/^(DYNAMIC_TYPE_DRAW|DYNAMIC_TYPE_OPUS)$/.test(type)) {
    const msg =
      type === "DYNAMIC_TYPE_ARTICLE"
        ? "该动态是B站专栏文章，非图文动态，暂不支持解析正文图片"
        : "该动态不是图文内容，仅支持图文动态（/opus/ 链接）";
    return { ok: false, msg };
  }
  // 发图文不带图（纯文字动态）时 major.opus 无 pics
  if (pics.length === 0) {
    return { ok: false, msg: "该动态不包含图片（纯文字动态），仅支持图文动态" };
  }

  const author = modules.module_author || {};
  const stat = modules.module_stat || {};
  const mid = author.mid;
  const pubTs = Number(author.pub_ts);
  const time = Number.isFinite(pubTs) && pubTs > 0 ? pubTs : undefined;

  return {
    ok: true,
    data: {
      type: "image",
      title: opus.title || undefined,
      desc: cleanText(opus.summary?.text) || undefined,
      cover: pics[0],
      images: pics,
      author: author.name || undefined,
      authorId: mid != null ? String(mid) : undefined,
      authorUrl: mid != null ? `https://space.bilibili.com/${mid}` : undefined,
      avatar: proxifyImage(author.face),
      time,
      stat: {
        like: positiveCount(stat.like?.count),
        reply: positiveCount(stat.comment?.count),
        share: positiveCount(stat.forward?.count),
      },
    },
  };
}
