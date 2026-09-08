// @ts-nocheck
import { describe, it, expect, vi, afterEach } from "vitest";
import { GET } from "@/app/api/music/resolve/route";

/**
 * resolve 路由集成单测：通过全局 fetch 打桩模拟上游（网易官方详情 / 短链跟随），
 * 验证 400 / engine-missing / playable(full) / playable(fallback) 各分支的契约。
 */

async function callResolve(link) {
  const url = new URL("http://localhost/api/music/resolve");
  if (link !== undefined) url.searchParams.set("link", link);
  const req = new Request(url.toString(), {
    headers: { "user-agent": "vitest", "x-forwarded-for": "203.0.113.9" },
  });
  return GET(req);
}

/** 构造网易官方 song/detail 成功响应 */
function detailResponse() {
  return new Response(
    JSON.stringify({
      songs: [
        {
          name: "晴天",
          artists: [{ name: "周杰伦", img1v1Url: "http://p1.music.126.net/av.jpg" }],
          album: { name: "叶惠美", blurPicUrl: "http://p2.music.126.net/cov.jpg" },
          fee: 1,
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/api/music/resolve · 入参校验", () => {
  it("缺 link → 400 并提示用法", async () => {
    const res = await callResolve(undefined);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe(400);
    expect(json.msg).toContain("link");
  });

  it("纯文本（非 URL）→ 400 并列出当前可解析平台", async () => {
    const res = await callResolve("周杰伦 晴天 好好听");
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe(400);
    expect(json.supported.ready).toContain("netease");
    expect(json.supported.pending).toContain("tencent");
  });

  it("非受支持平台（spotify）→ 400", async () => {
    const res = await callResolve("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC");
    expect(res.status).toBe(400);
  });
});

describe("/api/music/resolve · QQ / 酷狗 / 酷我（引擎未接入）", () => {
  it("QQ 单曲链接识别成功 → engine-missing", async () => {
    const res = await callResolve("https://y.qq.com/n/ryqq/songDetail/0039MnYb0p1iXz");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.status).toBe("engine-missing");
    expect(json.data.platform).toBe("tencent");
    expect(json.data.songId).toBe("0039MnYb0p1iXz");
    expect(json.data.message).toContain("引擎");
  });

  it("酷我 play_detail 识别成功 → engine-missing", async () => {
    const res = await callResolve("https://www.kuwo.cn/play_detail/26378264");
    const json = await res.json();
    expect(json.data.status).toBe("engine-missing");
    expect(json.data.platform).toBe("kuwo");
  });
});

describe("/api/music/resolve · 网易云（可解析到播放）", () => {
  it("详情成功 → playable + metadata=full（标题/歌手/专辑/直链封面齐全）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => detailResponse()));
    const res = await callResolve("https://music.163.com/song?id=186016");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.status).toBe("playable");
    expect(json.data.platform).toBe("netease");
    expect(json.data.songId).toBe("186016");
    expect(json.data.metadata).toBe("full");
    const item = json.data.item;
    expect(item.source).toBe("netease");
    expect(item.id).toBe("186016");
    expect(item.urlId).toBe("186016");
    expect(item.lyricId).toBe("186016");
    expect(item.name).toBe("晴天");
    expect(item.artist).toEqual(["周杰伦"]);
    expect(item.album).toBe("叶惠美");
    expect(item.picUrlDirect).toContain("?param=300y300");
  });

  it("详情接口不可用 → 降级 playable + metadata=fallback（ID 占位标题，直链仍可走播放端）", async () => {
    // 用独立 songId 避免命中同文件上一条用例写入的进程内详情缓存
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream banned", { status: 403 })));
    const res = await callResolve("https://music.163.com/song?id=347230");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.status).toBe("playable");
    expect(json.data.metadata).toBe("fallback");
    expect(json.data.item.name).toBe("网易云歌曲 347230");
    expect(json.data.item.picUrlDirect).toBe("");
    expect(json.data.item.urlId).toBe("347230");
  });

  it("短链落地形态（/m/song?id 混在追踪参数中）→ playable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => detailResponse()));
    const res = await callResolve(
      "https://y.music.163.com/m/song?fx-wechatnew=t1&fx-wxqd=&fx-wordtest=&id=186016&uct2=7UBWV1vBfzxSg109a1AgNA==&app_version=9.5.85&dlt=0846"
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.status).toBe("playable");
    expect(json.data.songId).toBe("186016");
  });

  it("分享文本（含短链前的说明与尾部 @平台）也能解析", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => detailResponse()));
    const res = await callResolve(
      "分享周杰伦的单曲《晴天》: https://music.163.com/#/song?id=186016 (@网易云音乐)"
    );
    const json = await res.json();
    expect(json.data.songId).toBe("186016");
  });
});
