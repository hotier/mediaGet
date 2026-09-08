/**
 * 真机验证：链接解析全链路（不 mock）。
 * 运行: RUN_LIVE_RESOLVE=1 npx vitest run tests/live/resolve-live.test.ts
 * 依赖: 网易云官方 song/detail 与 /api/music 的 GD 直链通道可达（民用网络通常可）。
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

      const mres = await GETMusic(
        req(
          "/api/music",
          `action=url&source=netease&id=${encodeURIComponent(item.urlId)}&br=320`
        )
      );
      const mjson = await mres.json().catch(() => null);
      // 直链通道的代理端可用性取决于 GD 上游实时状态（部署后还会叠加直连兜底）；
      // 这里只要求「通道可用时返回直链」，代理 502 时允许（resolve 功能本身不受影响）
      if (mres.status === 200 && mjson?.code === 200) {
        expect(mjson.data?.url).toMatch(/^https?:\/\//);
      } else {
        console.warn(
          `[live] /api/music action=url 代理通道当前不可用 status=${mres.status}（直连兜底会在播放端生效），跳过直链断言`
        );
      }
    },
    LIVE_TIMEOUT
  );

  it(
    "网易云分享文本（hash 路由）→ playable，QQ 链接 → engine-missing",
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

      const qqRes = await GETResolve(
        req(
          "/api/music/resolve",
          "link=" + encodeURIComponent("https://y.qq.com/n/ryqq/songDetail/0039MnYb0p1iXz")
        )
      );
      const qqJson = await qqRes.json();
      expect(qqJson.data.status).toBe("engine-missing");
      expect(qqJson.data.platform).toBe("tencent");
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
