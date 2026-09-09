/**
 * 自研音乐搜索 —— 轻量 fetch 封装与通用解码工具。
 *
 * 参照 lx-music-desktop（Apache-2.0）musicSdk 的 httpFetch / decodeName / formatSingerName，
 * 以 Node 18+ 原生 fetch 重写（本模块为纯逻辑，便于单测）。
 */

/** 默认浏览器 UA（部分平台要求非 Node UA） */
export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export const REQUEST_TIMEOUT = 10000;

/** 发 GET 请求并解析 JSON；非 2xx / 非 JSON 抛错 */
export async function fetchJson(url, { headers = {}, timeout = REQUEST_TIMEOUT } = {}) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": BROWSER_UA,
      Accept: "application/json, text/plain, */*",
      ...headers,
    },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return await res.json();
}

/** 发 POST 表单（application/x-www-form-urlencoded）并解析 JSON */
export async function postFormJson(url, form, { headers = {}, timeout = REQUEST_TIMEOUT } = {}) {
  const body = new URLSearchParams(form).toString();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent": BROWSER_UA,
      "Content-Type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body,
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return await res.json();
}

/** 发 POST JSON（body 自动 stringify）并解析 JSON */
export async function postJson(url, data, { headers = {}, timeout = REQUEST_TIMEOUT } = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent": BROWSER_UA,
      "Content-Type": "application/json",
      ...headers,
    },
    body: typeof data === "string" ? data : JSON.stringify(data),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return await res.json();
}

/** 安全解码服务端返回中可能被 URI 编码的中文（lx 的 decodeName） */
export function decodeName(name) {
  if (name == null) return "";
  const value = String(name);
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 把封面等图片地址升级为 https（协议相对 // 与 http:// 都转 https，规避线上页面 mixed-content） */
export function upgradeToHttps(url) {
  if (!url) return "";
  const value = String(url).trim();
  if (/^https:\/\//i.test(value)) return value;
  if (/^\/\//.test(value)) return `https:${value}`;
  if (/^https?:\/\//i.test(value)) return value.replace(/^http:\/\//i, "https://");
  return value;
}

/** 把歌手列表（形如 [{name}] 或字符串）拼接成 lx 风格的“、”分隔字符串 */
export function formatSingerName(singers, key = "name") {
  if (typeof singers === "string") return singers || "";
  if (!Array.isArray(singers)) return "";
  return singers
    .map((s) => (typeof s === "object" && s !== null ? String(s[key] ?? "") : String(s)))
    .filter((s) => s && s !== "未知")
    .join("、");
}

/** 秒数 → mm:ss（lx 的 formatPlayTime）；非法返回 "0:00" */
export function formatPlayTime(seconds) {
  const sec = Math.max(0, Math.floor(Number(seconds) || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 字节数 → 可读大小（lx 的 sizeFormate 语义），保留用于音质字段扩展 */
export function sizeFormate(size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) return null;
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)}${units[i]}`;
}
