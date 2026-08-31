import { VIDEO_PLATFORMS, type VideoPlatformKey } from "@/config/video-platforms";

// 各大平台在色块里展示的简短标识（没有则回退到名称首字）— 仅作回退
const MONOGRAM: Partial<Record<VideoPlatformKey, string>> = {
  douyin: "抖",
  bilibili: "B",
  kuaishou: "快",
  weibo: "微",
  xhs: "红",
  qsmusic: "汽",
  pipigx: "皮",
  ppxia: "虾",
  huoshan: "火",
  weishi: "视",
  xigua: "西",
  zuiyou: "右",
  quanmin: "度",
  lishipin: "梨",
  huya: "虎",
  acfun: "A",
  meipai: "美",
  doupai: "逗",
  quanminkge: "K",
  sixroom: "六",
  xinpianchang: "新",
  haokan: "好",
  twitter: "X",
  tiktok: "T",
  lvzhou: "绿",
};

/**
 * 平台图标，优先级：
 * 1) logo 为真实彩色（PNG / 非 -white 的 SVG 官方彩色图标）→ 直接展示原图
 * 2) logo 为白标 SVG（文件名含 -white，simple-icons 白色填充）→ 铺在品牌色块上
 * 3) 都没有 → 品牌色块 + 文字回退
 */
export default function PlatformIcon({
  platform,
  size = 20,
  className = "",
  rounded = "rounded-lg",
}: {
  platform: VideoPlatformKey;
  size?: number;
  className?: string;
  rounded?: string;
}) {
  const cfg = VIDEO_PLATFORMS[platform] as (typeof VIDEO_PLATFORMS)[VideoPlatformKey] & {
    logo?: string;
  };
  if (!cfg) return null;
  const logo = cfg.logo;
  const isPng = !!logo && /\.png$/i.test(logo);
  const isSvg = !!logo && /\.svg$/i.test(logo);
  // 白标 SVG：文件名约定 -white.svg（simple-icons 单色白标，需铺品牌色块）
  const isWhiteSvg = isSvg && /-white\.svg$/i.test(logo);

  // 1) 真实彩色（PNG / 彩色官方 SVG）：直接展示原图
  if (isPng || (isSvg && !isWhiteSvg)) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logo}
        alt=""
        width={size}
        height={size}
        className={`shrink-0 object-contain ${rounded} ${className}`}
        style={{ width: size, height: size }}
        aria-hidden="true"
      />
    );
  }

  // 2) 白标 SVG：铺在品牌色块上（fill=#fff）
  if (isWhiteSvg) {
    return (
      <span
        className={`inline-grid shrink-0 place-items-center ${rounded} ${className}`}
        style={{
          width: size,
          height: size,
          background: cfg.color,
          boxShadow:
            "inset 0 1px 0 rgba(255,255,255,.28), 0 1px 2px rgba(15,23,42,.18)",
        }}
        aria-hidden="true"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={logo}
          alt=""
          width={size}
          height={size}
          className="object-contain"
          style={{ width: size * 0.55, height: size * 0.55 }}
        />
      </span>
    );
  }

  // 3) 回退：品牌色块 + 文字
  const label = MONOGRAM[platform] ?? cfg.name.slice(0, 1);
  return (
    <span
      className={`inline-grid shrink-0 place-items-center font-bold text-white ${rounded} ${className}`}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.46,
        lineHeight: 1,
        background: cfg.color,
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,.28), 0 1px 2px rgba(15,23,42,.18)",
      }}
      aria-hidden="true"
    >
      {label}
    </span>
  );
}