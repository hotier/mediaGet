// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  selfSearch: vi.fn(),
  hasSelfSearchNextPage: vi.fn(),
  getKugouPlayUrl: vi.fn(),
}));

vi.mock("@/lib/self-search", async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    selfSearch: mocked.selfSearch,
    hasSelfSearchNextPage: mocked.hasSelfSearchNextPage,
  };
});

// 取直链走真实 normalizeKugouHash；只 stub 网络编排 getKugouPlayUrl
vi.mock("@/lib/self-search/kugou", async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, getKugouPlayUrl: mocked.getKugouPlayUrl };
});

import { GET } from "@/app/api/music/self/route";
import { SelfSearchError } from "@/lib/self-search/errors";

/** 自研搜索 route 集成单测：mock provider 层（selfSearch），归一化/缓存/校验走真实实现。 */

function item(overrides = {}) {
  return {
    id: "kugou-1",
    name: "晴天",
    artist: ["周杰伦"],
    album: "叶惠美",
    source: "kugou",
    urlId: "kugou-1",
    lyricId: "kugou-1",
    ...overrides,
  };
}

async function callSelf(params = {}) {
  const url = new URL("http://localhost/api/music/self");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }
  const req = new Request(url.toString(), { headers: { "user-agent": "vitest" } });
  return GET(req);
}

beforeEach(() => {
  mocked.selfSearch.mockReset();
  mocked.selfSearch.mockResolvedValue({
    source: "kugou",
    items: [item()],
    total: 33,
  });
  mocked.hasSelfSearchNextPage.mockReset();
  mocked.hasSelfSearchNextPage.mockReturnValue(false);
  mocked.getKugouPlayUrl.mockReset();
  mocked.getKugouPlayUrl.mockResolvedValue({ url: "https://sharefs.kugou.com/a.mp3", br: 128, size: 1000 });
});

describe("GET /api/music/self · 入参校验", () => {
  it("缺 source → 400 并列出支持源", async () => {
    const res = await callSelf({ action: "search", keyword: "晴天" });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe(400);
    expect(json.msg).toContain("source");
    const keys = json.supportedSources.map((s) => s.key);
    expect(keys).toContain("netease");
    expect(keys).toContain("migu");
  });

  it("非白名单 source → 400", async () => {
    const res = await callSelf({ action: "search", source: "joox", keyword: "晴天" });
    expect(res.status).toBe(400);
    expect(mocked.selfSearch).not.toHaveBeenCalled();
  });

  it("未知 action → 400 提示仅支持 search / url", async () => {
    const res = await callSelf({ action: "foo", keyword: "晴天" });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.msg).toContain("search");
    expect(mocked.selfSearch).not.toHaveBeenCalled();
  });

  it("keyword 纯空白 → 400 不触发 provider", async () => {
    const res = await callSelf({ action: "search", source: "kugou", keyword: "  " });
    expect(res.status).toBe(400);
    expect(mocked.selfSearch).not.toHaveBeenCalled();
  });
});

describe("GET /api/music/self · action=search", () => {
  it("成功 → 归一 items + line(kind=self) + 参数回传", async () => {
    mocked.hasSelfSearchNextPage.mockReturnValue(true);
    const res = await callSelf({
      action: "search",
      source: "kugou",
      keyword: "晴天",
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(mocked.selfSearch).toHaveBeenCalledWith("kugou", "晴天", 1, 20);
    expect(mocked.hasSelfSearchNextPage).toHaveBeenCalledWith({
      page: 1,
      limit: 20,
      read: 1,
      total: 33,
    });
    expect(json.data.source).toBe("kugou");
    expect(json.data.hasMore).toBe(true);
    expect(json.data.count).toBe(1);
    expect(json.data.items[0]).toMatchObject({ id: "kugou-1", source: "kugou" });
    expect(json.data.line).toEqual({ kind: "self", base: "self-search" });
  });

  it("count 超上限被夹到 30、page 下限 1", async () => {
    await callSelf({ action: "search", source: "kugou", keyword: "x", count: "999", page: "0" });
    expect(mocked.selfSearch).toHaveBeenCalledWith("kugou", "x", 1, 30);
  });

  it("空结果正常返回（非错误）", async () => {
    mocked.selfSearch.mockResolvedValue({ source: "netease", items: [], total: 0 });
    mocked.hasSelfSearchNextPage.mockReturnValue(false);
    const res = await callSelf({ action: "search", source: "netease", keyword: "zzz不存在" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.items).toEqual([]);
    expect(json.data.count).toBe(0);
  });

  it("第二次相同请求走缓存，provider 只被调一次", async () => {
    const kw = "晴天缓存";
    const params = { action: "search", source: "kugou", keyword: kw };
    const r1 = await callSelf(params);
    expect(r1.status).toBe(200);
    const r2 = await callSelf(params);
    expect(r2.status).toBe(200);
    expect(mocked.selfSearch).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/music/self · action=url（酷狗官方试听直链）", () => {
  it("仅支持 kugou：其它 source → 400", async () => {
    const res = await callSelf({ action: "url", source: "migu", hash: "A".repeat(32) });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.msg).toContain("kugou");
    expect(mocked.getKugouPlayUrl).not.toHaveBeenCalled();
  });

  it("hash 为空 / 非法（非 32 位十六进制）→ 400，不触达 provider", async () => {
    const r1 = await callSelf({ action: "url", source: "kugou" });
    expect(r1.status).toBe(400);
    const j1 = await r1.json();
    expect(j1.msg).toContain("FileHash");
    const r2 = await callSelf({ action: "url", source: "kugou", hash: "zzz-not-hash" });
    expect(r2.status).toBe(400);
    expect(mocked.getKugouPlayUrl).not.toHaveBeenCalled();
  });

  it("成功 → 200 data{url,br,size,source,id}（id 归一为大写 FileHash）", async () => {
    const res = await callSelf({
      action: "url",
      source: "kugou",
      hash: "48c685f679ffc7cf08b8a8341ca9db44",
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(mocked.getKugouPlayUrl).toHaveBeenCalledWith(
      "48C685F679FFC7CF08B8A8341CA9DB44"
    );
    expect(json.data).toMatchObject({
      url: "https://sharefs.kugou.com/a.mp3",
      br: 128,
      source: "kugou",
      id: "48C685F679FFC7CF08B8A8341CA9DB44",
    });
  });

  it("取链不受 search 缓存影响（同一 hash 两次请求都打到 provider）", async () => {
    const p = { action: "url", source: "kugou", hash: "A".repeat(32) };
    await callSelf(p);
    await callSelf(p);
    expect(mocked.getKugouPlayUrl).toHaveBeenCalledTimes(2);
  });

  it("VIP/付费 → 404 + failType=vip-only", async () => {
    mocked.getKugouPlayUrl.mockRejectedValue(
      new SelfSearchError("vip-only", "该歌曲为 VIP/付费歌曲，酷狗官方暂不提供免费试听直链")
    );
    const res = await callSelf({ action: "url", source: "kugou", hash: "B".repeat(32) });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.failType).toBe("vip-only");
    expect(json.msg).toContain("VIP");
  });

  it("not-found → 404；sources-down → 502", async () => {
    mocked.getKugouPlayUrl.mockRejectedValue(
      new SelfSearchError("not-found", "未找到该歌曲的酷狗试听直链")
    );
    const r1 = await callSelf({ action: "url", source: "kugou", hash: "C".repeat(32) });
    expect(r1.status).toBe(404);
    expect((await r1.json()).failType).toBe("not-found");

    mocked.getKugouPlayUrl.mockRejectedValue(new SelfSearchError("sources-down", "接口风控"));
    const r2 = await callSelf({ action: "url", source: "kugou", hash: "C".repeat(32) });
    expect(r2.status).toBe(502);
    expect((await r2.json()).failType).toBe("sources-down");
  });

  it("其它异常 → 502 兜底文案", async () => {
    mocked.getKugouPlayUrl.mockRejectedValue(new Error("boom"));
    const res = await callSelf({ action: "url", source: "kugou", hash: "D".repeat(32) });
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.failType).toBe("sources-down");
  });
});

describe("GET /api/music/self · 错误分类", () => {
  it("SelfSearchError(source-unavailable) → 400 透传 failType", async () => {
    mocked.selfSearch.mockRejectedValue(
      new SelfSearchError("source-unavailable", "自研搜索暂未支持该 source：zzz")
    );
    const res = await callSelf({ action: "search", source: "netease", keyword: "x" });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.failType).toBe("source-unavailable");
  });

  it("SelfSearchError(sources-down) → 502 透传业务文案", async () => {
    mocked.selfSearch.mockRejectedValue(
      new SelfSearchError("sources-down", "网易云搜索接口返回结构异常")
    );
    const res = await callSelf({ action: "search", source: "netease", keyword: "晴天" });
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.failType).toBe("sources-down");
    expect(json.msg).toContain("网易云");
  });

  it("其它异常 → 502 兜底文案", async () => {
    mocked.selfSearch.mockRejectedValue(new Error("boom"));
    const res = await callSelf({ action: "search", source: "netease", keyword: "晴天" });
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.failType).toBe("sources-down");
  });
});
