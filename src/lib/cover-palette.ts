/**
 * 封面动态取色：把专辑封面缩略采样后得到「主色 / 明暗」，据此推导一套
 * 整页歌词可用的对比配色（背景渐变、文字、控件）。若跨域/加载失败则返回 null，
 * 由调用方回退到主题默认配色。
 * 支持 mode="dark"：暗色主题下强制走「深色渐变背景 + 浅色文字」变体，避免亮色
 * 封面在深色站点里突然切出一整块刺眼浅色背景。
 */

export interface CoverPalette {
  /** 背景渐变上端（不透明白，保证遮罩不透明） */
  c1: string;
  /** 背景渐变下端 */
  c2: string;
  /** 主要文字（歌词当前句 / 标题 / 图标） */
  fg: string;
  /** 次要文字（普通歌词行 / 次要按钮） */
  fgSoft: string;
  /** 弱化文字（歌手 / 时间 / 空态） */
  fgDim: string;
  /** 强调色（播放按钮 / 进度已播放段 / 高亮） */
  accent: string;
  /** 强调色 22% 底（图标按钮 on 态背景） */
  accentBg: string;
  /** 播放按钮图标颜色（按 accent 明暗自动取黑/白） */
  playInk: string;
  /** 玻璃按钮底色 */
  glass: string;
  /** 玻璃按钮 hover 底色 */
  glassHi: string;
  /** 按钮 / 分隔细线 */
  line: string;
  lineStrong: string;
  /** hover 点击态底色 */
  hover: string;
}

type Rgb = [number, number, number];

function luma([r, g, b]: Rgb): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 保持色相/饱和度地向指定亮度靠拢（亮度线性通道，单步即可到位） */
function tuneToward(rgb: Rgb, targetL: number): Rgb {
  const cur = luma(rgb);
  if (cur === 0) {
    const v = Math.round(Math.min(255, Math.max(0, targetL)));
    return [v, v, v];
  }
  if (Math.abs(cur - targetL) < 1) return rgb;
  if (targetL > cur) {
    const t = (targetL - cur) / (255 - cur); // 向白混合比例
    return [
      Math.round(rgb[0] + t * (255 - rgb[0])),
      Math.round(rgb[1] + t * (255 - rgb[1])),
      Math.round(rgb[2] + t * (255 - rgb[2])),
    ];
  }
  const f = targetL / cur; // 整体压暗比例
  return [
    Math.round(rgb[0] * f),
    Math.round(rgb[1] * f),
    Math.round(rgb[2] * f),
  ];
}

function rgba(rgb: Rgb, alpha: number): string {
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

function fmt(rgb: Rgb): string {
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

/** 加载图片（带中止信号）。依赖 DOM，仅浏览器调用 */
function loadImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // 以 CORS 模式请求外部 CDN 封面：未声明 crossOrigin 时图片会按 no-cors 加载，
    // 即便服务器返回了 ACAO 头，绘制到画布后仍视为跨域污染，getImageData 必然抛错。
    // 设 anonymous 后：CDN 放行（ACAO:*）→ 可取色；不放行 → onerror 走同源字节代理回退。
    img.crossOrigin = "anonymous";
    const onAbort = () => {
      cleanup();
      reject(new DOMException("aborted", "AbortError"));
    };
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      img.onload = null;
      img.onerror = null;
    };
    img.onload = () => {
      cleanup();
      resolve(img);
    };
    img.onerror = () => {
      cleanup();
      reject(new Error("image load failed"));
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }
    img.src = url;
  });
}

/**
 * 把图片压到 SIZExSIZE 采样，返回「饱和度加权平均色」——降低白色歌词字/边缘
 * 等低饱和像素的干扰，得到更接近专辑主色调的颜色。无有效像素返回 null。
 */
function sampleDominant(img: HTMLImageElement): Rgb | null {
  const S = 36;
  const canvas = document.createElement("canvas");
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, S, S);
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, S, S).data;
  } catch {
    return null; // 跨域污染（理论上同源代理已规避）
  }

  let sw = 0;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let aw = 0;
  let ar = 0;
  let ag = 0;
  let ab = 0;

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 120) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const sat = mx === 0 ? 0 : (mx - mn) / mx; // 0..1
    const w = 0.25 + 0.75 * Math.pow(sat, 1.6); // 饱和度加权
    sr += r * w;
    sg += g * w;
    sb += b * w;
    sw += w;
    ar += r;
    ag += g;
    ab += b;
    aw += 1;
  }

  if (aw === 0) return null;
  // 高饱和像素少时退化为整体平均，保证仍能取到代表色
  if (sw < aw * 0.05) return [ar / aw, ag / aw, ab / aw].map(Math.round) as Rgb;
  return [sr / sw, sg / sw, sb / sw].map(Math.round) as Rgb;
}

/**
 * 由主色生成完整对比调色板。
 * 规则：主色偏暗 → 深色渐变背景 + 浅色文字；主色偏亮 → 亮色渐变背景 + 深色文字。
 * 背景亮度由主色推算并强制落到与文字相反的明度区间，保证任意封面都可读。
 * mode="dark" 时不看封面明暗一律进入「深背景浅字」分支（保留主色相/饱和度），
 * 供暗色主题下整页歌词与站点深色风格保持一致。
 */
function buildPalette(dom: Rgb, mode: "auto" | "dark" = "auto"): CoverPalette {
  const lightText = mode === "dark" || luma(dom) < 150;

  // 背景两段目标亮度：浅字(暗背景) 30→6；深字(亮背景) 214→166
  const c1 = tuneToward(dom, lightText ? 34 : 214);
  const c2 = tuneToward(dom, lightText ? 8 : 168);

  const fg: Rgb = lightText ? [244, 247, 250] : [17, 22, 28];
  const fgSoft = rgba(fg, lightText ? 0.78 : 0.72);
  const fgDim = rgba(fg, lightText ? 0.46 : 0.5);

  // 强调色：在主色基础上压到与背景可区分的亮度，图标黑白按 accent 明暗自动判
  const accentRgb = tuneToward(dom, lightText ? 178 : 52);
  const accent = fmt(accentRgb);
  const accentBg = rgba(accentRgb, 0.24);
  const playInk = luma(accentRgb) > 140 ? "#10141a" : "#ffffff";

  if (lightText) {
    return {
      c1: fmt(c1),
      c2: fmt(c2),
      fg: fmt(fg),
      fgSoft,
      fgDim,
      accent,
      accentBg,
      playInk,
      glass: "rgba(255, 255, 255, 0.14)",
      glassHi: "rgba(255, 255, 255, 0.24)",
      line: "rgba(255, 255, 255, 0.18)",
      lineStrong: "rgba(255, 255, 255, 0.32)",
      hover: "rgba(255, 255, 255, 0.12)",
    };
  }
  return {
    c1: fmt(c1),
    c2: fmt(c2),
    fg: fmt(fg),
    fgSoft,
    fgDim,
    accent,
    accentBg,
    playInk,
    glass: "rgba(255, 255, 255, 0.6)",
    glassHi: "rgba(255, 255, 255, 0.86)",
    line: "rgba(12, 16, 20, 0.16)",
    lineStrong: "rgba(12, 16, 20, 0.3)",
    hover: "rgba(12, 16, 20, 0.06)",
  };
}

/**
 * 取封面调色板。优先尝试 primaryUrl（如外部 CDN 直链，仅当其允许 CORS 时可用）；
 * 跨域/解码失败时回退到 fallbackUrl（项目自身的同源字节代理，保证可取色）。
 */
export async function sampleCoverPalette(
  primaryUrl: string,
  fallbackUrl: string,
  signal?: AbortSignal,
  opts: { mode?: "auto" | "dark" } = {}
): Promise<CoverPalette | null> {
  const urls = [primaryUrl, fallbackUrl]
    .filter(Boolean)
    .filter((u, i, arr) => arr.indexOf(u) === i);

  let lastErr: unknown = null;
  for (const url of urls) {
    if (signal?.aborted) return null;
    try {
      const img = await loadImage(url, signal);
      const dom = sampleDominant(img);
      if (dom) return buildPalette(dom, opts.mode);
    } catch (err) {
      if (signal?.aborted) return null;
      lastErr = err;
    }
  }
  // 静默失败：调用方回退到默认主题配色
  void lastErr;
  return null;
}
