import {
  beijingNow,
  getCachedResponse,
  getClientIP,
  getCorsHeaders,
  isBlockedIP,
  logger,
  rateLimit,
  sanitizeUrl,
  setCacheResponse,
} from "@/lib/api-utils";
import { honeypotResponse } from "@/lib/honeypot";
import { normalizeResult } from "@/lib/normalize-result";
import {
  GD_BRS,
  GD_DEFAULT_BR,
  GD_DEFAULT_SOURCE,
  GD_SEARCH_PAGE_MAX,
  GD_SEARCH_SOURCE_LIST,
  GD_SOURCE_LIST,
  MUSIC_FAILURE,
  MUSIC_FAILURE_MSG,
  buildPicUrl,
  buildSearchUrl,
  buildTrackUrl,
  buildUpstreamUrl,
  isSearchableSource,
  isSupportedSource,
  normalizeBr,
  normalizeCount,
  normalizeId,
  normalizeKeyword,
  normalizePage,
  normalizePicId,
  normalizePicSize,
  normalizeSource,
  parsePicResponse,
  parseSearchResponse,
  parseTrackResponse,
} from "@/lib/gdmusic";

export const runtime = "nodejs";

/**
 * 通用音乐源获取接口（多源聚合）：
 *   GET /api/music?action=search&source=netease&keyword=<关键词>&count=10&page=1  搜歌
 *   GET /api/music?action=pic&source=netease&id=<pic_id>&size=300                 换封面
 *   GET /api/music?source=netease&id=<track_id>&br=999                            取直链（默认）
 *   GET /api/music?source=netease&id=<track_id>&br=999&fmt=text
 *
 * 代理 music-api.gdstudio.xyz 的 types=search / types=pic / types=url，把上游扁平响应
 * 归一为本服务统一契约 { code, msg, data }；附进程内存 5 分钟缓存（成功才写）、
 * IP 级限流与黑名单拦截。参数白名单在入口先校验，减少无效上游流量。
 */

const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
};
const UPSTREAM_TIMEOUT = 8000;

/** 识别上游返回的 CF 人机校验/风控页：GD 音乐台对数据中心出口（如 Vercel 海外机房）会回此页，
 *  并非真实数据，直接当作“上游暂不可用”处理，避免把校验页塞进歌词/解析结果。 */
const CF_CHALLENGE_MARKERS = [
  "__cf_chl",
  "cf_chl_opt",
  "Just a moment",
  "Enable JavaScript and cookies to continue",
];
function isCfChallengeBody(text) {
  if (typeof text !== "string" || !text) return false;
  const head = text.slice(0, 2000);
  return CF_CHALLENGE_MARKERS.some((marker) => head.includes(marker));
}

/** 成功才写缓存的 key：source + id + 请求 br */
function cacheKey(source, id, br) {
  return `gdmusic:${source}:${id}:${br}`;
}

/** 搜索缓存 key：source + 关键词 + 分页 */
function searchCacheKey(source, keyword, count, page) {
  return `gdmusic:search:${source}:${keyword}:${count}:${page}`;
}

/** 下载扩展名跟随上游 Content-Type（mpeg/flac/aac/ogg/m4a/wav），未知默认 .mp3 */
function mediaExt(contentType) {
  if (!contentType) return ".mp3";
  const t = contentType.toLowerCase();
  if (t.includes("flac")) return ".flac";
  if (t.includes("aac")) return ".aac";
  if (t.includes("ogg")) return ".ogg";
  if (t.includes("m4a") || t.includes("mp4")) return ".m4a";
  if (t.includes("wav")) return ".wav";
  return ".mp3";
}

/** 下载文件名的音质/码率标签：与播放器侧 BR_LABEL 文案同源，便于区分同一首歌的不同档位 */
const BR_FILE_TAG = {
  128: "标准音质·128kbps",
  192: "标准音质·192kbps",
  320: "标准音质·320kbps",
  740: "无损音质·16bit",
  999: "无损音质·24bit",
};

/** 清洗曲名作下载文件名：剔除路径分隔符/控制字符，限制长度，追加「音质/码率」标签与音频扩展名 */
function buildDownloadFileName(rawTitle, source, id, contentType, br) {
  const cleaned = String(rawTitle || "")
    .replace(/[\\/:*?"<>|\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  const base = cleaned || `${source}-${id}`;
  const tag =
    br && BR_FILE_TAG[br] ? ` - ${BR_FILE_TAG[br]}` : "";
  const ext = mediaExt(contentType);
  const full = base + tag;
  return full.endsWith(ext) ? full : full + ext;
}

export async function GET(request) {
  const startTime = Date.now();
  const corsHeaders = getCorsHeaders(request.headers.get("origin") || "");
  const { searchParams } = new URL(request.url);
  const textMode = searchParams.get("fmt") === "text";

  const logMusic = (status, code, detail = "") =>
    console.log(
      `[music] time=${beijingNow()} code=${code} status=${status} duration=${Date.now() - startTime}ms${
        detail ? ` ${detail}` : ""
      }`
    );

  // fmt=text 纯文本：成功输出直链一行，失败输出错误文案（对齐其它接口的轻量调用方用法）
  const send = (payload, status = 200) => {
    if (textMode && payload && typeof payload === "object") {
      const url =
        payload.code === 200 && typeof payload.data?.url === "string"
          ? payload.data.url
          : "";
      const line = url || String(payload.msg || "解析失败");
      return new Response(line, {
        status,
        headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    return Response.json(payload, { status, headers: corsHeaders });
  };

  const clientIP = getClientIP(request);
  console.log(`[music] request from IP: ${clientIP}`);

  // IP 黑名单（蜜罐）：与统一入口行为一致，命中返回结构化引导数据
  if (isBlockedIP(clientIP)) {
    logger.warn(`黑名单 IP 命中蜜罐(music): ip=${clientIP}`);
    return send(normalizeResult(honeypotResponse("music")), 200);
  }

  // IP 级限流（60 次/分钟，与其它接口一致）
  if (!rateLimit(clientIP)) {
    logMusic("limited", 429, "IP 级限流");
    return send({ code: 429, msg: "请求过于频繁，请稍后再试" }, 429);
  }

  // —— 参数读取与白名单校验 ——
  const action = (searchParams.get("action") || "url").trim().toLowerCase();
  const source = normalizeSource(searchParams.get("source") || GD_DEFAULT_SOURCE);

  if (action !== "url" && action !== "search" && action !== "pic" && action !== "lyric") {
    return send(
      {
        code: 400,
        msg: `不支持的 action: ${action}（可选 url / search / pic / lyric）`,
        usage: [
          "/api/music?action=search&source=netease&keyword=<关键词>",
          "/api/music?action=pic&source=netease&id=<pic_id>&size=300",
          "/api/music?action=lyric&source=netease&id=<track_id/lyric_id>",
          "/api/music?source=netease&id=<track_id>&br=999",
        ].join(" | "),
      },
      400
    );
  }

  // —— 分支一：action=search 关键词搜歌（多源列表） ——
  if (action === "search") {
    const keyword = normalizeKeyword(
      searchParams.get("keyword") ?? searchParams.get("name")
    );
    if (!keyword) {
      return send(
        {
          code: 400,
          msg: "keyword 为空：请输入要搜索的歌曲关键词（歌名 / 歌手等）",
          usage: "/api/music?action=search&source=netease&keyword=<关键词>&count=10&page=1",
        },
        400
      );
    }
    if (!isSearchableSource(source)) {
      return send(
        {
          code: 400,
          msg: `该 music source 暂不支持关键词搜索：${source}`,
          usage: "/api/music?action=search&source=netease&keyword=<关键词>",
          supportedSources: GD_SEARCH_SOURCE_LIST,
        },
        400
      );
    }
    const count = normalizeCount(searchParams.get("count"));
    const page = normalizePage(searchParams.get("page"));

    const searchKey = searchCacheKey(source, keyword, count, page);
    const searchCached = getCachedResponse(searchKey);
    if (searchCached) {
      logMusic("cached-search", 200, `source=${source} keyword=${keyword}`);
      return Response.json(searchCached, { status: 200, headers: corsHeaders });
    }

    let payload;
    let status = 200;
    try {
      const upstreamUrl = buildSearchUrl({ source, keyword, count, page });
      const res = await fetch(upstreamUrl, {
        headers: REQUEST_HEADERS,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
      });
      if (!res.ok) {
        logger.warn(`gdmusic search upstream http ${res.status} url=${upstreamUrl}`);
      }
      const json = res.ok ? await res.json().catch(() => null) : null;
      const parsed = parseSearchResponse(json);
      if (!parsed.ok && parsed.kind === "bad-data" && res.ok) {
        // 200 但非预期 JSON：多为上游 CF 风控页或接口变更，记日志便于线上排查
        logger.warn("gdmusic search upstream returned non-JSON body (CF challenge?)");
      }

      if (parsed.ok) {
        // hasMore：仅“回满整页且未到页码上限”才视为有下一页。joox 实测无视 count/pages
        // 整页返回（如请求 10 条却回 30 条），此处按“实回条数 !== 请求条数”自动判为无更多，
        // 避免对同一页重复翻页造成列表重复。
        const hasMore =
          page < GD_SEARCH_PAGE_MAX &&
          parsed.items.length > 0 &&
          parsed.items.length === count;
        payload = {
          code: 200,
          msg: "搜索成功",
          data: {
            source,
            keyword,
            page,
            hasMore,
            count: parsed.items.length,
            items: parsed.items,
          },
        };
      } else if (parsed.kind === "rejected") {
        logger.warn(`gdmusic search source rejected: ${parsed.detail || ""}`);
        payload = {
          code: 400,
          msg: MUSIC_FAILURE_MSG[MUSIC_FAILURE.SOURCE_UNAVAILABLE],
          failType: MUSIC_FAILURE.SOURCE_UNAVAILABLE,
        };
        status = 400;
      } else {
        payload = {
          code: 502,
          msg: MUSIC_FAILURE_MSG[MUSIC_FAILURE.SOURCES_DOWN],
          failType: MUSIC_FAILURE.SOURCES_DOWN,
        };
        status = 502;
      }
    } catch (error) {
      logger.warn(`gdmusic search upstream error: ${error.message}`);
      payload = {
        code: 502,
        msg: MUSIC_FAILURE_MSG[MUSIC_FAILURE.SOURCES_DOWN],
        failType: MUSIC_FAILURE.SOURCES_DOWN,
      };
      status = 502;
    }

    if (payload.code === 200) {
      setCacheResponse(searchKey, payload);
      logMusic("search", 200, `source=${source} keyword=${keyword}`);
    } else {
      logMusic("search-failed", status, `source=${source} keyword=${keyword}`);
    }
    // 搜索返回结构化列表，fmt=text 不适用
    return Response.json(payload, { status, headers: corsHeaders });
  }

  // —— 分支二：action=pic 用 search 结果的 pic_id 换取专辑封面 ——
  if (action === "pic") {
    const picRaw = searchParams.get("id") ?? searchParams.get("pic_id");
    const picId = normalizePicId(picRaw);
    if (!picId) {
      return send(
        {
          code: 400,
          msg: "id 为空：请提供搜索结果的 pic_id（专辑封面 id，非曲目 id）",
          usage: "/api/music?action=pic&source=netease&id=<pic_id>&size=300",
        },
        400
      );
    }
    if (!isSupportedSource(source)) {
      return send(
        {
          code: 400,
          msg: `不支持的 music source: ${source}`,
          usage: "/api/music?action=pic&source=netease&id=<pic_id>&size=300",
          supportedSources: GD_SOURCE_LIST,
        },
        400
      );
    }
    const size = normalizePicSize(searchParams.get("size"));

    // bin=1：同源字节代理封面（服务端抓上游真实图片，浏览器端 <canvas> 取色用，
    // 规避第三方图床无 CORS 导致的 canvas 污染；响应附带 5 分钟缓存与 nosniff）
    if (searchParams.get("bin") === "1") {
      const binKey = `gdmusic:picbin:${source}:${picId}:${size}`;
      const binCached = getCachedResponse(binKey);
      if (binCached) {
        logMusic("cached-picbin", 200, `source=${source} pic_id=${picId}`);
        return new Response(binCached.data, {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": binCached.type || "image/jpeg",
            "Cache-Control": "public, max-age=300",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      try {
        const upstreamUrl = buildPicUrl({ source, id: picId, size });
        const res = await fetch(upstreamUrl, {
          headers: REQUEST_HEADERS,
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
        });
        if (!res.ok) {
          logger.warn(`gdmusic picbin upstream http ${res.status} url=${upstreamUrl}`);
        }
        const json = res.ok ? await res.json().catch(() => null) : null;
        const parsed = parsePicResponse(json);

        if (!parsed.ok || !parsed.url) {
          if (parsed.kind === "rejected") {
            logMusic("picbin-failed", 400, `source=${source} pic_id=${picId}`);
            return send(
              {
                code: 400,
                msg: MUSIC_FAILURE_MSG[MUSIC_FAILURE.SOURCE_UNAVAILABLE],
                failType: MUSIC_FAILURE.SOURCE_UNAVAILABLE,
              },
              400
            );
          }
          if (parsed.kind === "bad-data") {
            // 上游非预期响应（非 JSON/风控页/HTTP 错误）属于“上游暂不可用”，而非“歌曲无封面”
            logMusic("picbin-failed", 502, `source=${source} pic_id=${picId}`);
            return send(
              {
                code: 502,
                msg: MUSIC_FAILURE_MSG[MUSIC_FAILURE.SOURCES_DOWN],
                failType: MUSIC_FAILURE.SOURCES_DOWN,
              },
              502
            );
          }
          logMusic("picbin-failed", 404, `source=${source} pic_id=${picId}`);
          return send(
            {
              code: 404,
              msg: "未找到该歌曲的专辑封面（可能已下架或该源无封面）",
              failType: MUSIC_FAILURE.NOT_FOUND,
            },
            404
          );
        }

        // 兼容上游偶发的协议相对地址（//cdn...）
        let imgUrl = parsed.url;
        if (/^\/\//.test(imgUrl)) imgUrl = "https:" + imgUrl;
        const safeUrl = sanitizeUrl(imgUrl);
        if (!safeUrl) throw new Error("invalid cover url");
        const imgRes = await fetch(safeUrl, {
          headers: REQUEST_HEADERS,
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
        });
        if (!imgRes.ok) throw new Error(`cover fetch status=${imgRes.status}`);
        const buf = Buffer.from(await imgRes.arrayBuffer());
        const type = imgRes.headers.get("content-type") || "image/jpeg";
        setCacheResponse(binKey, { data: buf, type });
        logMusic("picbin", 200, `source=${source} pic_id=${picId}`);
        return new Response(buf, {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": type,
            "Cache-Control": "public, max-age=300",
            "X-Content-Type-Options": "nosniff",
          },
        });
      } catch (error) {
        logger.warn(`gdmusic picbin upstream error: ${error.message}`);
        return send(
          {
            code: 502,
            msg: MUSIC_FAILURE_MSG[MUSIC_FAILURE.SOURCES_DOWN],
            failType: MUSIC_FAILURE.SOURCES_DOWN,
          },
          502
        );
      }
    }

    const picKey = `gdmusic:pic:${source}:${picId}:${size}`;
    const cached = getCachedResponse(picKey);
    if (cached) {
      logMusic("cached-pic", 200, `source=${source} pic_id=${picId}`);
      return send(cached, 200);
    }

    let payload;
    let status = 200;
    try {
      const upstreamUrl = buildPicUrl({ source, id: picId, size });
      const res = await fetch(upstreamUrl, {
        headers: REQUEST_HEADERS,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
      });
      if (!res.ok) {
        logger.warn(`gdmusic pic upstream http ${res.status} url=${upstreamUrl}`);
      }
      const json = res.ok ? await res.json().catch(() => null) : null;
      const parsed = parsePicResponse(json);

      if (parsed.ok) {
        payload = {
          code: 200,
          msg: "获取成功",
          data: { url: parsed.url, source, id: picId, size },
        };
      } else if (parsed.kind === "rejected") {
        logger.warn(`gdmusic pic source rejected: ${parsed.detail || ""}`);
        payload = {
          code: 400,
          msg: MUSIC_FAILURE_MSG[MUSIC_FAILURE.SOURCE_UNAVAILABLE],
          failType: MUSIC_FAILURE.SOURCE_UNAVAILABLE,
        };
        status = 400;
      } else if (parsed.kind === "bad-data") {
        // 上游非预期响应（非 JSON/风控页/HTTP 错误）属于“上游暂不可用”，而非“歌曲无封面”
        logger.warn("gdmusic pic upstream returned unusable response (CF challenge?)");
        payload = {
          code: 502,
          msg: MUSIC_FAILURE_MSG[MUSIC_FAILURE.SOURCES_DOWN],
          failType: MUSIC_FAILURE.SOURCES_DOWN,
        };
        status = 502;
      } else {
        // not-found：pic_id 无效、歌曲无专辑或该源无封面
        payload = {
          code: 404,
          msg: "未找到该歌曲的专辑封面（可能已下架或该源无封面）",
          failType: MUSIC_FAILURE.NOT_FOUND,
        };
        status = 404;
      }
    } catch (error) {
      logger.warn(`gdmusic pic upstream error: ${error.message}`);
      payload = {
        code: 502,
        msg: MUSIC_FAILURE_MSG[MUSIC_FAILURE.SOURCES_DOWN],
        failType: MUSIC_FAILURE.SOURCES_DOWN,
      };
      status = 502;
    }

    if (payload.code === 200) {
      setCacheResponse(picKey, payload);
      logMusic("pic", 200, `source=${source} pic_id=${picId} size=${size}`);
    } else {
      logMusic("pic-failed", status, `source=${source} pic_id=${picId}`);
    }
    return send(payload, status);
  }

  // —— 分支四：action=lyric 按 lyric_id / track_id 取歌词 ——
  if (action === "lyric") {
    const lyricId = normalizeId(searchParams.get("id") ?? searchParams.get("lyric_id"));
    if (!lyricId) {
      return send(
        {
          code: 400,
          msg: "id 为空：请提供 lyric_id 或 track_id（搜索结果的 lyric_id / id）",
          usage: "/api/music?action=lyric&source=netease&id=<track_id/lyric_id>",
        },
        400
      );
    }
    if (!isSupportedSource(source)) {
      return send(
        {
          code: 400,
          msg: `不支持的 music source: ${source}`,
          usage: "/api/music?action=lyric&source=netease&id=<track_id/lyric_id>",
          supportedSources: GD_SOURCE_LIST,
        },
        400
      );
    }

    try {
      const upstreamUrl = buildUpstreamUrl({ types: "lyric", source, id: lyricId });
      const res = await fetch(upstreamUrl, {
        headers: REQUEST_HEADERS,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
      });
      const text = await res.text();
      // GD 音乐台对数据中心/海外出口会返回 CF 风控页：此时拿到的不是歌词，按“上游暂不可用”处理，
      // 避免把校验页 HTML 当歌词塞给前端
      if (!res.ok || isCfChallengeBody(text)) {
        logger.warn(`gdmusic lyric upstream unusable status=${res.status} url=${upstreamUrl}`);
        return send(
          {
            code: 502,
            msg: MUSIC_FAILURE_MSG[MUSIC_FAILURE.SOURCES_DOWN],
            failType: MUSIC_FAILURE.SOURCES_DOWN,
          },
          502
        );
      }
      let lyric = "";
      if (text) {
        try {
          const json = JSON.parse(text);
          if (typeof json.lyric === "string") lyric = json.lyric;
          else if (typeof json.lrc === "string") lyric = json.lrc;
          else if (typeof json === "string") lyric = json;
        } catch {
          // 上游可能直接返回 LRC 纯文本
          lyric = text;
        }
      }
      logMusic("lyric", 200, `source=${source} lyric_id=${lyricId}`);
      return send({ code: 200, msg: "获取成功", data: { lyric: lyric.trim() } }, 200);
    } catch (error) {
      logger.warn(`gdmusic lyric upstream error: ${error.message}`);
      return send({ code: 502, msg: MUSIC_FAILURE_MSG[MUSIC_FAILURE.SOURCES_DOWN] }, 502);
    }
  }

  // —— 分支三：action=url（默认）按 id 取直链 ——
  const id = normalizeId(searchParams.get("id") ?? searchParams.get("track_id"));
  const brRaw = searchParams.get("br");
  const br = brRaw === null ? GD_DEFAULT_BR : normalizeBr(brRaw);
  const usage = "/api/music?source=netease&id=<track_id>&br=999";
  // bin=1：拿到直链后不回 JSON，改为服务端字节代理下载（带 attachment 头，点击即保存）
  const binMode = searchParams.get("bin") === "1";
  // 下载文件名优先用曲名（用户可见），空时兜底 source-id
  const titleRaw = searchParams.get("title") || "";

  if (!id) {
    return send(
      {
        code: 400,
        msg: "id 为空：请提供曲目 ID（track_id），可用上游搜索接口获取",
        usage,
      },
      400
    );
  }
  if (!isSupportedSource(source)) {
    return send(
      {
        code: 400,
        msg: `不支持的 music source: ${source}`,
        usage,
        supportedSources: GD_SOURCE_LIST,
      },
      400
    );
  }
  if (br === null) {
    return send(
      {
        code: 400,
        msg: `不支持的 br 参数：请使用 ${GD_BRS.join("/")} 之一`,
        usage,
      },
      400
    );
  }

  // 5 分钟进程内存缓存（仅成功结果写缓存）
  const key = cacheKey(source, id, br);
  const cached = getCachedResponse(key);
  if (cached) {
    logMusic("cached", 200, `source=${source} id=${id} br=${br}`);
    return send(cached, 200);
  }

  let payload;
  let status = 200;
  try {
    const upstreamUrl = buildTrackUrl({ source, id, br });
    const res = await fetch(upstreamUrl, {
      headers: REQUEST_HEADERS,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
    });
    if (!res.ok) {
      logger.warn(`gdmusic url upstream http ${res.status} url=${upstreamUrl}`);
    }
    const json = res.ok ? await res.json().catch(() => null) : null;
    const parsed = parseTrackResponse(json);

    if (parsed.ok) {
      payload = {
        code: 200,
        msg: "获取成功",
        data: {
          url: parsed.data.url,
          br: parsed.data.br, // 实际返回音质
          size: parsed.data.size, // 文件大小（字节）
          source,
          id,
        },
      };
    } else if (parsed.kind === "rejected") {
      // source 在上游被拒（如暂未开放）：入口白名单兜不住时在此归类
      logger.warn(`gdmusic source rejected: ${parsed.detail || ""}`);
      payload = {
        code: 400,
        msg: MUSIC_FAILURE_MSG[MUSIC_FAILURE.SOURCE_UNAVAILABLE],
        failType: MUSIC_FAILURE.SOURCE_UNAVAILABLE,
      };
      status = 400;
    } else if (parsed.kind === "not-found") {
      payload = {
        code: 404,
        msg: MUSIC_FAILURE_MSG[MUSIC_FAILURE.NOT_FOUND],
        failType: MUSIC_FAILURE.NOT_FOUND,
      };
      status = 404;
    } else {
      payload = {
        code: 502,
        msg: MUSIC_FAILURE_MSG[MUSIC_FAILURE.SOURCES_DOWN],
        failType: MUSIC_FAILURE.SOURCES_DOWN,
      };
      status = 502;
    }
  } catch (error) {
    logger.warn(`gdmusic upstream error: ${error.message}`);
    payload = {
      code: 502,
      msg: MUSIC_FAILURE_MSG[MUSIC_FAILURE.SOURCES_DOWN],
      failType: MUSIC_FAILURE.SOURCES_DOWN,
    };
    status = 502;
  }

  if (payload.code === 200) {
    setCacheResponse(key, payload);
    logMusic("success", 200, `source=${source} id=${id} br=${br}`);
  } else {
    // 失败不缓存：瞬时源波动，重试应立即重新获取
    logMusic("failed", status, `source=${source} id=${id} br=${br}`);
  }

  // bin=1：把音频文件以 attachment 流回浏览器，绕开第三方直链跨域/inline
  // 导致的“新标签页播放或跳源站页面”，保证点击下载即弹出保存
  if (payload.code === 200 && binMode) {
    const dlUrl = payload.data.url;
    if (!dlUrl) {
      return send({ code: 502, msg: "未获取到可下载的音频地址，请稍后重试" }, 502);
    }
    // 只对“等待响应头”设超时：拿到头后立刻清除，避免超时把下载流中途掐断
    const controller = new AbortController();
    const headTimer = setTimeout(() => controller.abort(), 20000);
    let dlRes;
    try {
      dlRes = await fetch(dlUrl, {
        headers: REQUEST_HEADERS,
        redirect: "follow",
        signal: controller.signal,
      });
    } catch (error) {
      logger.warn(`gdmusic download upstream error: ${error.message}`);
      logMusic("download-failed", 502, `source=${source} id=${id} br=${br}`);
      return send(
        { code: 502, msg: MUSIC_FAILURE_MSG[MUSIC_FAILURE.SOURCES_DOWN] },
        502
      );
    } finally {
      clearTimeout(headTimer);
    }
    if (!dlRes.ok) {
      logMusic("download-failed", dlRes.status, `source=${source} id=${id} br=${br}`);
      return send(
        { code: 502, msg: `音频源站下载失败（状态 ${dlRes.status}），请稍后重试` },
        502
      );
    }
    const contentType =
      dlRes.headers.get("content-type")?.split(";")[0]?.trim() || "audio/mpeg";
    const contentLength =
      dlRes.headers.get("content-length") ||
      (payload.data.size ? String(payload.data.size) : "");
    // 文件名用「实际返回的 br」标注音质/码率（上游降级时与真实档位一致，避免标注虚高）
    const fileName = buildDownloadFileName(
      titleRaw,
      source,
      id,
      contentType,
      payload.data.br
    );
    logMusic("download", 200, `source=${source} id=${id} br=${br}`);
    return new Response(dlRes.body, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(
          fileName
        )}`,
        ...(contentLength ? { "Content-Length": contentLength } : {}),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  return send(payload, status);
}
