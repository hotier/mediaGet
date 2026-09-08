// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LX_EVENT,
  createLxHttpRequest,
  createLxScriptHost,
  parseLxScriptMeta,
  scriptNameFromUrl,
} from "@/lib/lx-host";

/**
 * lx-host 单元测试：用一个「洛雪自定义音源协议」最小脚本驱动宿主，
 * 验证元信息解析 / 沙箱初始化 / 事件捕获 / invoke 动作分发 / 网络 shim。
 * 网络层通过 stub 全局 fetch 完成，不触真实网络。
 */

/** 带元信息头且注册了 qdy 源的最小合法脚本 */
const VALID_SCRIPT = `/*!
 * @name 汽水全豆
 * @description 演示用测试音源
 * @version 2.0.1
 * @author vitest
 */
const { EVENT_NAMES, on, send } = globalThis.lx;
send(EVENT_NAMES.inited, {
  openDevTools: false,
  sources: {
    qdy: {
      name: "汽水音乐",
      type: "music",
      actions: ["musicSearch", "musicUrl", "lyric"],
      qualitys: ["128k", "320k", "flac"],
    },
  },
});
on(EVENT_NAMES.request, async ({ action, source }) => {
  if (action === "musicSearch") {
    return { list: [{ id: "1024", name: "晴天", singer: ["周杰伦"] }] };
  }
  if (action === "musicUrl") {
    return { url: "https://cdn.example/1024.mp3", br: 320, size: 9021 };
  }
  if (action === "lyric") {
    return { lyric: "[00:01.00]词" };
  }
  return null;
});
`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseLxScriptMeta / scriptNameFromUrl", () => {
  it("从 /*! @... */ 头注释提取 @name/@description/@version/@author", () => {
    const meta = parseLxScriptMeta(VALID_SCRIPT);
    expect(meta.name).toBe("汽水全豆");
    expect(meta.description).toBe("演示用测试音源");
    expect(meta.version).toBe("2.0.1");
    expect(meta.author).toBe("vitest");
  });

  it("无元信息头时从 URL 推导可读名", () => {
    expect(scriptNameFromUrl("https://example.com/sources/qdy.js")).toBe(
      "example.com/qdy"
    );
    expect(scriptNameFromUrl("https://example.com")).toBe("example.com");
    expect(scriptNameFromUrl("not a url")).toBe("not a url");
  });
});

describe("createLxScriptHost · 初始化与元信息", () => {
  it("捕获 inited 上报的 sources / openDevTools，meta.name 优先用 @name", () => {
    const host = createLxScriptHost({ code: VALID_SCRIPT, url: "https://example.com/qdy.js" });
    expect(host.initError).toBeNull();
    expect(host.meta.name).toBe("汽水全豆");
    expect(host.meta.url).toBe("https://example.com/qdy.js");
    expect(host.openDevTools).toBe(false);
    expect(host.sources.qdy).toMatchObject({
      name: "汽水音乐",
      type: "music",
      actions: ["musicSearch", "musicUrl", "lyric"],
      qualitys: ["128k", "320k", "flac"],
    });
  });

  it("脚本语法错误 → initError 携带定位信息，invoke 直接拒绝该错误", async () => {
    const host = createLxScriptHost({
      code: `const { EVENT_NAMES } = globalThis.lx;\nthrow new Error("boom-in-init");`,
      url: "https://example.com/bad.js",
    });
    expect(host.initError).toBeTruthy();
    expect(host.initError.message).toContain("boom-in-init");
    await expect(
      host.invoke({ action: "musicSearch", source: "qdy", info: { keyword: "x", page: 1 } })
    ).rejects.toMatchObject({ message: expect.stringContaining("boom-in-init") });
  });

  it("空 / 缺 code 直接抛 TypeError", () => {
    expect(() => createLxScriptHost({ code: "" })).toThrow(/code/);
    expect(() => createLxScriptHost({})).toThrow(/code/);
  });
});

describe("createLxScriptHost · invoke 动作分发", () => {
  it("musicSearch → 透传脚本 handler 返回（含 list）", async () => {
    const host = createLxScriptHost({ code: VALID_SCRIPT });
    const result = await host.invoke({
      action: "musicSearch",
      source: "qdy",
      info: { keyword: "晴天", page: 1, pagesize: 10 },
    });
    expect(result.list[0]).toMatchObject({ id: "1024", name: "晴天" });
  });

  it("musicUrl → 透传直链/码率/大小", async () => {
    const host = createLxScriptHost({ code: VALID_SCRIPT });
    const result = await host.invoke({ action: "musicUrl", source: "qdy" });
    expect(result).toMatchObject({ url: "https://cdn.example/1024.mp3", br: 320, size: 9021 });
  });

  it("handler 拒绝 → 拒绝信息带音源/动作前缀（利于 route 透出）", async () => {
    const code = `const { EVENT_NAMES, on, send } = globalThis.lx;
send(EVENT_NAMES.inited, { sources: { qdy: { name: "q", type: "music", actions: ["musicSearch"] } } });
on(EVENT_NAMES.request, async () => { throw new Error("所有源均失败"); });`;
    const host = createLxScriptHost({ code });
    await expect(
      host.invoke({ action: "musicSearch", source: "qdy", info: {} })
    ).rejects.toThrow(/qdy musicSearch 失败.*所有源均失败/);
  });

  it("脚本未注册 request 处理器 → 拒绝并提示", async () => {
    const code = `const { EVENT_NAMES, send } = globalThis.lx;
send(EVENT_NAMES.inited, { sources: { qdy: { name: "q", type: "music", actions: [] } } });`;
    const host = createLxScriptHost({ code });
    await expect(host.invoke({ action: "musicSearch", source: "qdy", info: {} })).rejects.toThrow(
      /未注册 request/
    );
  });

  it("缺 action → 拒绝提示参数不完整", async () => {
    const host = createLxScriptHost({ code: VALID_SCRIPT });
    await expect(host.invoke({ source: "qdy" })).rejects.toThrow(/action/);
  });

  it("LX_EVENT 保持协议命名", () => {
    expect(LX_EVENT).toMatchObject({ request: "request", inited: "inited", updateAlert: "updateAlert", audio: "audio" });
  });
});

describe("createLxHttpRequest · 网络 shim", () => {
  it("回调风格：HTTP 200 → cb(null, res)，body 为响应文本", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ hello: "world" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
    );
    const fn = createLxHttpRequest({ timeout: 1000 });
    const out = await new Promise((resolve) => {
      fn("https://example.test/api", { method: "GET" }, (err, res) => resolve({ err, res }));
    });
    expect(out.err).toBeNull();
    expect(out.res.statusCode).toBe(200);
    expect(JSON.parse(out.res.body)).toEqual({ hello: "world" });
  });

  it("POST 对象 body 自动 JSON 化并补 Content-Type", async () => {
    let captured;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, opts) => {
        captured = { url, opts };
        return new Response("{}", { status: 200 });
      })
    );
    const fn = createLxHttpRequest({ timeout: 1000 });
    await new Promise((resolve) => fn("https://example.test/p", { method: "POST", body: { a: 1 } }, () => resolve()));
    expect(captured.opts.headers["Content-Type"]).toBe("application/json");
    expect(captured.opts.body).toBe('{"a":1}');
  });

  it("超时（脚本自定义 timeout 小于默认）→ cb(err.message === 'timeout')", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (url, opts) =>
          new Promise((_, reject) => {
            opts.signal.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          })
      )
    );
    const fn = createLxHttpRequest({ timeout: 30 });
    const out = await new Promise((resolve) =>
      fn("https://example.test/slow", { method: "GET" }, (err, res) => resolve({ err, res }))
    );
    expect(out.err.message).toBe("timeout");
    expect(out.res).toBeNull();
  });

  it("Promise 风格：无 cb 时返回 Promise（成功/失败均归一）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 }))
    );
    const fn = createLxHttpRequest({ timeout: 1000 });
    const res = await fn("https://example.test/a", { method: "GET" });
    expect(res.body).toBe("ok");
  });
});
