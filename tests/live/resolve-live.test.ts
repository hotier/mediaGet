/**
 * 真机验证：链接解析全链路（不 mock）。
 * 运行: RUN_LIVE_RESOLVE=1 npx vitest run tests/live/resolve-live.test.ts
 * 依赖: 各平台官方元数据通道（网易云 song/detail、QQ c.y.qq.com songinfo、酷我 m.kuwo.cn H5）
 *      与 /api/music 的 GD 直链通道可达（民用网络通常可）。
 * 该文件默认跳过，仅在显式开启 RUN_LIVE_RESOLVE 时执行。
 */
// @ts-nocheck
import { describe, it, expect } from "vitest";
import { GET as GETResolve } from "@/app/api/music/resolve/route.js";
import { GET as GETMusic } from "@/app/api/music/route.js";

const RUN = process.env.RUN_LIVE_RESOLVE === "1";
const LIVE_TIMEOUT = Number(process.env.LIVE_RESOLVE_TIMEOUT_MS || 60000);

function req(path: string, query: string) {
  return new Request(`http://127.0.0.1${path}?${query}`, {
    headers: { "x-forwarded-for": "203.0.113.42" },
  });
}

/** 通道可用时校验直链；上游抖动时跳过（resolve 本身不受影响） */
async function assertDirectUrlIfUp(source: string, id: string, br = 320) {
  const mres = await GETMusic(
    req("/api/music", `action=url&source=${source}&id=${encodeURIComponent(id)}&br=${br}`)
  );
  const mjson = await mres.json().catch(() => null);
  if (mres.status === 200 && mjson?.code === 200 && mjson.data?.url) {
    expect(mjson.data.url).toMatch(/^https?:\/\//);
    return mjson.data.url;
  }
  console.warn(
    `[live] /api/music action=url source=${source} 代理通道当前不可用 status=${mres.status}（直连兜底会在播放端生效），跳过直链断言`
  );
  return "";
}

describe.runIf(RUN)("/api/music/resolve · 真机全链路", () => {
  it(
    "网易云单曲链接 → playable；其直链可经既有 /api/music?action=url 取得",
    async () => {
      const res = await GETResolve(
        req("/api/music/resolve", "link=" + encodeURIComponent("https://music.163.com/song?id=186016"))
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.status).toBe("playable");
      expect(json.data.songId).toBe("186016");
      const item = json.data.item;
      expect(item.source).toBe("netease");
      expect(item.name.length).toBeGreaterThan(0);
      expect(item.picUrlDirect).toContain("music.126.net");
      await assertDirectUrlIfUp("netease", item.urlId);
    },
    LIVE_TIMEOUT
  );

  it(
    "QQ音乐 songDetail 链接 → playable（详情缺失时降级占位，直链经 GD source=tencent 取得）",
    async () => {
      const res = await GETResolve(
        req(
          "/api/music/resolve",
          "link=" + encodeURIComponent("https://y.qq.com/n/ryqq/songDetail/0039MnYb0p1iXz")
        )
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.status).toBe("playable");
      expect(json.data.platform).toBe("tencent");
      expect(json.data.songId).toBe("0039MnYb0p1iXz");
      const item = json.data.item;
      expect(item.source).toBe("tencent");
      expect(item.name.length).toBeGreaterThan(0);
      if (json.data.metadata === "full") {
        expect(item.picUrlDirect).toContain("y.gtimg.cn");
      }
      await assertDirectUrlIfUp("tencent", item.urlId);
    },
    LIVE_TIMEOUT
  );

  it(
    "酷我 play_detail 链接 → playable（直链经 GD source=kuwo 取得）",
    async () => {
      const res = await GETResolve(
        req("/api/music/resolve", "link=" + encodeURIComponent("https://www.kuwo.cn/play_detail/26378264"))
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.status).toBe("playable");
      expect(json.data.platform).toBe("kuwo");
      expect(json.data.songId).toBe("26378264");
      const item = json.data.item;
      expect(item.source).toBe("kuwo");
      expect(item.name.length).toBeGreaterThan(0);
      if (json.data.metadata === "full") {
        expect(item.picUrlDirect.startsWith("https://")).toBe(true);
      }
      await assertDirectUrlIfUp("kuwo", item.urlId);
    },
    LIVE_TIMEOUT
  );

  it(
    "酷狗 hash 链接 → engine-missing（引擎尚未接入）",
    async () => {
      const res = await GETResolve(
        req(
          "/api/music/resolve",
          "link=" +
            encodeURIComponent(
              "https://www.kugou.com/song/#hash=AC2C0B1F2D3E4A5B6C7D8E9F0A1B2C3"
            )
        )
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.status).toBe("engine-missing");
      expect(json.data.platform).toBe("kugou");
    },
    LIVE_TIMEOUT
  );

  it(
    "网易云分享文本（hash 路由）→ playable",
    async () => {
      const shareRes = await GETResolve(
        req(
          "/api/music/resolve",
          "link=" +
            encodeURIComponent(
              "分享周杰伦的单曲《晴天》: https://music.163.com/#/song?id=347230 (@网易云音乐)"
            )
        )
      );
      const shareJson = await shareRes.json();
      expect(shareJson.data.status).toBe("playable");
      expect(shareJson.data.songId).toBe("347230");
    },
    LIVE_TIMEOUT
  );

  it(
    "163cn.tv 官方短链（APP 分享文本）→ 跟随落地 /m/song 形态 → playable",
    async () => {
      const text =
        "分享Matryoshka的单曲《Sacred Play Secret Place (神圣的游戏秘密场所)》https://163cn.tv/bfVGTt35 (@网易云音乐)";
      const res = await GETResolve(
        req("/api/music/resolve", "link=" + encodeURIComponent(text))
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.status).toBe("playable");
      expect(json.data.platform).toBe("netease");
      expect(json.data.item.name.length).toBeGreaterThan(0);
      expect(json.data.item.artist.length).toBeGreaterThan(0);
      expect(json.data.item.picUrlDirect).toContain("music.126.net");
    },
    LIVE_TIMEOUT
  );
});
