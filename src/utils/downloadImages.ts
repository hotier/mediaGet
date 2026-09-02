/**
 * 图片一键下载工具。
 *
 * 流程：fetch 原图 → Blob → a[download] 触发浏览器真实保存；
 * 若图床有 CORS / Referer 防盗链（fetch 直链被拒），自动回退到
 * 后端图片代理 /api/image（服务端带平台 Referer 防 403）；
 * 代理也失败时，最后回退为在新窗口打开直链（用户右键另存）。
 */

const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/bmp": "bmp",
};

/** 从图片 URL 提取扩展名（处理 query / `!` 处理参数），默认空串 */
function getImageExt(src: string): string {
  const clean = src.split("?")[0].split("!")[0];
  const m = clean.match(/\.(jpe?g|png|webp|gif|avif|bmp)(?!\w)/i);
  return m ? m[1].toLowerCase() : "";
}

/** 根据 Blob 实际类型补全文件名扩展名 */
function ensureExt(filename: string, blob: Blob, src: string): string {
  if (/\.[a-z0-9]{2,4}$/i.test(filename)) return filename;
  return `${filename}.${EXT_BY_TYPE[blob.type] || getImageExt(src) || "jpg"}`;
}

/** 拉取图片 Blob；响应非图片（HTML 错误页等）抛错 */
async function fetchImageBlob(url: string): Promise<Blob> {
  const res = await fetch(url, { mode: "cors" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  // 响应可能是 HTML 错误页而非图片，做基础校验
  if (!blob.type.startsWith("image/") && blob.size < 1024) {
    throw new Error("not an image");
  }
  return blob;
}

/** 单张图片下载：优先直链（Blob + a[download]），防盗链失败走后端代理，再失败回退新窗口打开 */
export async function downloadImage(src: string, filename: string): Promise<boolean> {
  let blob: Blob;
  try {
    blob = await fetchImageBlob(src);
  } catch {
    // 直链被 CORS / Referer 防盗链拦截：走后端图片代理（服务端带平台 Referer 防 403）
    try {
      blob = await fetchImageBlob(`/api/image?url=${encodeURIComponent(src)}`);
    } catch {
      // 代理也失败：回退为新窗口打开直链（用户右键另存）
      window.open(src, "_blank", "noopener,noreferrer");
      return false;
    }
  }

  const name = ensureExt(filename, blob, src);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

/**
 * 批量下载图片（逐个触发，带间隔避免浏览器批量拦截）。
 * @param indices 可选：每张图对应的「图集原序号」（1-based，多选下载场景传入，
 *                保证文件名保留用户看到的图序）；缺省按下载顺序 1..N 命名。
 * @returns 真实下载成功的张数（回退打开的算失败）
 */
export async function downloadAllImages(
  images: string[],
  baseName: string,
  indices?: number[]
): Promise<number> {
  let ok = 0;
  for (let i = 0; i < images.length; i++) {
    const n = indices?.[i] ?? i + 1;
    const okOne = await downloadImage(images[i], `${baseName}-${n}`);
    if (okOne) ok++;
    // 间隔避免浏览器把连续下载当作批量/恶意行为
    await new Promise((r) => setTimeout(r, 400));
  }
  return ok;
}
