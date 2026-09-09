// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  getLxCatalog: vi.fn(),
  lxScriptInvoke: vi.fn(),
}));

vi.mock("@/lib/lx-provider", async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    getLxCatalog: mocked.getLxCatalog,
    lxScriptInvoke: mocked.lxScriptInvoke,
  };
});

import { GET } from "@/app/api/music/lx/route";
import { LxProviderError } from "@/lib/lx-provider";

/**
 * /api/music/lx route 集成单测：mock provider 层（getLxCatalog / lxScriptInvoke），
 * 归一化与错误分类逻辑走真实实现，验证 sources/search/url/lyric 各分支与契约。
 */

async function callLx(params = {}) {
  const url = new URL("http://localhost/api/music/lx");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }
  const req = new Request(url.toString(), { headers: { "user-agent": "vitest" } });
  return GET(req);
}

/** 脚本 musicSearch 常规返回 */
function searchScriptResult() {
  return {
    list: [{ id: "1024", name: "晴天", singer: ["周杰伦"], url_id: "1024", lyric_id: "1024" }],
  };
}

const CATALOG_OK = {
  scripts: [{ id: "qdy", url: "https://scripts.example/qdy.js", ok: true, name: "汽水全豆" }],
  sources: [
    {
      key: "qdy",
      name: "汽水音乐",
      type: "music",
      actions: ["musicSearch", "musicUrl", "lyric"],
      qualitys: ["128k", "320k", "flac"],
      scriptId: "qdy",
    },
  ],
  searchSources: [
    {
      key: "qdy",
      name: "汽水音乐",
      actions: ["musicSearch", "musicUrl", "lyric"],
      qualitys: ["128k", "320k", "flac"],
      scriptId: "qdy",
    },
  ],
  urlFallbacks: [{ platform: "netease", source: "qdy" }],
};

beforeEach(() => {
  mocked.getLxCatalog.mockReset();
  mocked.getLxCatalog.mockResolvedValue({
    scripts: [],
    sources: [],
    searchSources: [],
  });
  mocked.lxScriptInvoke.mockReset();
  mocked.lxScriptInvoke.mockResolvedValue(searchScriptResult());
});

describe("GET /api/music/lx · action=sources", () => {
  it("未配置脚本 → enabled=false 空目录", async () => {
    const res = await callLx({ action: "sources" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.enabled).toBe(false);
    expect(json.data.scripts).toEqual([]);
    expect(json.data.searchSources).toEqual([]);
    expect(json.data.allSourceKeys).toEqual([]);
    expect(json.data.urlFallbacks).toEqual([]);
  });

  it("配置脚本 → 展开可搜索源（key/label/qualitys/scriptId）、全部 key 与音源兜底映射", async () => {
    mocked.getLxCatalog.mockResolvedValue(CATALOG_OK);
    const res = await callLx({ action: "sources" });
    const json = await res.json();
    expect(json.data.enabled).toBe(true);
    expect(json.data.searchSources).toEqual([
      { key: "qdy", label: "汽水音乐", qualitys: ["128k", "320k", "flac"], scriptId: "qdy" },
    ]);
    expect(json.data.allSourceKeys).toEqual(["qdy"]);
    expect(json.data.urlFallbacks).toEqual([{ platform: "netease", source: "qdy" }]);
  });

  it("目录层故障 → 502 script-not-ready", async () => {
    mocked.getLxCatalog.mockRejectedValue(
      new LxProviderError("脚本加载失败", "script-not-ready")
    );
    const res = await callLx({ action: "sources" });
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.failType).toBe("script-not-ready");
    expect(json.msg).toContain("脚本加载失败");
  });
});

describe("GET /api/music/lx · 入参校验", () => {
  it("缺 source → 400 提示（任意非 sources action）", async () => {
    const res = await callLx({ action: "search", keyword: "晴天" });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe(400);
    expect(json.msg).toContain("source");
  });

  it("search 缺 keyword → 400", async () => {
    const res = await callLx({ action: "search", source: "qdy" });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.msg).toContain("keyword");
  });

  it("url 缺 id → 400（默认 action=url）", async () => {
    const res = await callLx({ source: "qdy" });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.msg).toContain("id");
  });

  it("lyric 缺 id → 400", async () => {
    const res = await callLx({ action: "lyric", source: "qdy" });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.msg).toContain("id");
  });

  it("未知 action → 400 列出支持动作", async () => {
    const res = await callLx({ action: "foo", source: "qdy", keyword: "x" });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.msg).toContain("sources/search/url/lyric");
  });
});

describe("GET /api/music/lx · action=search", () => {
  it("成功 → 归一 items + source/keyword/page 回传", async () => {
    const res = await callLx({ action: "search", source: "qdy", keyword: "晴天" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(mocked.lxScriptInvoke).toHaveBeenCalledWith({
      source: "qdy",
      action: "musicSearch",
      info: { keyword: "晴天", page: 1, pagesize: 20 },
    });
    expect(json.data.source).toBe("qdy");
    expect(json.data.keyword).toBe("晴天");
    expect(json.data.page).toBe(1);
    expect(json.data.items).toHaveLength(1);
    expect(json.data.items[0]).toMatchObject({
      id: "1024",
      name: "晴天",
      artist: ["周杰伦"],
      source: "qdy",
    });
  });

  it("keyword 纯空白 → 400 不触脚本", async () => {
    const res = await callLx({ action: "search", source: "qdy", keyword: "  " });
    expect(res.status).toBe(400);
    expect(mocked.lxScriptInvoke).not.toHaveBeenCalled();
  });
});

describe("GET /api/music/lx · action=url", () => {
  it("成功 → 返回直链/码率/大小，type 由 br 映射", async () => {
    mocked.lxScriptInvoke.mockResolvedValue({
      url: "https://cdn.example/1024.mp3",
      br: 320,
      size: 9021,
    });
    const res = await callLx({ action: "url", source: "qdy", id: "1024", br: "320" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(mocked.lxScriptInvoke).toHaveBeenCalledWith({
      source: "qdy",
      action: "musicUrl",
      info: {
        type: "320k",
        musicInfo: expect.objectContaining({
          id: "1024",
          songmid: "1024",
          songId: "1024",
          hash: "1024",
        }),
      },
    });
    expect(json.data.url).toBe("https://cdn.example/1024.mp3");
    expect(json.data.br).toBe(320);
    expect(json.data.size).toBe(9021);
    expect(json.data.id).toBe("1024");
  });

  it("br=999 → 映射 flac24bit 传给脚本", async () => {
    mocked.lxScriptInvoke.mockResolvedValue({ url: "https://cdn.example/1024.flac" });
    await callLx({ action: "url", source: "qdy", id: "1024", br: "999" });
    expect(mocked.lxScriptInvoke).toHaveBeenCalledWith(
      expect.objectContaining({ info: expect.objectContaining({ type: "flac24bit" }) })
    );
  });

  it("脚本无可用 url → 404", async () => {
    mocked.lxScriptInvoke.mockResolvedValue({});
    const res = await callLx({ action: "url", source: "qdy", id: "1024" });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.msg).toContain("播放链接");
  });
});

describe("GET /api/music/lx · action=lyric", () => {
  it("成功 → 返回纯文本歌词", async () => {
    mocked.lxScriptInvoke.mockResolvedValue({ lyric: "[00:01.00]词" });
    const res = await callLx({ action: "lyric", source: "qdy", id: "1024" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(mocked.lxScriptInvoke).toHaveBeenCalledWith({
      source: "qdy",
      action: "lyric",
      info: { musicInfo: { id: "1024" } },
    });
    expect(json.data.lyric).toBe("[00:01.00]词");
  });
});

describe("GET /api/music/lx · 错误分类", () => {
  it("LxProviderError(source-not-found) → 400 source-unavailable", async () => {
    mocked.lxScriptInvoke.mockRejectedValue(
      new LxProviderError("lx 脚本未提供该 source：zzz（已加载：qdy）", "source-not-found")
    );
    const res = await callLx({ action: "search", source: "zzz", keyword: "x" });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.failType).toBe("source-unavailable");
    expect(json.msg).toContain("zzz");
  });

  it("脚本内部抛错 → 502 script-error，msg 原样透传", async () => {
    mocked.lxScriptInvoke.mockRejectedValue(new Error("所有源均失败，请稍后重试"));
    const res = await callLx({ action: "search", source: "qdy", keyword: "x" });
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.failType).toBe("script-error");
    expect(json.msg).toContain("所有源均失败");
  });

  it("非 Error 值拒绝 → 502 兜底文案", async () => {
    mocked.lxScriptInvoke.mockRejectedValue("boom");
    const res = await callLx({ action: "search", source: "qdy", keyword: "x" });
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.failType).toBe("script-error");
  });
});
