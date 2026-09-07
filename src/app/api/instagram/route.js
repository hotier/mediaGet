import { createApiHandler } from "@/lib/api-middleware";
import { parseInstagram } from "@/lib/instagram";

export const runtime = "nodejs";

/**
 * GET /api/instagram?url=...
 * 解析 Instagram 帖子 / Reels / 图集
 */
export const GET = createApiHandler(parseInstagram);
