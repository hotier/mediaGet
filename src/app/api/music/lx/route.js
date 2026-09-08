import { getCorsHeaders } from "@/lib/api-utils";
import {
  LxProviderError,
  brToLxQuality,
  getLxCatalog,
  lxScriptInvoke,
  normalizeLxSearchResponse,
  pickLxLyric,
  pickLxUrl,
} from "@/lib/lx-provider";

export const runtime = "nodejs";

/**
 * 洛雪(lx-music)生态音源 Provider 接口（音乐源 Provider · provider=lx）：
 *   GET /api/music/lx?action=sources
 *   GET /api/music/lx?action=search&source=qsvip&keyword=<关键词>&page=1&count=20
 *   GET /api/music/lx?action=url&source=qsvip&id=<歌曲ID>&br=320
 *   GET /api/music/lx?action=lyric&source=qsvip&id=<歌曲ID>
 *
 * 与 /api/music（provider=gd，GD 公共上游契约）互补：本接口把配置的洛雪自定义
 * 音源脚本（MUSIC_LX_SCRIPTS 环境变量，qdy/qsvip 类）按 lx-host 沙箱执行，把
 * 脚本内声明的 source/action 暴露成与 /api/music 一致的动作契约。响应均遵循
 * { code, msg, data }。仅能在 nodejs runtime 运行（本机 / Vercel / Docker）。
 */

const SEARCH_PAGE_MAX = 20;
const NOT_FOUND_MSG = "未找到该歌曲的播放链接，歌曲可能已下架或该音乐源暂无可播音源";

/** 归类 provider/脚本侧错误 → 对外 code/failType/msg */
function classifyError(err) {
  if (err instanceof LxProviderError) {
    if (err.failType === "source-not-found") {
      return { code: 400, failType: "source-unavailable", msg: err.message };
    }
    // script-not-ready / 其它 provider 态：通道/脚本加载层故障
    return { code: 502, failType: "script-not-ready", msg: err.message };
  }
  const msg =
    err && typeof err.message === "string" && err.message
      ? err.message
      : "音源脚本执行失败，请稍后重试";
  // 脚本内部抛的业务语义（如“所有源均失败 / 未返回可用URL”）贴近 502 通道态，
  // 前端会原样展示 msg，不触发浏览器直连降级（lx 源本来只在 Node 侧可执行）。
  return { code: 502, failType: "script-error", msg };
}

export async function GET(request) {
  const corsHeaders = getCorsHeaders(request.headers.get("origin") || "");
  const send = (payload, status = 200) =>
    Response.json(payload, { status, headers: corsHeaders });

  const { searchParams } = new URL(request.url);
  const source = (searchParams.get("source") || "").trim();
  const action = (searchParams.get("action") || "url").trim().toLowerCase();

  if (action === "sources") {
    try {
      const catalog = await getLxCatalog();
      return send({
        code: 200,
        msg: "获取成功",
        data: {
          enabled: catalog.scripts.length > 0,
          scripts: catalog.scripts,
          searchSources: catalog.searchSources.map((s) => ({
            key: s.key,
            label: s.name,
            qualitys: s.qualitys,
            scriptId: s.scriptId,
          })),
          allSourceKeys: catalog.sources.map((s) => s.key),
        },
      });
    } catch (err) {
      const e = classifyError(err);
      return send({ code: e.code, msg: e.msg, failType: e.failType }, e.code);
    }
  }

  // —— 除 sources 外都需要 source ——
  if (!source) {
    return send(
      {
        code: 400,
        msg: "缺少 source：请指定 lx 脚本声明的源 key（如 qsvip）",
        usage: "/api/music/lx?action=sources",
      },
      400
    );
  }

  // —— action=search 关键词搜索 ——
  if (action === "search") {
    const keyword = (searchParams.get("keyword") ?? searchParams.get("name") ?? "").trim();
    if (!keyword) {
      return send(
        {
          code: 400,
          msg: "keyword 为空：请输入要搜索的歌曲关键词",
          usage: "/api/music/lx?action=search&source=qsvip&keyword=<关键词>",
        },
        400
      );
    }
    const page = Math.max(1, Number(searchParams.get("page")) || 1);
    const count = Math.min(30, Math.max(1, Number(searchParams.get("count")) || 20));
    try {
      const result = await lxScriptInvoke({
        source,
        action: "musicSearch",
        info: { keyword, page, pagesize: count },
      });
      const { items, isEnd } = normalizeLxSearchResponse(result, source);
      const hasMore = page < SEARCH_PAGE_MAX && items.length > 0 && !isEnd;
      return send({
        code: 200,
        msg: "搜索成功",
        data: { source, keyword, page, hasMore, count: items.length, items },
      });
    } catch (err) {
      const e = classifyError(err);
      return send({ code: e.code, msg: e.msg, failType: e.failType }, e.code);
    }
  }

  // —— action=url（默认）：source + id → 直链 ——
  if (action === "url") {
    const id = (searchParams.get("id") ?? searchParams.get("url_id") ?? "").trim();
    if (!id) {
      return send(
        {
          code: 400,
          msg: "id 为空：请传入该 source 下的歌曲 ID",
          usage: "/api/music/lx?action=url&source=qsvip&id=<歌曲ID>&br=320",
        },
        400
      );
    }
    const quality = brToLxQuality(searchParams.get("br"));
    // musicInfo 只给脚本需要的“能被各种 id 形式命中”的字段；
    // 附带参数（songmid/hash/title/artist/album）用于未来跨源链路透传
    const musicInfo = {
      id,
      songmid: searchParams.get("songmid") || id,
      songId: id,
      hash: searchParams.get("hash") || id,
      ...(searchParams.get("title") || searchParams.get("name")
        ? { name: searchParams.get("title") || searchParams.get("name") }
        : {}),
      ...(searchParams.get("artist") || searchParams.get("singer")
        ? { singer: searchParams.get("artist") || searchParams.get("singer") }
        : {}),
      ...(searchParams.get("album") ? { albumName: searchParams.get("album") } : {}),
    };
    try {
      const result = await lxScriptInvoke({
        source,
        action: "musicUrl",
        info: { type: quality, musicInfo },
      });
      const url = pickLxUrl(result).trim();
      if (!url) {
        return send({ code: 404, msg: NOT_FOUND_MSG }, 404);
      }
      const brNum = Number(searchParams.get("br")) || 320;
      let size = 0;
      let brActual = brNum;
      if (result && typeof result === "object") {
        if (Number(result.size)) size = Number(result.size);
        if (Number(result.br)) brActual = Number(result.br);
      }
      return send({
        code: 200,
        msg: "获取成功",
        data: { url, br: brActual, size, source, id },
      });
    } catch (err) {
      const e = classifyError(err);
      return send({ code: e.code, msg: e.msg, failType: e.failType }, e.code);
    }
  }

  // —— action=lyric ——
  if (action === "lyric") {
    const id = (searchParams.get("id") ?? searchParams.get("lyric_id") ?? "").trim();
    if (!id) {
      return send(
        {
          code: 400,
          msg: "id 为空：请传入需要取歌词的歌曲 ID",
          usage: "/api/music/lx?action=lyric&source=qsvip&id=<歌曲ID>",
        },
        400
      );
    }
    try {
      const result = await lxScriptInvoke({
        source,
        action: "lyric",
        info: { musicInfo: { id } },
      });
      const lyric = pickLxLyric(result).trim();
      return send({ code: 200, msg: "获取成功", data: { lyric } });
    } catch (err) {
      const e = classifyError(err);
      return send({ code: e.code, msg: e.msg, failType: e.failType }, e.code);
    }
  }

  // —— 未支持 action ——
  return send(
    {
      code: 400,
      msg: `lx provider 不支持该 action：${action}（支持 sources/search/url/lyric）`,
    },
    400
  );
}
