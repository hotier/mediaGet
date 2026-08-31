/**
 * 分享文案解析入口：专门接收整段分享文案（?text=…），自动提取其中的链接后再走统一解析流程。
 *
 * 与 ?url= 接口职责分离：
 * - /api/parse?url= 只接受纯链接（严格校验，行为不变）
 * - /api/parse-text?text= 用于粘贴 App 复制出的整段分享文案（含标题/引导语），
 *   提取逻辑与前端 src/utils/share.ts 共用 src/lib/share-text.ts，避免前后端正则漂移
 *
 * 支持 GET（?text=…）与 POST（JSON body: {"text": "…"} 或表单 text=…）。
 * 提取出的纯链接会复用 createApiHandler 的完整安全链路：
 * IP 黑名单 / 限流 / SSRF 校验 / 共享结果缓存 / 并发去重 / 行为分析。
 */

import { createApiHandler, safeStatus } from "@/lib/api-middleware";
import { isValidUrl, getCorsHeaders } from "@/lib/api-utils";
import { extractUrlFromShareText } from "@/lib/share-text";
import { unifiedParser } from "@/lib/unified-parser";

function handle(request) {
  const { searchParams } = new URL(request.url);
  const text = searchParams.get("text");
  const corsHeaders = getCorsHeaders(request.headers.get("origin") || "");

  if (!text || !text.trim()) {
    return Response.json(
      {
        code: 400,
        msg: "text为空：请粘贴视频分享文案（含链接）",
        usage: "/api/parse-text?text=分享文案",
      },
      { status: safeStatus(400), headers: corsHeaders }
    );
  }

  const extracted = extractUrlFromShareText(text);
  if (!extracted || !isValidUrl(extracted)) {
    return Response.json(
      {
        code: 400,
        msg: "未能从分享文案中提取到有效链接，请确认文案中包含视频分享链接",
      },
      { status: safeStatus(400), headers: corsHeaders }
    );
  }

  // 把提取出的纯链接转为 url 参数，交给统一入口中间件（保留请求头，method 重置为 GET）
  const inner = new URL(request.url);
  inner.searchParams.set("url", extracted);
  inner.searchParams.delete("text");
  const forwarded = new Request(inner.toString(), { headers: request.headers });
  return createApiHandler((url) => unifiedParser(url), {
    shouldCache: false,
    sharedCache: true,
  })(forwarded);
}

export async function GET(request) {
  return handle(request);
}

export async function POST(request) {
  // POST 兼容 JSON 与表单两种 body，避免超长文案被 GET URL 长度限制截断
  try {
    const contentType = request.headers.get("content-type") || "";
    const inner = new URL(request.url);
    if (contentType.includes("application/json")) {
      const body = await request.json();
      if (body && typeof body.text === "string" && body.text) {
        inner.searchParams.set("text", body.text);
      }
    } else {
      const form = await request.formData();
      const text = form.get("text");
      if (typeof text === "string" && text) {
        inner.searchParams.set("text", text);
      }
    }
    return handle(new Request(inner.toString(), { headers: request.headers }));
  } catch {
    // body 解析失败按无 text 处理，走 400 提示
    return handle(request);
  }
}

export const runtime = "nodejs";
