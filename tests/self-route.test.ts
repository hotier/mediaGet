// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  selfSearch: vi.fn(),
  hasSelfSearchNextPage: vi.fn(),
}));

vi.mock("@/lib/self-search", async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    selfSearch: mocked.selfSearch,
    hasSelfSearchNextPage: mocked.hasSelfSearchNextPage,
  };
});

import { GET } from "@/app/api/music/self/route";
import { SelfSearchError } from "@/lib/self-search/errors";

/** 自研搜索 route 集成单测：mock provider 层（selfSearch），归一化/缓存/校验走真实实现。 */

function item(overrides = {}) {
  return {
    id: "003OUlho2HcRHCy",
    name: "晴天",
    artist: ["周杰伦"],
    album: "叶惠美",
    source: "tencent",
    urlId: "003OUlho2HcRHCy",
    lyricId: "003OUlho2HcRHCy",
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
    source: "tencent",
    items: [item()],
    total: 33,
  });
  mocked.hasSelfSearchNextPage.mockReset();
  mocked.hasSelfSearchNextPage.mockReturnValue(false);
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

  it("未知 action → 400 提示仅支持 search", async () => {
    const res = await callSelf({ action: "url", source: "tencent", id: "x" });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.msg).toContain("search");
  });

  it("keyword 纯空白 → 400 不触发 provider", async () => {
    const res = await callSelf({ action: "search", source: "tencent", keyword: "  " });
    expect(res.status).toBe(400);
    expect(mocked.selfSearch).not.toHaveBeenCalled();
  });
});

describe("GET /api/music/self · action=search", () => {
  it("成功 → 归一 items + line(kind=self) + 参数回传", async () => {
    mocked.hasSelfSearchNextPage.mockReturnValue(true);
    const res = await callSelf({
      action: "search",
      source: "tencent",
      keyword: "晴天",
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(mocked.selfSearch).toHaveBeenCalledWith("tencent", "晴天", 1, 20);
    expect(mocked.hasSelfSearchNextPage).toHaveBeenCalledWith({
      page: 1,
      limit: 20,
      read: 1,
      total: 33,
    });
    expect(json.data.source).toBe("tencent");
    expect(json.data.hasMore).toBe(true);
    expect(json.data.count).toBe(1);
    expect(json.data.items[0]).toMatchObject({ id: "003OUlho2HcRHCy", source: "tencent" });
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
    const params = { action: "search", source: "tencent", keyword: kw };
    const r1 = await callSelf(params);
    expect(r1.status).toBe(200);
    const r2 = await callSelf(params);
    expect(r2.status).toBe(200);
    expect(mocked.selfSearch).toHaveBeenCalledTimes(1);
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
