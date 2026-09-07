import { createApiHandler } from "@/lib/api-middleware";
import { parseYoutube } from "@/lib/youtube";

export const runtime = "nodejs";

/**
 * GET /api/youtube?url=...
 * 解析 YouTube 视频（watch / youtu.be / Shorts / embed / live）
 */
export const GET = createApiHandler(parseYoutube);
