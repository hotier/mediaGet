/**
 * 分享文案解析入口（兼容别名）—— 实现见 src/lib/parse-handler.js
 *
 * 本入口保持原契约：只接收 text=（整段分享文案，含标题/引导语），自动提取其中
 * 链接后，走与 /api/parse 完全相同的解析链路（平台识别、限流、SSRF 校验、
 * 共享缓存、并发去重、字段归一化、行为统计、fmt=text）。
 *
 * 新调用方建议统一使用 /api/parse（支持 url=/text=，GET/POST 均可），
 * 本入口保留给既有调用方（如 iOS 快捷指令），对外行为与报错文案不变。
 *
 * 支持 GET（?text=…）与 POST（JSON body: {"text": "…"} 或表单 text=…），
 * POST 用于超长文案，避免 GET URL 长度限制截断。
 */

import { handleParseRequest } from "@/lib/parse-handler";

export async function GET(request) {
  return handleParseRequest(request, { textOnly: true });
}

export async function POST(request) {
  return handleParseRequest(request, { textOnly: true });
}

export const runtime = "nodejs";
