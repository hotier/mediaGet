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
  xigua: "西",
  zuiyou: "右",
  huya: "虎",
  acfun: "A",
  quanminkge: "K",
  sixroom: "六",
  xinpianchang: "新",
  haokan: "好",
  twitter: "X",
  tiktok: "T",
  instagram: "IG",
  youtube: "YT",
  qqmusic: "Q",
};

/**
 * 平台图标：
 * 1) logo 为 SVG/PNG → 直接展示原图（图标需为完整图形、自带底色，可自适应深浅主题）
 * 2) 无 logo → 品牌色块 + 文字回退
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
  const hasImage = !!logo && /\.(svg|png)$/i.test(logo);

  // 1) SVG / PNG 图标：直接展示原图
  if (hasImage) {
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

  // 2) 回退：品牌色块 + 文字
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