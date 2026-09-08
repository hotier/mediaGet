/**
 * QQ音乐 (y.qq.com) 网页端 musicu.fcg 请求签名 —— zzc 算法移植。
 *
 * 参考开源实现 jixunmoe/qmweb-sign（MIT License），官方测试向量一并移植作单测基线：
 *   "123"         → zzcec1b555gzqzg7laztguyjl2bu20r6x1w50c55f60
 *   "hello world" → zzcfb3415bc4nfoxmd9uik71mkomtubjfjp141a1cbbcc
 *   "jixun.uk"    → zzcf47b78apso27mjjbbzgbof0szikfkvyqc7fc3a2b5
 *
 * 算法：SHA1 摘要（40 位十六进制）按固定下标取字符拼出首尾两段；
 * 中段为固定混淆值逐字节 XOR 摘要对应两位十六进制后 base64（剔除 \ / + =），
 * 最终 zzc + 首段 + 中段 + 尾段 整体转小写。
 *
 * 移植要点：下标 40 超出摘要长度，JS 里 hash[40] 为 undefined、join 时按空串
 * 处理（Python 参考实现为此显式过滤 < 40）——照抄 JS 语义即可，勿"修复"。
 */
import crypto from "crypto";

const PART_1_INDEXES = [23, 14, 6, 36, 16, 40, 7, 19];
const PART_2_INDEXES = [16, 1, 32, 12, 19, 27, 8, 5];
const SCRAMBLE_VALUES = [
  89, 39, 179, 150, 218, 82, 58, 252, 177, 52,
  186, 123, 120, 64, 242, 133, 143, 161, 121, 179,
];

export function zzcSign(text) {
  const hash = crypto
    .createHash("sha1")
    .update(Buffer.from(text, "utf-8"))
    .digest("hex")
    .toUpperCase();
  const pick = (indexes) => indexes.map((idx) => hash[idx]).join("");
  const xored = Buffer.from(
    SCRAMBLE_VALUES.map((value, i) => value ^ parseInt(hash.slice(i * 2, i * 2 + 2), 16))
  );
  const b64 = xored.toString("base64").replace(/[\\/+=]/g, "");
  return `zzc${pick(PART_1_INDEXES)}${b64}${pick(PART_2_INDEXES)}`.toLowerCase();
}
