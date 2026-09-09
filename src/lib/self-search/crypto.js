/**
 * 自研音乐搜索 —— 加密工具（纯逻辑，可单测）。
 *
 * 网易云 eapi 加密参考 lx-music-desktop（Apache-2.0）
 * src/renderer/utils/musicSdk/wy/utils/crypto.js 的 eapi 实现；
 * QQ 音乐 sign 复用仓库既有 @/lib/qqmusic-sign（zzc，qmweb-sign 移植，MIT）。
 */
import crypto from "crypto";

/** MD5（小写 hex） */
export function md5Hex(text) {
  return crypto.createHash("md5").update(String(text ?? ""), "utf8").digest("hex");
}

/** AES-128-ECB 加密，返回 hex（大写下） */
export function aes128EcbHex(text, key) {
  const cipher = crypto.createCipheriv(
    "aes-128-ecb",
    Buffer.from(String(key), "utf8"),
    null
  );
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()])
    .toString("hex")
    .toUpperCase();
}

/** 网易云 eapi 加密：把「目标路径 + 明文 + 摘要」包进固定拼接串后整体 AES-ECB */
export function wyEapi(url, object) {
  const text = typeof object === "object" ? JSON.stringify(object) : object;
  const digest = md5Hex(`nobody${url}use${text}md5forencrypt`);
  const data = `${url}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
  return aes128EcbHex(data, "e82ckenh8dichen8");
}
