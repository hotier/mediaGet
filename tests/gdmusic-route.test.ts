// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/music/route.js";

const UPSTREAM = "https://music-api.gdstudio.xyz/api.php";

describe("GET /api/music（通用音乐源获取）", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("成功：代理上游返回统一契约并带上游直链", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          url: "https://m701.music.126.net/2026xxx.mp3",
          br: 128,
          size: 5217010,
          from: "music.gdstudio.xyz",
        }),
        { status: 200 }
      )
    );

    const res = await GET(
      new Request("http://127.0.0.1/api/music?source=netease&id=347230&br=128", {
        headers: { "x-forwarded-for": "203.0.113.42" },
      })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      code: 200,
      msg: "获取成功",
      data: {
        url: "https://m701.music.126.net/2026xxx.mp3",
        br: 128,
        size: 5217010,
        source: "netease",
        id: "347230",
      },
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const upstreamUrl = global.fetch.mock.calls[0][0];
    expect(upstreamUrl).toBe(
      `${UPSTREAM}?types=url&source=netease&id=347230&br=128`
    );
  });

  it("source/br 缺省时用默认值 netease/999", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          url: "https://cdn.example/a.mp3",
          br: 999,
          size: 1,
        }),
        { status: 200 }
      )
    );

    await GET(
      new Request("http://127.0.0.1/api/music?id=9999", {
        headers: { "x-forwarded-for": "203.0.113.42" },
      })
    );
    expect(global.fetch.mock.calls[0][0]).toBe(
      `${UPSTREAM}?types=url&source=netease&id=9999&br=999`
    );
  });

  it("曲目不存在（上游 url 为空）→ 404 + failType=not-found", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ url: "", br: 0, size: 0 }), { status: 200 })
    );

    const res = await GET(
      new Request("http://127.0.0.1/api/music?id=999999999999", {
        headers: { "x-forwarded-for": "203.0.113.42" },
      })
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.code).toBe(404);
    expect(json.failType).toBe("not-found");
  });

  it("上游 source 被拒 → 400 + failType=source-unavailable", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ detail: "Value of `source` is not supported." }),
        { status: 200 }
      )
    );

    const res = await GET(
      new Request("http://127.0.0.1/api/music?source=joox&id=1", {
        headers: { "x-forwarded-for": "203.0.113.42" },
      })
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe(400);
    expect(json.failType).toBe("source-unavailable");
  });

  it("上游网络异常 → 502 + failType=sources-down，不访问缓存", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNRESET"));

    const res = await GET(
      new Request("http://127.0.0.1/api/music?source=kuwo&id=55555", {
        headers: { "x-forwarded-for": "203.0.113.42" },
      })
    );
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.code).toBe(502);
    expect(json.failType).toBe("sources-down");
  });

  it("缺少 id → 400", async () => {
    const res = await GET(
      new Request("http://127.0.0.1/api/music?source=netease", {
        headers: { "x-forwarded-for": "203.0.113.42" },
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe(400);
  });

  it("不支持 source / 非法 br → 400", async () => {
    const resSource = await GET(
      new Request("http://127.0.0.1/api/music?source=baidu&id=1", {
        headers: { "x-forwarded-for": "203.0.113.42" },
      })
    );
    expect(resSource.status).toBe(400);
    expect((await resSource.json()).msg).toContain("source");

    const resBr = await GET(
      new Request("http://127.0.0.1/api/music?source=netease&id=1&br=96", {
        headers: { "x-forwarded-for": "203.0.113.42" },
      })
    );
    expect(resBr.status).toBe(400);
    expect((await resBr.json()).msg).toContain("br");
  });

  it("fmt=text：成功输出直链一行", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ url: "https://cdn.example/b.mp3", br: 320, size: 9 }),
        { status: 200 }
      )
    );

    const res = await GET(
      new Request(
        // tencent 播放引擎默认停用会被平台开关拦截；改用默认开启的 kuwo 验证 fmt=text 契约
        "http://127.0.0.1/api/music?source=kuwo&id=777777&br=320&fmt=text",
        { headers: { "x-forwarded-for": "203.0.113.42" } }
      )
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("https://cdn.example/b.mp3");
  });

  it("fmt=text：失败输出错误文案", async () => {
    const res = await GET(
      new Request("http://127.0.0.1/api/music?fmt=text", {
        headers: { "x-forwarded-for": "203.0.113.42" },
      })
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("id");
  });
});

describe("GET /api/music?action=search（关键词搜歌）", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("成功：代理上游 types=search 并归一列表，count/page 缺省取 20/1", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          { id: "2652820720", name: "晴天(深情版)", artist: ["Lucky小爱"], album: "晴天(深情版)", url_id: "2652820720", source: "netease" },
          { id: "1945894789", name: "晴天 (钢琴版)", artist: ["纪钧瀚"], album: "流行轻音乐", url_id: "1945894789", source: "netease" },
        ]),
        { status: 200 }
      )
    );

    const res = await GET(
      new Request("http://127.0.0.1/api/music?action=search&source=netease&keyword=%E6%99%B4%E5%A4%A9", {
        headers: { "x-forwarded-for": "203.0.113.42" },
      })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.code).toBe(200);
    expect(json.data.keyword).toBe("晴天");
    expect(json.data.source).toBe("netease");
    expect(json.data.count).toBe(2);
    expect(json.data.items[0]).toMatchObject({
      id: "2652820720",
      name: "晴天(深情版)",
      artist: ["Lucky小爱"],
    });
    expect(json.data.items[1].urlId).toBe("1945894789");
    expect(json.data.page).toBe(1);
    expect(json.data.hasMore).toBe(false); // 实回 2 条 < 请求 20 条，判定无更多
    // 结果列表「线路」标注：本页由同源代理命中默认公共基址取回
    expect(json.data.line).toEqual({ kind: "proxy", base: UPSTREAM });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toBe(
      `${UPSTREAM}?types=search&source=netease&name=%E6%99%B4%E5%A4%A9&pages=1&count=20`
    );
  });

  it("回满整页时 page/hasMore=true（netease/kuwo 可翻页）", async () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      id: String(1000 + i),
      name: `歌${i}`,
      artist: ["歌手"],
      album: "",
      url_id: String(1000 + i),
      source: "netease",
    }));
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(items), { status: 200 }));

    const res = await GET(
      new Request("http://127.0.0.1/api/music?action=search&source=netease&keyword=x&count=10&page=2", {
        headers: { "x-forwarded-for": "203.0.113.42" },
      })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.page).toBe(2);
    expect(json.data.items).toHaveLength(10);
    expect(json.data.hasMore).toBe(true);
    expect(global.fetch.mock.calls[0][0]).toBe(
      `${UPSTREAM}?types=search&source=netease&name=x&pages=2&count=10`
    );
  });

  it("joox 无视分页整页返回（30 ≠ 请求 10）→ hasMore=false，避免重复翻页", async () => {
    const items = Array.from({ length: 30 }, (_, i) => ({
      id: `J${i}`,
      name: `歌${i}`,
      artist: [],
      album: "",
      url_id: `J${i}`,
      source: "joox",
    }));
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(items), { status: 200 }));

    const res = await GET(
      new Request("http://127.0.0.1/api/music?action=search&source=joox&keyword=x", {
        headers: { "x-forwarded-for": "203.0.113.42" },
      })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.items).toHaveLength(30);
    expect(json.data.page).toBe(1);
    expect(json.data.hasMore).toBe(false);
  });

  it("指定 count/page 会归一并透传到上游（超界钳制）", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 })
    );
    await GET(
      new Request("http://127.0.0.1/api/music?action=search&source=kuwo&keyword=x&count=99&page=-1", {
        headers: { "x-forwarded-for": "203.0.113.42" },
      })
    );
    expect(global.fetch.mock.calls[0][0]).toBe(
      `${UPSTREAM}?types=search&source=kuwo&name=x&pages=1&count=20`
    );
  });

  it("无结果：上游返回空数组合法成功（items 为空）", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    const res = await GET(
      new Request("http://127.0.0.1/api/music?action=search&source=netease&keyword=zzz", {
        headers: { "x-forwarded-for": "203.0.113.42" },
      })
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data.items).toEqual([]);
  });

  it("keyword 缺失 / 非法 action → 400", async () => {
    const noKeyword = await GET(
      new Request("http://127.0.0.1/api/music?action=search&source=netease", {
        headers: { "x-forwarded-for": "203.0.113.42" },
      })
    );
    expect(noKeyword.status).toBe(400);
    expect((await noKeyword.json()).msg).toContain("keyword");

    const badAction = await GET(
      new Request("http://127.0.0.1/api/music?action=bogus", {
        headers: { "x-forwarded-for": "203.0.113.42" },
      })
    );
    expect(badAction.status).toBe(400);
    expect((await badAction.json()).msg).toContain("action");
  });

  it("当前上游未开放搜索的 source（tencent）→ 400", async () => {
    const res = await GET(
      new Request("http://127.0.0.1/api/music?action=search&source=tencent&keyword=x", {
        headers: { "x-forwarded-for": "203.0.113.42" },
      })
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.msg).toContain("暂不支持关键词搜索");
    expect(json.supportedSources).toEqual(["netease", "kuwo", "joox"]);
  });

  it("上游 source 被拒 / 坏数据 → 400 source-unavailable / 502 sources-down", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "not supported" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("oops", { status: 200 }));

    const rejected = await GET(
      new Request("http://127.0.0.1/api/music?action=search&source=netease&keyword=x", {
        headers: { "x-forwarded-for": "203.0.113.42" },
      })
    );
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).failType).toBe("source-unavailable");

    const bad = await GET(
      new Request("http://127.0.0.1/api/music?action=search&source=netease&keyword=x", {
        headers: { "x-forwarded-for": "203.0.113.42" },
      })
    );
    expect(bad.status).toBe(502);
    expect((await bad.json()).failType).toBe("sources-down");
  });

  it("上游网络异常 → 502 + failType=sources-down", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const res = await GET(
      new Request("http://127.0.0.1/api/music?action=search&source=netease&keyword=x", {
        headers: { "x-forwarded-for": "203.0.113.42" },
      })
    );
    expect(res.status).toBe(502);
    expect((await res.json()).failType).toBe("sources-down");
  });
});

describe("GET /api/music?action=pic（换取专辑封面）", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("成功：代理上游 types=pic 返回封面直链并带 size", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          url: "https://p2.music.126.net/F0fTkmBTVykCa2o7Vgu1rQ==/109951173569626660.jpg?param=300y300",
          from: "music.gdstudio.xyz",
        }),
        { status: 200 }
      )
    );

    const res = await GET(
      new Request("http://127.0.0.1/api/music?action=pic&source=netease&id=109951173569626660&size=300", {
        headers: { "x-forwarded-for": "203.0.113.42" },
      })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.code).toBe(200);
    expect(json.data).toMatchObject({
      url: "https://p2.music.126.net/F0fTkmBTVykCa2o7Vgu1rQ==/109951173569626660.jpg?param=300y300",
      source: "netease",
      id: "109951173569626660",
      size: 300,
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toBe(
      `${UPSTREAM}?types=pic&source=netease&id=109951173569626660&size=300`
    );
  });

  it("成功：酷我路径型 pic_id 被编码，http 封面统一升级为 https", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ url: "http://img2.kuwo.cn/star/albumcover/300/s3s94/93/211513640.jpg" }),
        { status: 200 }
      )
    );

    const res = await GET(
      new Request("http://127.0.0.1/api/music?action=pic&source=kuwo&id=120/s3s94/93/211513640.jpg", {
        headers: { "x-forwarded-for": "203.0.113.42" },
      })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.url).toBe("https://img2.kuwo.cn/star/albumcover/300/s3s94/93/211513640.jpg");
    expect(global.fetch.mock.calls[0][0]).toBe(
      `${UPSTREAM}?types=pic&source=kuwo&id=120%2Fs3s94%2F93%2F211513640.jpg&size=300`
    );
  });

  it("size 非法回落 300；缺失/非法 pic id 与 source → 400", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ url: "https://cdn.example/a.jpg" }), { status: 200 })
    );
    await GET(
      new Request("http://127.0.0.1/api/music?action=pic&source=netease&id=1&size=999", {
        headers: { "x-forwarded-for": "203.0.113.42" },
      })
    );
    expect(global.fetch.mock.calls[0][0]).toContain("&size=300");

    const noId = await GET(
      new Request("http://127.0.0.1/api/music?action=pic&source=netease", {
        headers: { "x-forwarded-for": "203.0.113.42" },
      })
    );
    expect(noId.status).toBe(400);
    expect((await noId.json()).msg).toContain("pic_id");

    const badSource = await GET(
      new Request("http://127.0.0.1/api/music?action=pic&source=baidu&id=1", {
        headers: { "x-forwarded-for": "203.0.113.42" },
      })
    );
    expect(badSource.status).toBe(400);
    expect((await badSource.json()).msg).toContain("source");
  });

  it("无封面（上游 url 空）→ 404 not-found", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ url: "", from: "music.gdstudio.xyz" }), { status: 200 })
    );
    const res = await GET(
      new Request("http://127.0.0.1/api/music?action=pic&source=netease&id=404pic", {
        headers: { "x-forwarded-for": "203.0.113.42" },
      })
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.code).toBe(404);
    expect(json.failType).toBe("not-found");
  });

  it("上游 source 被拒 → 400 source-unavailable；网络异常 → 502 sources-down", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "not supported" }), { status: 200 }))
      .mockRejectedValueOnce(new Error("ECONNRESET"));

    const rejected = await GET(
      new Request("http://127.0.0.1/api/music?action=pic&source=netease&id=rejectedpic", {
        headers: { "x-forwarded-for": "203.0.113.42" },
      })
    );
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).failType).toBe("source-unavailable");

    const down = await GET(
      new Request("http://127.0.0.1/api/music?action=pic&source=netease&id=downpic", {
        headers: { "x-forwarded-for": "203.0.113.42" },
      })
    );
    expect(down.status).toBe(502);
    expect((await down.json()).failType).toBe("sources-down");
  });
});

describe("GET /api/music?action=lyric（取歌词）", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("成功：上游返回 { lyric } JSON → 200 + 歌词文本", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ lyric: "[00:01.00]测试歌词" }), { status: 200 })
    );
    const res = await GET(
      new Request("http://127.0.0.1/api/music?action=lyric&source=netease&id=123", {
        headers: { "x-forwarded-for": "198.51.100.7" },
      })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.code).toBe(200);
    expect(json.data.lyric).toContain("测试歌词");
  });

  it("成功：上游直接返回 LRC 纯文本", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response("[00:00.00]歌手 - 歌名", { status: 200 })
    );
    const res = await GET(
      new Request("http://127.0.0.1/api/music?action=lyric&source=netease&id=456", {
        headers: { "x-forwarded-for": "198.51.100.8" },
      })
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data.lyric).toContain("歌手 - 歌名");
  });

  it("上游返回 CF 风控页（200 HTML）→ 502 sources-down，不把校验页当歌词", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        '<!DOCTYPE html><html><head><title>Just a moment...</title><script>window.__cf_chl_opt={cType:"managed"}</script></head><body>Enable JavaScript and cookies to continue</body></html>',
        { status: 200 }
      )
    );
    const res = await GET(
      new Request("http://127.0.0.1/api/music?action=lyric&source=netease&id=789", {
        headers: { "x-forwarded-for": "198.51.100.9" },
      })
    );
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.code).toBe(502);
    expect(json.failType).toBe("sources-down");
  });

  it("上游 5xx → 502 sources-down", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response("Service Unavailable", { status: 503 })
    );
    const res = await GET(
      new Request("http://127.0.0.1/api/music?action=lyric&source=netease&id=888", {
        headers: { "x-forwarded-for": "198.51.100.10" },
      })
    );
    expect(res.status).toBe(502);
    expect((await res.json()).failType).toBe("sources-down");
  });
});

describe("上游被 CF 风控拦截（403/非 JSON）时的错误归类", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("pic：上游 403 HTML（风控页）→ 502 sources-down，而非 404 not-found", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response("<html>blocked by cloudflare</html>", { status: 403 })
    );
    const res = await GET(
      new Request("http://127.0.0.1/api/music?action=pic&source=netease&id=111&size=300", {
        headers: { "x-forwarded-for": "198.51.100.20" },
      })
    );
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.code).toBe(502);
    expect(json.failType).toBe("sources-down");
  });

  it("pic：上游 200 但 body 非 JSON → 502 sources-down，而非 404 not-found", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response("<html>just a moment</html>", { status: 200 })
    );
    const res = await GET(
      new Request("http://127.0.0.1/api/music?action=pic&source=netease&id=222&size=300", {
        headers: { "x-forwarded-for": "198.51.100.21" },
      })
    );
    expect(res.status).toBe(502);
    expect((await res.json()).failType).toBe("sources-down");
  });

  it("url：上游 403 HTML（风控页）→ 502 sources-down", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response("<html>blocked by cloudflare</html>", { status: 403 })
    );
    const res = await GET(
      new Request("http://127.0.0.1/api/music?source=netease&id=333&br=128", {
        headers: { "x-forwarded-for": "198.51.100.22" },
      })
    );
    expect(res.status).toBe(502);
    expect((await res.json()).failType).toBe("sources-down");
  });

  it("url：fmt=text 时上游风控失败返回纯文本错误行（非 JSON）", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response("<html>just a moment</html>", { status: 403 })
    );
    const res = await GET(
      new Request("http://127.0.0.1/api/music?source=netease&id=444&br=128&fmt=text", {
        headers: { "x-forwarded-for": "198.51.100.23" },
      })
    );
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toContain("音乐源接口暂不可用");
  });
});

describe("多基址链（MUSIC_API_BASES）：主源不可用时自动切换", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.MUSIC_API_BASE;
    delete process.env.MUSIC_API_BASES;
  });

  it("url：首基址 403 风控 → 自动切第二基址并成功", async () => {
    process.env.MUSIC_API_BASES =
      "https://a.example/api.php,https://b.example/api.php";
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("<html>blocked</html>", { status: 403 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ url: "https://cdn.example/c.mp3", br: 128, size: 1 }),
          { status: 200 }
        )
      );

    const res = await GET(
      new Request("http://127.0.0.1/api/music?source=netease&id=123&br=128", {
        headers: { "x-forwarded-for": "203.0.113.99" },
      })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.url).toBe("https://cdn.example/c.mp3");
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[0][0]).toContain("a.example");
    expect(global.fetch.mock.calls[1][0]).toContain("b.example");
  });

  it("search：首基址 200 CF 校验页 → 自动切第二基址返回结果", async () => {
    process.env.MUSIC_API_BASES =
      "https://a.example/api.php,https://b.example/api.php";
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          '<!DOCTYPE html><title>Just a moment</title><script>window.__cf_chl_opt={}</script>',
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { id: "1", name: "晴天多源链", artist: ["周杰伦"], url_id: "1", source: "netease" },
          ]),
          { status: 200 }
        )
      );

    // 用文件内唯一的关键词，避免命中其它用例写入的进程内存缓存（缓存键不含基址）
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/music?action=search&source=netease&keyword=%E6%99%B4%E5%A4%A9%E5%A4%9A%E6%BA%90%E9%93%BE",
        { headers: { "x-forwarded-for": "203.0.113.99" } }
      )
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.items[0].name).toBe("晴天多源链");
    // 首基址（a.example）被 CF 风控，实际由第二基址回源 → 线路标注切到 b.example
    expect(json.data.line).toEqual({ kind: "proxy", base: "https://b.example/api.php" });
    expect(global.fetch.mock.calls[1][0]).toContain("b.example");
  });

  it("url：全部基址不可用 → 502 sources-down，且失败不写缓存", async () => {
    process.env.MUSIC_API_BASES =
      "https://a.example/api.php,https://b.example/api.php";
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("<html>blocked</html>", { status: 403 }))
      .mockRejectedValueOnce(new Error("ETIMEDOUT"));

    const res = await GET(
      new Request("http://127.0.0.1/api/music?source=netease&id=999&br=128", {
        headers: { "x-forwarded-for": "203.0.113.99" },
      })
    );
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.code).toBe(502);
    expect(json.failType).toBe("sources-down");
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
