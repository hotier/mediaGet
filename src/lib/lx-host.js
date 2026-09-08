/**
 * lx-host —— mediaGet 内置的「极简洛雪(lx-music) 生态音源宿主」
 *
 * 目标：把 lx-music 自定义音源脚本（例如 pdone/lx-music-source 的 qdy/qsvip 类，
 * 协议见 https://github.com/lyswhut/lx-music-api-server 与桌面端自定义源机制）
 * 跑在 Node 侧（本机 / Vercel / Docker 等 nodejs runtime），对外暴露统一动作调用：
 *   musicSearch / musicUrl / lyric（脚本注册什么就转发什么）。
 *
 * 脚本协议（仅实现本项目需要的子集）：
 *   1. 脚本顶部 `const { EVENT_NAMES, request, on, send } = globalThis.lx`；
 *   2. 脚本用 `send(EVENT_NAMES.inited, { openDevTools, sources })` 上报支持的源；
 *   3. 脚本用 `on(EVENT_NAMES.request, ({ action, source, info }) => Promise)` 处理请求；
 *   4. 脚本内部网络请求走宿主 `request(url, options, cb)`（回调风格，err/res）。
 *
 * 安全边界：脚本作为不可信代码在 node:vm 独立上下文中执行，仅暴露 fetch 代理
 * （默认实现走宿主 fetch，带超时/UA/自动跟随重定向）与少量标准全局；不暴露
 * require / process / global / 宿主 fs 等。注意 vm 不是完整操作系统级沙箱，
 * 只建议加载你信任/审查过的音源脚本。
 *
 * 本文件不依赖任何 mediaGet 业务模块，可独立单测。
 */
import { Script, createContext } from "node:vm";

/** 洛雪事件名（与桌面端自定义音源协议一致） */
export const LX_EVENT = Object.freeze({
  request: "request",
  inited: "inited",
  updateAlert: "updateAlert",
  audio: "audio",
});

/** 脚本模块级初始化（顶部建表/注册事件）超时 */
export const LX_SCRIPT_RUN_TIMEOUT = 10_000;
/** 单次 action 最长等待（qsvip 代理解密有时会等到 60s） */
export const LX_ACTION_TIMEOUT = 120_000;
/** 单次脚本内 http 请求默认超时 */
export const LX_REQUEST_TIMEOUT = 15_000;

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** 脚本首块 /*! ... *\/ 注释中的 @name/@description/@version/@author 元信息 */
export function parseLxScriptMeta(code) {
  const meta = { name: "", description: "", version: "", author: "" };
  if (typeof code !== "string") return meta;
  const header = code.match(/\/\*!?([\s\S]*?)\*\//);
  if (header) {
    for (const m of header[1].matchAll(/@(\w+)\s+([^\n]+)/g)) {
      const key = m[1];
      if (Object.prototype.hasOwnProperty.call(meta, key)) {
        meta[key] = m[2].trim();
      }
    }
  }
  return meta;
}

/** 从脚本 URL 猜一个可读名（无 @name 元信息时兜底） */
export function scriptNameFromUrl(url) {
  try {
    const { host, pathname } = new URL(url);
    const file = pathname.split("/").pop() || "";
    return file.replace(/\.js$/i, "") ? `${host}/${file.replace(/\.js$/i, "")}` : host;
  } catch {
    return String(url);
  }
}

function toLxError(err, prefix) {
  if (err && typeof err === "object" && typeof err.message === "string") {
    const e = new Error(`${prefix}${err.message}`);
    e.cause = err;
    return e;
  }
  return new Error(`${prefix}${String(err ?? "unknown error")}`);
}

/**
 * 默认的网络 shim：把 lx 脚本回调风格 `request(url, options, cb)` 映射到宿主 fetch。
 * - options.timeout（毫秒）：单请求超时
 * - options.method / headers / body：body 为对象时自动 JSON 化并补 Content-Type
 * - redirect 默认跟随（对齐 lx 桌面端的 follow_max 行为，未细粒度暴露 max 次数）
 * - 未传 cb 时返回 Promise（兼容少量同时支持 Promise 用法的脚本）
 */
export function createLxHttpRequest({ timeout = LX_REQUEST_TIMEOUT, userAgent = DEFAULT_UA } = {}) {
  const normalizeError = (err) => {
    if (err && (err.name === "AbortError" || /abort|timed?out/i.test(err.message || ""))) {
      return { message: "timeout" };
    }
    return { message: (err && err.message) || String(err) };
  };

  return function lxRequest(url, options = {}, cb) {
    const opts = options || {};
    const method = String(opts.method || "GET").toUpperCase();
    const limit = Number.isFinite(opts.timeout) ? opts.timeout : timeout;
    const requestTimeout = Math.max(1, Math.min(Math.abs(limit), LX_ACTION_TIMEOUT));

    const headers = {};
    for (const [k, v] of Object.entries(opts.headers || {})) {
      if (v == null) continue;
      headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
    }
    headers["User-Agent"] ||= userAgent;
    headers.Accept ||= "*/*";

    let body;
    if (opts.body != null && method !== "GET" && method !== "HEAD") {
      body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
      if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
    }

    const run = async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), requestTimeout);
      try {
        const res = await fetch(String(url), {
          method,
          headers,
          body,
          redirect: "follow",
          signal: ctrl.signal,
        });
        const text = await res.text();
        const resHeaders = {};
        res.headers.forEach((value, key) => {
          resHeaders[key] = value;
        });
        return {
          statusCode: res.status,
          statusMessage: res.statusText,
          headers: resHeaders,
          body: text,
        };
      } finally {
        clearTimeout(timer);
      }
    };

    if (typeof cb === "function") {
      run()
        .then((res) => cb(null, res))
        .catch((err) => cb(normalizeError(err), null));
      return undefined;
    }
    return run().catch((err) => {
      throw normalizeError(err);
    });
  };
}

/**
 * 创建一个洛雪自定义音源脚本宿主。
 * @param {object} opts
 * @param {string} opts.code  脚本源码
 * @param {string} [opts.url] 脚本地址（用于错误定位/展示）
 * @param {Function} [opts.request] 自定义网络实现（默认 createLxHttpRequest()）
 * @returns {{
 *   meta: { name, description, version, author, url },
 *   openDevTools: boolean,
 *   sources: Record<string, { name, type, actions, qualitys }>,
 *   initError: Error | null,
 *   invoke: (payload: {action: string, source: string, info?: object}) => Promise<unknown>,
 * }}
 */
export function createLxScriptHost({ code, url = "lx-script.js", request } = {}) {
  if (typeof code !== "string" || !code.trim()) {
    throw new TypeError("lx-host: code 必填且不能为空");
  }

  let requestHandler = null;
  let inited = null;

  const tagConsole = (() => {
    const name = scriptNameFromUrl(url);
    const tagged = {};
    for (const level of ["log", "info", "warn", "error", "debug"]) {
      tagged[level] = (...args) => console[level](`[lx:${name}]`, ...args);
    }
    return tagged;
  })();

  // 沙箱上下文：只暴露脚本协议所需的最小全局
  const sandbox = {
    console: tagConsole,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    btoa: (s) => Buffer.from(String(s), "binary").toString("base64"),
    atob: (s) => Buffer.from(String(s), "base64").toString("binary"),
  };

  const lx = {
    version: "1.0.0",
    env: "mediaGet-lx-host",
    EVENT_NAMES: { ...LX_EVENT },
    request: request || createLxHttpRequest(),
    /** 注册事件处理器：目前仅 request（脚本对每个请求回调一次） */
    on(eventName, handler) {
      if (eventName === LX_EVENT.request && typeof handler === "function") {
        requestHandler = handler;
      }
      return Promise.resolve();
    },
    /** 上报事件：inited 携带 { openDevTools, sources } */
    send(eventName, payload) {
      if (eventName === LX_EVENT.inited && payload && typeof payload === "object") {
        inited = payload;
      }
      return Promise.resolve();
    },
    utils: {},
  };
  sandbox.lx = lx;
  sandbox.globalThis = sandbox;

  const context = createContext(sandbox, { name: url });

  let initError = null;
  try {
    new Script(String(code), { filename: url }).runInContext(context, {
      timeout: LX_SCRIPT_RUN_TIMEOUT,
    });
  } catch (err) {
    initError = toLxError(err, "脚本初始化失败：");
  }

  const meta = parseLxScriptMeta(code);
  const sources =
    inited && inited.sources && typeof inited.sources === "object" && !Array.isArray(inited.sources)
      ? inited.sources
      : {};

  const invoke = ({ action, source, info } = {}) => {
    if (initError) return Promise.reject(initError);
    if (typeof action !== "string" || !action) {
      return Promise.reject(new Error("参数不完整：缺少 action"));
    }
    if (typeof requestHandler !== "function") {
      return Promise.reject(new Error("脚本未注册 request 事件处理器"));
    }
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`音源动作超时（>${Math.round(LX_ACTION_TIMEOUT / 1000)}s）`));
      }, LX_ACTION_TIMEOUT);
      Promise.resolve()
        .then(() => requestHandler({ action, source, info: info ?? {} }))
        .then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (err) => {
            clearTimeout(timer);
            reject(toLxError(err, `音源 ${source} ${action} 失败：`));
          }
        )
        .catch((err) => {
          // requestHandler 同步抛错等兜底
          clearTimeout(timer);
          reject(toLxError(err, `音源 ${source} ${action} 失败：`));
        });
      void startedAt;
    });
  };

  return {
    meta: {
      name: meta.name || scriptNameFromUrl(url),
      description: meta.description,
      version: meta.version,
      author: meta.author,
      url,
    },
    openDevTools: Boolean(inited && inited.openDevTools),
    sources,
    initError,
    invoke,
  };
}
