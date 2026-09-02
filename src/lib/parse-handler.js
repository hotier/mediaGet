/**
 * 解析请求统一处理器 —— /api/parse 与 /api/parse-text 共用的唯一实现。
 *
 * 合并背景：/api/parse-text 此前把「整段分享文案」提取出链接后，内部转交给
 * /api/parse 同一条 createApiHandler 链路（限流 / SSRF 校验 / 共享缓存 / 并发
 * 去重 / 字段归一化 / 行为统计）。两个入口底层完全同源，仅参数形态不同，故合并
 * 为一份实现，两个 route 只做薄壳转发：
 *
 * - /api/parse（主入口）：url=（纯链接/整段文案）/ text=（整段文案）/ source+id；
 *   GET 与 POST 均可，POST body 支持 JSON（{"url"|"text"}）与表单。
 * - /api/parse-text（兼容别名）：textOnly 模式，只接收 text=（整段分享文案），
 *   对外契约与报错文案保持不变，供既有调用方（iOS 快捷指令等）继续使用。
 *
 * fmt=text 纯文本模式、IP 黑名单 / 蜜罐、平台级节流等均由 createApiHandler
 * 中间件从转发后的 URL 上读取，天然一致。
 */

import { createApiHandler, safeStatus } from "@/lib/api-middleware";
import {
  getClientIP,
  getCorsHeaders,
  isBlockedIP,
  isValidUrl,
  logger,
  rateLimit,
} from "@/lib/api-utils";
import { extractUrlFromShareText } from "@/lib/share-text";
import { normalizeResult } from "@/lib/normalize-result";
import { PLATFORM_INFO } from "@/lib/platforms";
import { honeypotResponse } from "@/lib/honeypot";
import { unifiedParser } from "@/lib/unified-parser";

// parse-text 兼容层保持原样的报错文案（勿改，避免破坏既有调用方的文案判断）
const ERR_TEXT_EMPTY = "text为空：请粘贴视频分享文案（含链接）";
const ERR_TEXT_NO_LINK =
  "未能从分享文案中提取到有效链接，请确认文案中包含视频分享链接";

const ERR_NO_PARAMS = "参数缺失：请提供 url/text 参数 或 source+id 参数";

/** 支持 ID 解析的平台列表（错误提示附带的元数据） */
const ID_PARSE_PLATFORMS = Object.entries(PLATFORM_INFO)
  .filter(([, info]) => info.supportsIdParse)
  .map(([key, info]) => ({
    platform: key,
    name: info.name,
    supportsIdParse: true,
  }));

function respond(corsHeaders, data, status) {
  return Response.json(data, { status, headers: corsHeaders });
}

/**
 * @param {Request} request 原始请求
 * @param {{ textOnly?: boolean }} [options]
 *   textOnly=true：仅接受 text=（分享文案），url/source+id 一律忽略
 *   （/api/parse-text 兼容模式）。
 */
export async function handleParseRequest(request, { textOnly = false } = {}) {
  const corsHeaders = getCorsHeaders(request.headers.get("origin") || "");
  const { searchParams } = new URL(request.url);

  // —— POST：从 JSON / 表单 body 补充 text / url ——
  // 超长分享文案经 GET 会被 URL 长度限制截断，POST 无此问题；
  // body 与 query 同时存在时以 query 为准（先到先得，query 更明确）。
  if (request.method === "POST") {
    try {
      const contentType = request.headers.get("content-type") || "";
      const merge = (obj) => {
        if (!obj || typeof obj !== "object") return;
        if (
          !searchParams.has("text") &&
          typeof obj.text === "string" &&
          obj.text.trim()
        ) {
          searchParams.set("text", obj.text.trim());
        }
        if (
          !searchParams.has("url") &&
          typeof obj.url === "string" &&
          obj.url.trim()
        ) {
          searchParams.set("url", obj.url.trim());
        }
      };
      if (contentType.includes("application/json")) {
        merge(await request.json());
      } else {
        const form = await request.formData();
        const text = form.get("text");
        const url = form.get("url");
        merge({
          text: typeof text === "string" ? text : undefined,
          url: typeof url === "string" ? url : undefined,
        });
      }
    } catch {
      // body 解析失败按无 body 处理（回到 GET 语义，由下方参数判断兜底）
    }
  }

  const url = searchParams.get("url");
  const text = searchParams.get("text");
  const source = searchParams.get("source");
  const id = searchParams.get("id");

  // textOnly 模式（/api/parse-text 兼容别名）：只接收 text=，url/source/id 一律忽略
  if (textOnly && (!text || !text.trim())) {
    return respond(
      corsHeaders,
      { code: 400, msg: ERR_TEXT_EMPTY, usage: "/api/parse-text?text=分享文案" },
      safeStatus(400)
    );
  }

  // 确定「待解析输入」，统一归一为 url= 后交给中间件：
  // - url=（纯链接/整段文案）：不在本层提取，由中间件兜底提取一次（行为不变）；
  // - text=（整段文案）：本层预提取一次，以给出精确的「提取不到链接」提示
  //   （与原 parse-text 一致）。提取算法只有一份（src/lib/share-text.ts），
  //   预提取结果必为纯链接，中间件对纯链接的二次提取幂等，无重复解析副作用。
  let targetUrl;
  if (url && !textOnly) {
    targetUrl = url;
  } else if (text) {
    targetUrl = extractUrlFromShareText(text);
    if (!targetUrl || !isValidUrl(targetUrl)) {
      return respond(corsHeaders, { code: 400, msg: ERR_TEXT_NO_LINK }, safeStatus(400));
    }
  }

  if (targetUrl) {
    // 把最终链接归一为 url= 参数，交由统一入口中间件处理
    // （与 parse-text 旧转发逻辑一致；保留 fmt 等其余 query 参数透传）
    const inner = new URL(request.url);
    inner.searchParams.set("url", targetUrl);
    inner.searchParams.delete("text");
    inner.searchParams.delete("source");
    inner.searchParams.delete("id");
    const forwarded = new Request(inner.toString(), {
      method: "GET",
      headers: request.headers,
    });
    return createApiHandler((u) => unifiedParser(u), {
      shouldCache: false,
      sharedCache: true,
    })(forwarded);
  }

  // —— 方式 C：source + id（仅主入口 /api/parse；此分支受 IP 级限流保护）——
  if (source) {
    if (!id) {
      return respond(
        corsHeaders,
        {
          code: 400,
          msg: "参数缺失：提供 source 时需同时提供 id 参数",
          usage: {
            "方式2": "/api/parse?source=douyin&id=视频ID",
          },
          supportedPlatforms: ID_PARSE_PLATFORMS,
        },
        safeStatus(400)
      );
    }
    const clientIP = getClientIP(request);
    // IP 黑名单（与中间件一致）：命中返回 200 + 蜜罐结构化数据（宣传公众号）
    if (isBlockedIP(clientIP)) {
      logger.warn(`黑名单 IP 命中蜜罐(source+id): ip=${clientIP}`);
      return Response.json(normalizeResult(honeypotResponse(source)), {
        status: 200,
        headers: corsHeaders,
      });
    }
    if (!rateLimit(clientIP)) {
      return respond(corsHeaders, { code: 429, msg: "请求过于频繁，请稍后再试" }, safeStatus(429));
    }
    const result = normalizeResult(await unifiedParser("", { source, id }));
    return Response.json(result, {
      status: safeStatus(result?.code || 200),
      headers: corsHeaders,
    });
  }

  // —— 无任何可用参数 ——
  return respond(
    corsHeaders,
    {
      code: 400,
      msg: ERR_NO_PARAMS,
      usage: {
        "方式1(推荐)": "/api/parse?url=分享链接",
        "方式1b(文案)": "/api/parse?text=整段分享文案",
        "方式2": "/api/parse?source=douyin&id=视频ID",
        "POST(长文案)": "/api/parse  JSON: {\"text\":\"…\"} 或 {\"url\":\"…\"}",
      },
      supportedPlatforms: ID_PARSE_PLATFORMS,
    },
    safeStatus(400)
  );
}
