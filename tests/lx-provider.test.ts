// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LxProviderError,
  brToLxQuality,
  getLxCatalog,
  isLxSourceKey,
  lxScriptInvoke,
  normalizeLxSearchItem,
  normalizeLxSearchResponse,
  pickLxLyric,
  pickLxUrl,
  resetLxScriptRegistryForTest,
  setLxScriptFetcherForTest,
} from "@/lib/lx-provider";

/**
 * lx-provider 单测：
 *  1) 归一化/取值纯函数（不含 IO）；
 *  2) 脚本注册层（注入 fetcher + 进程内 env 配置，验证加载缓存 / 目录快照 / 动作编排）。
 */

/** 与 lx-host 测试同一协议的可用脚本（source=qdy） */
const VALID_SCRIPT = `/*!
 * @name 汽水全豆
 * @description 演示用测试音源
 * @version 2.0.1
 */
const { EVENT_NAMES, on, send } = globalThis.lx;
send(EVENT_NAMES.inited, {
  sources: {
    qdy: {
      name: "汽水音乐",
      type: "music",
      actions: ["musicSearch", "musicUrl", "lyric"],
      qualitys: ["128k", "320k", "flac"],
    },
  },
});
on(EVENT_NAMES.request, async ({ action }) => {
  if (action === "musicSearch") {
    return { list: [{ id: "1024", name: "晴天", singer: ["周杰伦"], pic: "http://p.example/1024.jpg" }] };
  }
  if (action === "musicUrl") {
    return { url: "https://cdn.example/1024.mp3", br: 320, size: 9021 };
  }
  if (action === "lyric") {
    return { lyric: "[00:01.00]词" };
  }
  return null;
});`;

function setConfig(scripts) {
  process.env.MUSIC_LX_SCRIPTS = JSON.stringify(scripts);
}

beforeEach(() => {
  delete process.env.MUSIC_LX_SCRIPTS;
  delete process.env.MUSIC_LX_SCRIPT_TTL_MS;
  delete process.env.MUSIC_LX_SCRIPTS_DIR;
  delete process.env.MUSIC_LX_URL_FALLBACKS;
  resetLxScriptRegistryForTest();
});

afterEach(() => {
  delete process.env.MUSIC_LX_SCRIPTS;
  delete process.env.MUSIC_LX_SCRIPT_TTL_MS;
  delete process.env.MUSIC_LX_SCRIPTS_DIR;
  delete process.env.MUSIC_LX_URL_FALLBACKS;
  resetLxScriptRegistryForTest();
});

describe("brToLxQuality", () => {
  it("数值 br → 洛雪音质字符串；未知/空回退 320k", () => {
    expect(brToLxQuality(128)).toBe("128k");
    expect(brToLxQuality("320")).toBe("320k");
    expect(brToLxQuality("740")).toBe("flac");
    expect(brToLxQuality("999")).toBe("flac24bit");
    expect(brToLxQuality("0")).toBe("320k");
    expect(brToLxQuality("")).toBe("320k");
    expect(brToLxQuality(undefined)).toBe("320k");
  });
});

describe("normalizeLxSearchItem / normalizeLxSearchResponse", () => {
  it("标准条目归一：字段齐全 + http 封面自动升级 https + 各 id 兜底", () => {
    const item = normalizeLxSearchItem(
      {
        id: "1024",
        name: "晴天",
        singer: ["周杰伦"],
        album: "叶惠美",
        pic: "http://p1.example/1024.jpg",
        url_id: "UID-1",
        lyric_id: "LID-1",
      },
      "qdy"
    );
    expect(item.id).toBe("1024");
    expect(item.urlId).toBe("UID-1");
    expect(item.lyricId).toBe("LID-1");
    expect(item.artist).toEqual(["周杰伦"]);
    expect(item.album).toBe("叶惠美");
    expect(item.picUrlDirect).toBe("https://p1.example/1024.jpg");
    expect(item.picId).toBe("");
    expect(item.source).toBe("qdy");
  });

  it("兼容别名字段（songmid/hash/artists/picUrl/cover）与嵌套响应", () => {
    const result = normalizeLxSearchResponse(
      {
        data: {
          list: [
            {
              songmid: "M5001",
              hash: "HASH1",
              name: "夜曲",
              artists: [{ name: "周杰伦" }],
              picUrl: "https://p2.example/cover.jpg",
            },
          ],
        },
      },
      "qdy"
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe("M5001");
    expect(result.items[0].artist).toEqual(["周杰伦"]);
    expect(result.items[0].picUrlDirect).toBe("https://p2.example/cover.jpg");
  });

  it("缺 id / 缺 name 的脏条目被丢弃；空/非对象结果返回空数组", () => {
    const result = normalizeLxSearchResponse(
      { list: [{ id: "", name: "x" }, { id: "2" }, null, "text"] },
      "qdy"
    );
    expect(result.items).toHaveLength(0);
    expect(normalizeLxSearchResponse([], "qdy").items).toHaveLength(0);
    expect(normalizeLxSearchResponse(null, "qdy").items).toHaveLength(0);
  });

  it("isEnd=true 标记分页到底", () => {
    const result = normalizeLxSearchResponse({ list: [{ id: "1", name: "x" }], isEnd: true }, "qdy");
    expect(result.isEnd).toBe(true);
  });

  it("非 http(s) 的 pic 不落 picUrlDirect（无直链可展示）", () => {
    const item = normalizeLxSearchItem({ id: "1", name: "x", pic: "/local/path" }, "qdy");
    expect(item.picUrlDirect).toBeUndefined();
  });
});

describe("pickLxUrl / pickLxLyric", () => {
  it("url 兼容 字符串 / {url} / {data:{url}} / 空", () => {
    expect(pickLxUrl("https://a/1.mp3")).toBe("https://a/1.mp3");
    expect(pickLxUrl({ url: "https://a/2.mp3" })).toBe("https://a/2.mp3");
    expect(pickLxUrl({ data: { url: "https://a/3.mp3" } })).toBe("https://a/3.mp3");
    expect(pickLxUrl({})).toBe("");
    expect(pickLxUrl(null)).toBe("");
  });

  it("lyric 兼容 字符串 / {lyric} / {lrc} / {data:{lyric}}", () => {
    expect(pickLxLyric("[00:00.00]词")).toBe("[00:00.00]词");
    expect(pickLxLyric({ lyric: "[00:01.00]a" })).toBe("[00:01.00]a");
    expect(pickLxLyric({ lrc: "[00:02.00]b" })).toBe("[00:02.00]b");
    expect(pickLxLyric({ data: { lyric: "[00:03.00]c" } })).toBe("[00:03.00]c");
    expect(pickLxLyric({})).toBe("");
  });
});

describe("lx 脚本注册层（注入 fetcher + env 配置）", () => {
  it("加载成功 → getLxCatalog 目录含脚本与可搜索源", async () => {
    setLxScriptFetcherForTest(async () => VALID_SCRIPT);
    setConfig([{ id: "qdy", url: "https://scripts.example/qdy.js" }]);
    const cat = await getLxCatalog();
    expect(cat.scripts).toHaveLength(1);
    expect(cat.scripts[0]).toMatchObject({ id: "qdy", ok: true, state: "ok", name: "汽水全豆" });
    const qdy = cat.sources.find((s) => s.key === "qdy");
    expect(qdy).toBeTruthy();
    expect(qdy.actions).toContain("musicSearch");
    expect(cat.searchSources.some((s) => s.key === "qdy")).toBe(true);
    // source 归属判断：同名内置源不算 lx 源
    expect(isLxSourceKey("qdy")).toBe(true);
    expect(isLxSourceKey("netease")).toBe(false);
    expect(isLxSourceKey("zzz")).toBe(false);
    expect(isLxSourceKey("")).toBe(false);
  });

  it("源码按 URL 进程内缓存：同配置重复 ensure 不再触发拉取", async () => {
    let calls = 0;
    setLxScriptFetcherForTest(async () => {
      calls += 1;
      return VALID_SCRIPT;
    });
    setConfig([{ id: "qdy", url: "https://scripts.example/qdy.js" }]);
    await getLxCatalog();
    await getLxCatalog();
    await getLxCatalog();
    expect(calls).toBe(1);
  });

  it("musicSearch 动作编排 → 命中归属脚本并归一", async () => {
    setLxScriptFetcherForTest(async () => VALID_SCRIPT);
    setConfig([{ id: "qdy", url: "https://scripts.example/qdy.js" }]);
    const raw = await lxScriptInvoke({
      source: "qdy",
      action: "musicSearch",
      info: { keyword: "晴天", page: 1, pagesize: 10 },
    });
    const normalized = normalizeLxSearchResponse(raw, "qdy");
    expect(normalized.items).toHaveLength(1);
    expect(normalized.items[0].name).toBe("晴天");
    expect(normalized.items[0].source).toBe("qdy");
    expect(normalized.items[0].picUrlDirect).toBe("https://p.example/1024.jpg");
  });

  it("musicUrl 动作编排透传直链", async () => {
    setLxScriptFetcherForTest(async () => VALID_SCRIPT);
    setConfig([{ id: "qdy", url: "https://scripts.example/qdy.js" }]);
    const raw = await lxScriptInvoke({ source: "qdy", action: "musicUrl", info: {} });
    expect(pickLxUrl(raw)).toBe("https://cdn.example/1024.mp3");
  });

  it("未配置任何脚本 → 目录为空且无 lx source", async () => {
    // 隔离：未设 MUSIC_LX_SCRIPTS_DIR 时默认目录 .lxref/scripts/（若存在脚本）会被自动加载，
    // 这里指向一个空临时目录，使“未配置”的断言与本地/CI 环境解耦。
    const dir = await mkdtemp(join(tmpdir(), "lx-empty-"));
    process.env.MUSIC_LX_SCRIPTS_DIR = dir;
    resetLxScriptRegistryForTest();
    try {
      const cat = await getLxCatalog();
      expect(cat.scripts).toHaveLength(0);
      expect(cat.sources).toHaveLength(0);
      expect(cat.searchSources).toHaveLength(0);
      expect(isLxSourceKey("qdy")).toBe(false);
    } finally {
      delete process.env.MUSIC_LX_SCRIPTS_DIR;
      resetLxScriptRegistryForTest();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("对未注册的 source 发起动作 → 抛 LxProviderError(source-not-found)", async () => {
    setLxScriptFetcherForTest(async () => VALID_SCRIPT);
    setConfig([{ id: "qdy", url: "https://scripts.example/qdy.js" }]);
    await expect(
      lxScriptInvoke({ source: "nope", action: "musicSearch", info: {} })
    ).rejects.toMatchObject({ failType: "source-not-found" });
    await expect(
      lxScriptInvoke({ source: "nope", action: "musicSearch", info: {} })
    ).rejects.toBeInstanceOf(LxProviderError);
  });

  it("脚本能下载但初始化失败 → 目录标记 error 且 ok=false", async () => {
    setLxScriptFetcherForTest(async () => `this is not valid js @@@`);
    setConfig([{ id: "qdy", url: "https://scripts.example/qdy.js" }]);
    const cat = await getLxCatalog();
    expect(cat.scripts).toHaveLength(1);
    expect(cat.scripts[0].ok).toBe(false);
    expect(cat.scripts[0].state).toBe("error");
    expect(cat.scripts[0].error).toContain("脚本初始化失败");
    expect(cat.searchSources).toHaveLength(0);
    expect(isLxSourceKey("qdy")).toBe(false);
  });

  it("脚本下载失败（fetch 抛错）→ 目录标记 error 且错误透出", async () => {
    setLxScriptFetcherForTest(async () => {
      throw new Error("网络错误：脚本下载失败");
    });
    setConfig([{ id: "qdy", url: "https://scripts.example/qdy.js" }]);
    const cat = await getLxCatalog();
    expect(cat.scripts[0].ok).toBe(false);
    expect(cat.scripts[0].error).toContain("网络错误");
  });
});

/** 聚合音源风格：同时声明 wy/tx（仅 musicUrl）与 qdy（可搜可播） */
const MULTI_SOURCE_SCRIPT = `/*!
 * @name 聚合测试
 * @version 1.0.0
 */
const { EVENT_NAMES, on, send } = globalThis.lx;
send(EVENT_NAMES.inited, {
  sources: {
    wy: { name: "网易云", type: "music", actions: ["musicUrl"], qualitys: ["320k"] },
    tx: { name: "QQ音乐", type: "music", actions: ["musicUrl"], qualitys: ["320k"] },
    qdy: { name: "汽水", type: "music", actions: ["musicSearch", "musicUrl", "lyric"] },
  },
});
on(EVENT_NAMES.request, async () => ({ url: "https://cdn.example/x.mp3" }));`;

describe("音源兜底映射（urlFallbacks）", () => {
  it("默认映射仅保留「已注册且带 musicUrl」的 source（wy/tx 生效，kw/kg/mg/qdy 忽略）", async () => {
    setLxScriptFetcherForTest(async () => MULTI_SOURCE_SCRIPT);
    setConfig([{ id: "agg", url: "https://scripts.example/agg.js" }]);
    const cat = await getLxCatalog();
    expect(cat.urlFallbacks).toEqual([
      { platform: "netease", source: "wy" },
      { platform: "tencent", source: "tx" },
    ]);
  });

  it("MUSIC_LX_URL_FALLBACKS JSON 可增改：kugou 改指 qdy 也生效", async () => {
    process.env.MUSIC_LX_URL_FALLBACKS = JSON.stringify({ kugou: "qdy" });
    setLxScriptFetcherForTest(async () => MULTI_SOURCE_SCRIPT);
    setConfig([{ id: "agg", url: "https://scripts.example/agg.js" }]);
    const cat = await getLxCatalog();
    expect(cat.urlFallbacks).toContainEqual({ platform: "kugou", source: "qdy" });
  });

  it("MUSIC_LX_URL_FALLBACKS 可关闭某项（netease=0）", async () => {
    process.env.MUSIC_LX_URL_FALLBACKS = "netease=0";
    setLxScriptFetcherForTest(async () => MULTI_SOURCE_SCRIPT);
    setConfig([{ id: "agg", url: "https://scripts.example/agg.js" }]);
    const cat = await getLxCatalog();
    expect(cat.urlFallbacks.some((e) => e.platform === "netease")).toBe(false);
  });

  it("未配置脚本时 urlFallbacks 为空", async () => {
    // 隔离同上：默认目录 .lxref/scripts/ 若被放入脚本会注册 wy/tx 等 source，
    // 不指向空目录则 urlFallbacks 会带出默认映射项，破坏“空脚本”语义。
    const dir = await mkdtemp(join(tmpdir(), "lx-empty-"));
    process.env.MUSIC_LX_SCRIPTS_DIR = dir;
    resetLxScriptRegistryForTest();
    try {
      const cat = await getLxCatalog();
      expect(cat.urlFallbacks).toEqual([]);
    } finally {
      delete process.env.MUSIC_LX_SCRIPTS_DIR;
      resetLxScriptRegistryForTest();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("本地脚本文件接入（file:// / 本地路径 / 目录扫描）", () => {
  let dir;
  beforeEach(async () => {
    // 恢复默认 fetcher（http(s) fetch + 本地读文件），让文件路径走真实 IO
    setLxScriptFetcherForTest(null);
    dir = await mkdtemp(join(tmpdir(), "lx-test-"));
  });
  afterEach(async () => {
    delete process.env.MUSIC_LX_SCRIPTS_DIR;
    resetLxScriptRegistryForTest();
    await rm(dir, { recursive: true, force: true });
  });
  const writeFileIn = (name, code) => writeFile(join(dir, name), code, "utf8");
  const fileUrlOf = (p) => `file:///${p.replace(/\\/g, "/")}`;

  it("MUSIC_LX_SCRIPTS 支持 file:// URL 读取本地脚本", async () => {
    const p = join(dir, "qdy.js");
    await writeFileIn("qdy.js", VALID_SCRIPT);
    setConfig([{ id: "qdy", url: fileUrlOf(p) }]);
    const cat = await getLxCatalog();
    expect(cat.scripts).toHaveLength(1);
    expect(cat.scripts[0]).toMatchObject({ id: "qdy", ok: true, state: "ok" });
    expect(cat.sources.some((s) => s.key === "qdy")).toBe(true);
  });

  it("MUSIC_LX_SCRIPTS 支持本地绝对路径（不带 file://）", async () => {
    const p = join(dir, "qdy.js");
    await writeFileIn("qdy.js", VALID_SCRIPT);
    setConfig([{ id: "qdy", url: p }]);
    const cat = await getLxCatalog();
    expect(cat.scripts[0].ok).toBe(true);
  });

  it("MUSIC_LX_SCRIPTS_DIR 目录扫描：目录内 *.js 按文件名生成 id 并加载", async () => {
    await writeFileIn("a-01.js", VALID_SCRIPT);
    process.env.MUSIC_LX_SCRIPTS_DIR = dir;
    const cat = await getLxCatalog();
    expect(cat.scripts).toHaveLength(1);
    expect(cat.scripts[0]).toMatchObject({ id: "a-01", ok: true, state: "ok" });
    expect(cat.sources.some((s) => s.key === "qdy")).toBe(true);
  });

  it("显式目录不存在 → 报错说明目录不可用，而不是静默", async () => {
    process.env.MUSIC_LX_SCRIPTS_DIR = join(dir, "no-such-dir");
    await expect(getLxCatalog()).rejects.toThrow("MUSIC_LX_SCRIPTS_DIR");
  });

  it("目录内文件逐个隔离：无效脚本标 error，不影响其它脚本加载", async () => {
    await writeFileIn("bad.js", "not a valid script @@@");
    await writeFileIn("good.js", VALID_SCRIPT);
    process.env.MUSIC_LX_SCRIPTS_DIR = dir;
    const cat = await getLxCatalog();
    expect(cat.scripts.map((s) => s.id).sort()).toEqual(["bad", "good"]);
    expect(cat.scripts.find((s) => s.id === "bad").ok).toBe(false);
    expect(cat.scripts.find((s) => s.id === "good").ok).toBe(true);
    expect(cat.sources.some((s) => s.key === "qdy")).toBe(true);
  });
});
