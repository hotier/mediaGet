/**
 * 统一解析入口（主入口，全平台共用）—— 实现见 src/lib/parse-handler.js
 *
 * 支持的调用形态（GET 与 POST 均可；POST body 支持 JSON 与表单）：
 * 1. url=分享链接（纯链接；整段分享文案也可，服务端自动提取）
 * 2. text=整段分享文案（原 /api/parse-text 的能力并入本接口）
 * 3. source=平台&id=视频ID（部分平台支持 ID 直查）
 *
 * 长文案建议用 POST（GET 受 URL 长度限制）：
 *   POST /api/parse  Content-Type: application/json
 *   {"text": "…整段分享文案…"}   或   {"url": "https://…"}
 *
 * 参考: https://github.com/wujunwei928/parse-video
 */

import { handleParseRequest } from "@/lib/parse-handler";

export async function GET(request) {
  return handleParseRequest(request);
}

export async function POST(request) {
  return handleParseRequest(request);
}

export const runtime = "nodejs";
