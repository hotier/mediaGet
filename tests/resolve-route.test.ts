// @ts-nocheck
import { describe, it, expect, vi, afterEach } from "vitest";
import { GET } from "@/app/api/music/resolve/route";

/**
 * resolve 路由集成单测：通过全局 fetch 打桩模拟各平台元数据上游与短链跟随，
 * 验证 400 / engine-missing / playable(full) / playable(fallback) 各分支的契约。
 *
 * 平台直链引擎矩阵（对齐 route.js 头注释）：
 *   netease / tencent / kuwo —— 直链引擎已接入（详情缺失时降级 fallback 仍可播放）；
 *   kugou —— 识别成功返回 engine-missing。
 */

async function callResolve(link) {
  const url = new URL("http://localhost/api/music/resolve");
  if (link !== undefined) url.searchParams.set("link", link);
  const req = new Request(url.toString(), {
    headers: { "user-agent": "vitest", "x-forwarded-for": "203.0.113.9" },
  });
  return GET(req);
}

const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** 网易官方 song/detail 成功响应 */
function neteaseDetailResponse() {
  return jsonRes({
    songs: [
      {
        name: "晴天",
        artists: [{ name: "周杰伦", img1v1Url: "http://p1.music.126.net/av.jpg" }],
        album: { name: "叶惠美", blurPicUrl: "http://p2.music.126.net/cov.jpg" },
        fee: 1,
      },
    ],
  });
}

/** QQ c.y.qq.com songinfo 成功响应（免签名接口） */
function qqSongInfoResponse() {
  return jsonRes({
    code: 0,
    data: [
      {
        mid: "0039MnYb0p1iXz",
        id: 12345678,
        name: "晴天",
        singer: [{ name: "周杰伦" }],
        album: { mid: "0039MnYb0p1iXz", name: "叶惠美" },
      },
    ],
  });
}

/** 酷我 m.kuwo.cn H5 songinfo 成功响应 */
function kuwoSongInfoResponse() {
  return jsonRes({
    data: {
      songinfo: {
        id: "26378264",
        musicrId: "26378264",
        songName: "雨音",
        artist: "测试歌手",
        album: "测试专辑",
        pic: "http://img.example.com/cov.jpg",
      },
    },
  });
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
    expect(json.supported.ready).toEqual(["netease", "tencent", "kuwo"]);
    expect(json.supported.pending).toEqual(["kugou"]);
  });

  it("非受支持平台（spotify）→ 400", async () => {
    const res = await callResolve("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC");
    expect(res.status).toBe(400);
  });
});

describe("/api/music/resolve · 网易云（可解析到播放）", () => {
  it("详情成功 → playable + metadata=full（标题/歌手/专辑/直链封面齐全）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => neteaseDetailResponse()));
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
    vi.stubGlobal("fetch", vi.fn(async () => neteaseDetailResponse()));
    const res = await callResolve(
      "https://y.music.163.com/m/song?fx-wechatnew=t1&fx-wxqd=&fx-wordtest=&id=186016&uct2=7UBWV1vBfzxSg109a1AgNA==&app_version=9.5.85&dlt=0846"
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.status).toBe("playable");
    expect(json.data.songId).toBe("186016");
  });

  it("分享文本（含短链前的说明与尾部 @平台）也能解析", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => neteaseDetailResponse()));
    const res = await callResolve(
      "分享周杰伦的单曲《晴天》: https://music.163.com/#/song?id=186016 (@网易云音乐)"
    );
    const json = await res.json();
    expect(json.data.songId).toBe("186016");
  });
});

describe("/api/music/resolve · QQ音乐（直链引擎已接入）", () => {
  it("songDetail 链接 + 详情成功 → playable + metadata=full（songmid 原样落 item）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => qqSongInfoResponse()));
    const res = await callResolve("https://y.qq.com/n/ryqq/songDetail/0039MnYb0p1iXz");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.status).toBe("playable");
    expect(json.data.platform).toBe("tencent");
    expect(json.data.songId).toBe("0039MnYb0p1iXz");
    expect(json.data.metadata).toBe("full");
    const item = json.data.item;
    expect(item.source).toBe("tencent");
    expect(item.id).toBe("0039MnYb0p1iXz");
    expect(item.urlId).toBe("0039MnYb0p1iXz");
    expect(item.name).toBe("晴天");
    expect(item.artist).toEqual(["周杰伦"]);
    expect(item.album).toBe("叶惠美");
    expect(item.picUrlDirect).toContain("y.gtimg.cn/music/photo_new/T002R500x500M000");
  });

  it("详情通道异常 → 降级 playable + metadata=fallback（ID 占位标题）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream banned", { status: 403 })));
    const res = await callResolve("https://y.qq.com/n/ryqq/songDetail/003OUlho2HcRHC");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.status).toBe("playable");
    expect(json.data.metadata).toBe("fallback");
    expect(json.data.item.name).toBe("QQ音乐歌曲 003OUlho2HcRHC");
    expect(json.data.item.picUrlDirect).toBe("");
  });

  it("旧版 songDetail 落地页（/n/yqq/song/<mid>.html）也能解析", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => qqSongInfoResponse()));
    const res = await callResolve("https://y.qq.com/n/yqq/song/0039MnYb0p1iXz.html");
    const json = await res.json();
    expect(json.data.status).toBe("playable");
    expect(json.data.songId).toBe("0039MnYb0p1iXz");
  });
});

describe("/api/music/resolve · 酷我（直链引擎已接入）", () => {
  it("play_detail 链接 + 详情成功 → playable + metadata=full（封面升级 https）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => kuwoSongInfoResponse()));
    const res = await callResolve("https://www.kuwo.cn/play_detail/26378264");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.status).toBe("playable");
    expect(json.data.platform).toBe("kuwo");
    expect(json.data.songId).toBe("26378264");
    expect(json.data.metadata).toBe("full");
    const item = json.data.item;
    expect(item.source).toBe("kuwo");
    expect(item.id).toBe("26378264");
    expect(item.name).toBe("雨音");
    expect(item.artist).toEqual(["测试歌手"]);
    expect(item.album).toBe("测试专辑");
    expect(item.picUrlDirect.startsWith("https://")).toBe(true);
  });

  it("详情通道异常 → 降级 playable + metadata=fallback（ID 占位标题）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("blocked", { status: 403 })));
    const res = await callResolve("https://www.kuwo.cn/play_detail/26378265");
    const json = await res.json();
    expect(json.data.status).toBe("playable");
    expect(json.data.metadata).toBe("fallback");
    expect(json.data.item.name).toBe("酷我歌曲 26378265");
  });
});

describe("/api/music/resolve · 酷狗（识别成功但引擎未接入）", () => {
  it("kugou hash 链接 → engine-missing 且消息说明可解析平台", async () => {
    const res = await callResolve(
      "https://www.kugou.com/song/#hash=AC2C0B1F2D3E4A5B6C7D8E9F0A1B2C3"
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.status).toBe("engine-missing");
    expect(json.data.platform).toBe("kugou");
    expect(json.data.songId).toBe("AC2C0B1F2D3E4A5B6C7D8E9F0A1B2C3");
    expect(json.data.message).toContain("酷狗直链解析引擎尚未接入");
  });
});
