// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchLxCatalog,
  isLxSourceKey,
  lxCatalogSnapshot,
  lxSearchableSources,
  requestDirect,
  requestLyric,
  requestSearchPage,
  resetLxCatalogCache,
} from "@/lib/music-client";

/**
 * music-client lx 分流单测：目录拉取缓存 / 源识别守卫（内置 GD 源不被抢占）/
 * search / url / lyric 请求改发 /api/music/lx。全局 fetch 打桩，不触真实网络。
 */

/** /api/music/lx?action=sources 正常响应（故意把内置源 netease 也放进目录以验证守卫） */
const CATALOG_OK = {
  code: 200,
  msg: "获取成功",
  data: {
    enabled: true,
    scripts: [{ id: "qdy", url: "https://scripts.example/qdy.js", ok: true, name: "汽水全豆" }],
    searchSources: [
      { key: "qsvip", label: "汽水音乐", qualitys: ["128k", "320k"], scriptId: "qdy" },
      { key: "netease", label: "网抑云（不应出现在动态 chip）", scriptId: "qdy" },
    ],
    allSourceKeys: ["qsvip", "netease", "kuwo"],
  },
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function catalogJsonResponse() {
  return jsonResponse(CATALOG_OK);
}

beforeEach(() => {
  resetLxCatalogCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetLxCatalogCache();
});

describe("fetchLxCatalog · 目录拉取与缓存", () => {
  it("成功后本会话缓存，重复调用不再请求；返回数据可直接消费", async () => {
    const fetchMock = vi.fn(async () => catalogJsonResponse());
    vi.stubGlobal("fetch", fetchMock);
    const cat = await fetchLxCatalog();
    expect(cat.enabled).toBe(true);
    expect(cat.searchSources).toHaveLength(2);
    expect(cat.allSourceKeys).toContain("qsvip");

    const cat2 = await fetchLxCatalog();
    expect(cat2).toBe(cat);
    expect(lxCatalogSnapshot()).toBe(cat);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("目录请求失败 → 拒绝且不写缓存（可重试）", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse({ code: 502, msg: "lx 通道暂不可用，请稍后重试" }, 502)
        : catalogJsonResponse();
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchLxCatalog()).rejects.toThrow(/lx 通道暂不可用/);
    expect(lxCatalogSnapshot()).toBeNull();
    const cat = await fetchLxCatalog();
    expect(cat.searchSources).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("目录异常结构（缺 searchSources/scripts）→ 拒绝", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ code: 200, msg: "ok", data: { enabled: true, allSourceKeys: [] } })
      )
    );
    await expect(fetchLxCatalog()).rejects.toThrow(/目录返回异常/);
    expect(lxCatalogSnapshot()).toBeNull();
  });
});

describe("isLxSourceKey / lxSearchableSources · 源识别守卫", () => {
  it("目录未加载 → 一律非 lx 源", () => {
    expect(isLxSourceKey("qsvip")).toBe(false);
    expect(lxSearchableSources()).toEqual([]);
  });

  it("目录加载后：扩展源算 lx 源，内置 GD 源（即使目录声明）永远不算", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => catalogJsonResponse()));
    await fetchLxCatalog();
    expect(isLxSourceKey("qsvip")).toBe(true);
    // 目录 allSourceKeys 虽含 netease/kuwo，但内置源守卫拒绝抢占
    expect(isLxSourceKey("netease")).toBe(false);
    expect(isLxSourceKey("kuwo")).toBe(false);
    expect(isLxSourceKey("zzz")).toBe(false);
    // 动态 chip 列表也只暴露扩展源（netease 被过滤掉）
    const list = lxSearchableSources();
    expect(list.map((s) => s.key)).toEqual(["qsvip"]);
  });
});

describe("requestSearchPage · lx 源改发 /api/music/lx", () => {
  it("发往 lx search 端点并透传页数据", async () => {
    const data = {
      source: "qsvip",
      keyword: "晴天",
      page: 2,
      hasMore: false,
      count: 1,
      items: [{ id: "s1", urlId: "s1", lyricId: "s1", name: "晴天", artist: ["周杰伦"], source: "qsvip" }],
    };
    const fetchMock = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("action=sources")) return catalogJsonResponse();
      return jsonResponse({ code: 200, msg: "搜索成功", data });
    });
    vi.stubGlobal("fetch", fetchMock);
    await fetchLxCatalog(); // 目录加载后 qsvip 才被识别为 lx 源
    const result = await requestSearchPage("qsvip", "晴天", 2, new AbortController().signal);
    expect(result.source).toBe("qsvip");
    expect(result.page).toBe(2);
    expect(result.items[0].name).toBe("晴天");
    const lastUrl = String(fetchMock.mock.calls[1][0]);
    expect(lastUrl).toContain("/api/music/lx?");
    expect(lastUrl).toContain("action=search");
    expect(lastUrl).toContain("count=20");
    // 不经过 GD 直连域名
    expect(lastUrl).not.toContain("gdstudio");
  });

  it("lx 源没有 GD 式直连兜底：502 → 直接抛错（不再 fallback 到直连域名）", async () => {
    const fetchMock = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("action=sources")) return catalogJsonResponse();
      return jsonResponse({ code: 502, msg: "音源脚本执行失败", failType: "script-error" }, 502);
    });
    vi.stubGlobal("fetch", fetchMock);
    await fetchLxCatalog(); // 目录加载后 qsvip 才被识别为 lx 源
    await expect(
      requestSearchPage("qsvip", "晴天", 1, new AbortController().signal)
    ).rejects.toThrow(/音源脚本执行失败/);
    expect(String(fetchMock.mock.calls[1][0])).not.toContain("gdstudio");
  });
});

describe("requestDirect · lx 源直链", () => {
  it("发往 lx url 端点并返回直链数据", async () => {
    const data = { url: "https://cdn.example/qsvip/s1.mp3", br: 320, size: 100, source: "qsvip", id: "s1" };
    const fetchMock = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("action=sources")) return catalogJsonResponse();
      return jsonResponse({ code: 200, msg: "获取成功", data });
    });
    vi.stubGlobal("fetch", fetchMock);
    await fetchLxCatalog(); // 目录加载后 qsvip 才被识别为 lx 源
    const result = await requestDirect("qsvip", "s1", "320", new AbortController().signal);
    expect(result.url).toBe("https://cdn.example/qsvip/s1.mp3");
    const url = String(fetchMock.mock.calls[1][0]);
    expect(url).toContain("/api/music/lx?");
    expect(url).toContain("action=url");
  });

  it("脚本无可用 url → 拒绝并提示未找到播放链接", async () => {
    const fetchMock = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("action=sources")) return catalogJsonResponse();
      return jsonResponse({ code: 404, msg: "未找到该歌曲的播放链接，歌曲可能已下架或该音乐源暂无可播音源" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      requestDirect("qsvip", "s1", "320", new AbortController().signal)
    ).rejects.toThrow(/播放链接/);
  });
});

describe("requestLyric · lx 源歌词", () => {
  it("发往 lx lyric 端点并返回 trim 后的文本歌词", async () => {
    const fetchMock = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("action=sources")) return catalogJsonResponse();
      return jsonResponse({
        code: 200,
        msg: "获取成功",
        data: { lyric: "  [00:01.00]词  " },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await fetchLxCatalog(); // 目录加载后 qsvip 才被识别为 lx 源
    const lyric = await requestLyric("qsvip", "s1", new AbortController().signal);
    expect(lyric).toBe("[00:01.00]词");
    const url = String(fetchMock.mock.calls[1][0]);
    expect(url).toContain("/api/music/lx?");
    expect(url).toContain("action=lyric");
  });

  it("空歌词/异常结构 → 拒绝提示歌词获取失败", async () => {
    const fetchMock = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("action=sources")) return catalogJsonResponse();
      return jsonResponse({ code: 200, msg: "获取成功", data: {} });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      requestLyric("qsvip", "s1", new AbortController().signal)
    ).rejects.toThrow(/歌词获取失败/);
  });
});
