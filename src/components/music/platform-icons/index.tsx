import type { SearchSourceKey } from "@/components/music/types";

/**
 * 音乐平台品牌图标统一引用 public/logos/ 下的静态 SVG 文件：
 *   文件命名 = 平台 key + ".svg"，如 netease.svg / kuwo.svg / joox.svg。
 * 把完整品牌 SVG（建议 viewBox="0 0 24 24"）直接存入 public/logos/ 即可，
 * 下方 PlatformIcon 会自动以 <img> 形式展示；若要给平台配置非同名 logo，
 * 把文件名填进 PLATFORM_LOGOS 映射即可。
 */
const PLATFORM_LOGOS: Partial<Record<SearchSourceKey, string>> = {
  netease: "/logos/netease.svg",
  kuwo: "/logos/kuwo.svg",
  joox: "/logos/joox.svg",
  // GD 直链通道对 QQ音乐的 source key 为 tencent；品牌 logo 复用平台解析用的 qqmusic.svg
  tencent: "/logos/qqmusic.svg",
};

export interface PlatformIconProps {
  /** 平台 key（netease / tencent / kuwo / joox） */
  source: SearchSourceKey;
  /** 图标边长（默认 14） */
  size?: number;
  className?: string;
}

/** 按平台 key 渲染 public/logos 下对应的品牌 logo */
export function PlatformIcon({
  source,
  size = 14,
  className = "",
}: PlatformIconProps) {
  const src = PLATFORM_LOGOS[source];
  if (!src) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className={`shrink-0 object-contain ${className}`}
      aria-hidden="true"
    />
  );
}
