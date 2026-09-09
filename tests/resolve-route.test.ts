// @ts-nocheck
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { GET } from "@/app/api/music/resolve/route";

/**
 * resolve 路由集成单测：通过全局 fetch 打桩模拟各平台元数据上游与短链跟随，
 * 验证 400 / engine-missing / playable(full) / playable(fallback) 各分支的契约。
 *
 * 平台直链引擎矩阵（对齐 route.js 头注释 + music-platform-flags.js）：
 *   netease / tencent / kuwo —— 直链引擎代码已接入，但 tencent 播放引擎默认停用
 *   （部署侧需 MUSIC_PLATFORM_PLAY='{"tencent":true}' 才会 playable）；
 *   kugou —— 内置官方 getSongInfo 元数据通道，默认播放引擎开启 → playable
 *   （直链由播放端经 /api/music/self?action=url 实时取）。
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
  vi.unstubAllEnvs();
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
    expect(json.supported.ready).toEqual(["netease", "tencent", "kuwo", "kugou"]);
    expect(json.supported.pending).toEqual([]);
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

describe("/api/music/resolve · QQ音乐（直链引擎已接入；播放引擎默认停用，需开关开启）", () => {
  // tencent 播放引擎默认关：本组用例显式放开（模拟部署侧 MUSIC_PLATFORM_PLAY 配置后行为）
  beforeEach(() => {
    vi.stubEnv("MUSIC_PLATFORM_PLAY", JSON.stringify({ tencent: true }));
  });

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

describe("/api/music/resolve · 平台播放引擎开关（MUSIC_PLATFORM_PLAY）", () => {
  // 未配置 / 清空开关 = 回退默认：tencent 播放引擎停用 → engine-missing（netease/kuwo 默认开启不受影响）
  beforeEach(() => {
    vi.stubEnv("MUSIC_PLATFORM_PLAY", "");
  });

  it("tencent 默认停用 → QQ songDetail 识别成功但 engine-missing，message 指引开关", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => qqSongInfoResponse()));
    const res = await callResolve("https://y.qq.com/n/ryqq/songDetail/0039MnYb0p1iXz");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.status).toBe("engine-missing");
    expect(json.data.platform).toBe("tencent");
    expect(json.data.songId).toBe("0039MnYb0p1iXz");
    expect(json.data.message).toContain("MUSIC_PLATFORM_PLAY");
  });

  it("netease 默认开启 → 不受播放引擎开关影响仍 playable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => neteaseDetailResponse()));
    const res = await callResolve("https://music.163.com/song?id=186016");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.status).toBe("playable");
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

describe("/api/music/resolve · 酷狗（内置官方直链引擎已接入）", () => {
  const KUGOU_LINK =
    "https://www.kugou.com/song/#hash=AC2C0B1F2D3E4A5B6C7D8E9F0A1B2C3D";
  // 用例间 hash 需不同：详情结果进程内缓存 5 分钟，同 key 会在用例间串扰
  const KUGOU_LINK_VIP =
    "https://www.kugou.com/song/#hash=b12c0b1f2d3e4a5b6c7d8e9f0a1b2c3d";
  const KUGOU_LINK_FALLBACK =
    "https://www.kugou.com/song/#hash=c34c0b1f2d3e4a5b6c7d8e9f0a1b2c3e";

  it("getSongInfo 成功 → playable + metadata=full（hash 归一大写、封面直链 https）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonRes({
          status: 1,
          url: "https://sharefs.kugou.com/20260909/xx/1.mp3",
          bitRate: 128,
          songName: "广东爱情故事",
          author_name: "广东雨神",
          album_img: "http://imge.kugou.com/stdmusic/{size}/cover.jpg",
        })
      )
    );
    const res = await callResolve(KUGOU_LINK);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.status).toBe("playable");
    expect(json.data.platform).toBe("kugou");
    expect(json.data.songId).toBe("AC2C0B1F2D3E4A5B6C7D8E9F0A1B2C3D");
    expect(json.data.metadata).toBe("full");
    expect(json.data.item.name).toBe("广东爱情故事");
    expect(json.data.item.artist).toEqual(["广东雨神"]);
    expect(json.data.item.source).toBe("kugou");
    expect(json.data.item.picUrlDirect).toBe(
      "https://imge.kugou.com/stdmusic/400/cover.jpg"
    );
  });

  it("getSongInfo 带元数据但 url 为空（VIP/付费档）→ 仍 playable 返回曲名（点播时才报 vip-only）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonRes({
          status: 0,
          url: "",
          error: "需要付费",
          privilege: 10,
          songName: "晴天",
          author_name: "周杰伦",
        })
      )
    );
    const res = await callResolve(KUGOU_LINK_VIP);
    const json = await res.json();
    expect(json.data.status).toBe("playable");
    expect(json.data.metadata).toBe("full");
    expect(json.data.item.name).toBe("晴天");
  });

  it("getSongInfo 无元数据 → playable + metadata=fallback 占位标题", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes({ nope: true })));
    const res = await callResolve(KUGOU_LINK_FALLBACK);
    const json = await res.json();
    expect(json.data.status).toBe("playable");
    expect(json.data.metadata).toBe("fallback");
    expect(json.data.item.name).toBe(
      "酷狗歌曲 C34C0B1F2D3E4A5B6C7D8E9F0A1B2C3E"
    );
  });
});
