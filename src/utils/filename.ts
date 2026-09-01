/**
 * 文件名净化工具：把任意字符串片段（作者名 / 标题 / 文案等）清洗成
 * Windows 与主流浏览器都安全的文件名组成部分，并支持限长。
 *
 * 各平台组件拼接下载文件名时统一使用，避免重复实现与命名规则不一致。
 *
 * 处理规则：
 * - 控制字符（含 \t、\0-\x1f、\x7f）→ 空格
 * - Windows 非法字符 \ / : * ? " < > | → _
 * - 表情符号（Extended_Pictographic 及变体选择符 VS16）→ 删除
 *   （同时避免 slice 按 UTF-16 码元截断代理对产生乱码）
 * - 连续点 ".."（Windows 保留名）→ _
 * - 零宽字符（\u200b-\u200d、\ufeff）→ 删除
 * - 连续下划线 → 压缩为一个；首尾下划线 → 移除
 * - 首尾空白 → 去掉；结尾的 . 或空格 → 去掉
 *   （Windows 会自动剥离文件名结尾的点/空格，导致命名错乱）
 * - Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）→ 加 _ 前缀
 * - 超长 → 截断到 maxLen
 * - 清洗后为空 → 回退为 fallback
 */
export function sanitizeFilename(
  s: string,
  maxLen = 60,
  fallback = "video"
): string {
  let name = s
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\\/:*?"<>|\r\n]/g, "_")
    .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "")
    .replace(/\.{2,}/g, "_")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .trim()
    .replace(/[.\s]+$/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maxLen)
    .replace(/[.\s]+$/g, "")
    .replace(/^_+|_+$/g, "")
    .trim();
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) name = `_${name}`;
  return name || fallback;
}
