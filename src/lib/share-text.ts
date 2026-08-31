/**
 * 分享文案 → 链接提取（纯函数，无运行时依赖）。
 *
 * 抖音/B站/小红书/快手等 App 复制出的分享内容通常是
 * 「【标题】xxx 复制打开抖音，看看 https://v.douyin.com/xxx/ 的视频…」，
 * 链接后可能紧跟中文标点、全角空格、引号或半角尖括号，需在此处截断。
 *
 * 同时被前端（src/utils/share.ts）与后端 API（src/app/api/parse-text/route.js）
 * 复用，避免前后端两套正则漂移不一致。
 */
export function extractUrlFromShareText(text: string): string | null {
  if (typeof text !== "string") return null;
  const match = text.match(
    /https?:\/\/[^\s\u3000\u00A0，。！？、；：（）【】《》"'“”‘’<>]+/i
  );
  if (!match) return null;
  // 剔除 URL 末尾可能残留的中英文标点（如 "https://v.douyin.com/xxx/."）
  return match[0].replace(/[，。！？、；：.,!?;]+$/, "");
}
