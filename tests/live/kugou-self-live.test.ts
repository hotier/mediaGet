/**
 * 真机验证：酷狗自研通道全链路（不 mock）——搜索 + 官方试听直链（免登录）。
 * 运行: RUN_LIVE_KUGOU=1 npx vitest run tests/live/kugou-self-live.test.ts
 * 依赖: kugou 官方搜索（songsearch）+ 官方 playInfo（m.kugou.com/getSongInfo）公网可达，
 *       且部署侧未在 MUSIC_PLATFORM_SEARCH / MUSIC_PLATFORM_PLAY 停用 kugou。
 * 该文件默认跳过，仅在显式开启 RUN_LIVE_KUGOU 时执行。
 */
// @ts-nocheck
import { describe, it, expect } from "vitest";
import { GET as GETSelf } from "@/app/api/music/self/route.js";

const RUN = process.env.RUN_LIVE_KUGOU === "1";
const LIVE_TIMEOUT = Number(process.env.LIVE_KUGOU_TIMEOUT_MS || 60000);

function req(query: string) {
  return new Request(`http://127.0.0.1/api/music/self?${query}`, {
    headers: { "x-forwarded-for": "203.0.113.42" },
  });
}

describe.runIf(RUN)("/api/music/self · kugou 真机全链路", () => {
  it(
    "action=search 返回自研契约；对结果逐项 action=url，免费曲至少一条可取到可播 http 直链",
    async () => {
      const res = await GETSelf(
        req(
          "action=search&source=kugou&keyword=" +
            encodeURIComponent("晴天") +
            "&count=10"
        )
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.code).toBe(200);
      expect(json.data.source).toBe("kugou");
      expect(json.data.line.kind).toBe("self");
      const items = json.data.items || [];
      expect(items.length).toBeGreaterThan(0);

      // 搜索结果里部分条目只有 audioId 无 FileHash（urlId 为空），无法按 hash 取链，跳过
      const hashable = items.filter((item) => /^[0-9A-Fa-f]{32}$/.test(item.urlId || ""));
      expect(hashable.length, "搜索结果应包含带 FileHash 的条目").toBeGreaterThan(0);

      let gotUrl = "";
      for (const item of hashable) {
        expect(item.source).toBe("kugou");
        const u = await GETSelf(
          req(`action=url&source=kugou&hash=${encodeURIComponent(item.urlId)}`)
        );
        const uj = await u.json().catch(() => null);
        if (u.status === 200 && uj?.code === 200 && uj.data?.url) {
          gotUrl = uj.data.url;
          expect(gotUrl).toMatch(/^https?:\/\//);
          break;
        }
        // VIP/付费或风控曲目 → 单条 404 vip-only / not-found / 502 属预期，继续下一条
        await new Promise((r) => setTimeout(r, 150));
      }
      expect(gotUrl, "免费曲目至少应有一条可取到官方直链").toBeTruthy();
    },
    LIVE_TIMEOUT
  );

  it(
    "action=url 对无此 hash 的请求按业务失败归类（404 + failType=not-found）",
    async () => {
      // 32 位合法但必然不存在的 hash
      const res = await GETSelf(
        req("action=url&source=kugou&hash=00000000000000000000000000000000")
      );
      const json = await res.json().catch(() => null);
      // 上游网络异常时也会出现 502（sources-down），两种结果都说明路由按契约归类、未抛裸异常
      expect([404, 502]).toContain(res.status);
      if (res.status === 404) {
        expect(json.failType).toBe("not-found");
      }
    },
    LIVE_TIMEOUT
  );
});
