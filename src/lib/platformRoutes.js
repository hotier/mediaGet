/**
 * 平台 → 解析路由的映射（唯一数据源）
 * parse/route.js（统一解析入口）与 engines/route.js（平台体检）共用，
 * 避免两处各自维护一份映射导致不同步。
 */
export const platformRoutes = {
  douyin: () => import("@/app/api/douyin/route.js"),
  bilibili: () => import("@/app/api/bilibili/route.js"),
  // 汽水音乐（music.douyin.com / qishui.douyin.com）：统一入口识别特判返回
  // 本 key，必须在此注册才能被 getPlatformParser 动态加载
  qsmusic: () => import("@/app/api/qsmusic/route.js"),
  // key 必须与 lib/platforms.ts 的 PLATFORM_INFO 对齐（小红书是 redbook，
  // 统一入口 identifyPlatform 返回的 key），路由目录名仍是 /api/xhs
  redbook: () => import("@/app/api/xhs/route.js"),
  huya: () => import("@/app/api/huya/route.js"),
  haokan: () => import("@/app/api/haokan/route.js"),
  weibo: () => import("@/app/api/weibo/route.js"),
  xigua: () => import("@/app/api/xigua/route.js"),
  acfun: () => import("@/app/api/acfun/route.js"),
  // 皮皮虾目录是 ppxia
  pipixia: () => import("@/app/api/ppxia/route.js"),
  pipigx: () => import("@/app/api/pipigx/route.js"),
  sixroom: () => import("@/app/api/sixroom/route.js"),
  zuiyou: () => import("@/app/api/zuiyou/route.js"),
  quanminkge: () => import("@/app/api/quanminkge/route.js"),
  xinpianchang: () => import("@/app/api/xinpianchang/route.js"),
  twitter: () => import("@/app/api/twitter/route.js"),
  tiktok: () => import("@/app/api/tiktok/route.js"),
  instagram: () => import("@/app/api/instagram/route.js"),
  youtube: () => import("@/app/api/youtube/route.js"),
  qqmusic: () => import("@/app/api/qqmusic/route.js"),
};

/** 平台 key → 解析函数获取器（兼容注册函数与动态导入的 route） */
export async function getPlatformParser(platform) {
  const loader = platformRoutes[platform];
  if (!loader) return null;
  try {
    const mod = await loader();
    if (typeof mod.default === "function" && mod.default !== mod.GET) {
      return mod.default;
    }
    if (typeof mod.GET === "function") {
      // 统一契约：解析函数接收分享 URL 字符串，返回 { code, msg, data }
      const routeParser = async (url) => {
        const request = new Request(
          `http://internal.local/api/parser?url=${encodeURIComponent(url)}`,
          { headers: { "user-agent": "get.hotier.cc.cd/internal-parser", "x-parse-internal": "1" } }
        );
        const response = await mod.GET(request);
        if (!(response instanceof Response)) {
          return response ?? null;
        }
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          return await response.json();
        }
        const text = await response.text();
        return {
          code: response.ok ? 200 : response.status,
          msg: text || (response.ok ? "解析成功" : "解析失败"),
        };
      };
      if (typeof mod.parseVideoId === "function") {
        routeParser.parseVideoId = mod.parseVideoId;
      } else if (platform === "qqmusic") {
        // qqmusic 的 source+id 解析已从路由模块移出（Next 路由模块不允许
        // 额外具名导出，否则 next build 类型校验失败），改从 lib 模块挂载。
        try {
          const idMod = await import("@/lib/qqmusic-id.js");
          if (typeof idMod.parseVideoId === "function") {
            routeParser.parseVideoId = idMod.parseVideoId;
          }
        } catch {
          // 挂载失败按不支持 ID 解析处理（统一解析器会给出明确提示）
        }
      }
      return routeParser;
    }
    return null;
  } catch {
    return null;
  }
}
