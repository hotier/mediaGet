"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Music2 } from "lucide-react";
import { siteConfig } from "@/config/site";
import ThemeToggle from "@/components/ThemeToggle";

/**
 * 站点顶部导航（自研组件）
 * - 左侧：站点品牌（渐变 logo + 标题，/music 下动态切换为音乐 logo/标题）
 * - 右侧：视频解析 / 音乐解析 / 常见问题入口 + 主题切换，各页面保持一致
 * 说明：「发现歌曲 / 播放列表」切换器已移至 /music 内容区顶部功能区左上角
 * （见 components/music/MusicViewSeg.tsx），此处不再展示。
 */
export default function SiteHeader() {
  const pathname = usePathname();
  const isMusic = pathname === "/music";

  const linkCls =
    "rounded-lg px-3 py-1.5 transition-colors hover:bg-glass-2 hover:text-primary";

  return (
    <header className="sticky top-0 z-50 border-b border-border-subtle bg-glass-1 backdrop-blur-xl">
      <div className="flex h-14 w-full items-center justify-between gap-2 px-4 sm:px-6 lg:px-8">
        {/* 左侧：Brand（/music 动态切换音乐 logo + 标题） */}
        <div className="flex min-w-0 items-center gap-1 sm:gap-2">
          <Link href="/" className="group flex min-w-0 items-center gap-2.5">
            {isMusic ? (
              <>
                <span
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-xl text-white"
                  style={{
                    background: "linear-gradient(135deg, #5b7cfa 0%, #335eea 100%)",
                    boxShadow: "0 4px 12px rgba(51, 94, 234, 0.35)",
                  }}>
                  <Music2 className="h-4 w-4" strokeWidth={2.2} />
                </span>
                <span className="flex min-w-0 flex-col leading-tight">
                  <span className="truncate text-sm font-bold text-foreground">
                    音乐解析
                  </span>
                  <span className="hidden text-[10px] text-muted sm:block">
                    {siteConfig.name} · 在线点播
                  </span>
                </span>
              </>
            ) : (
              <>
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-[var(--accent)]">
                  {/* 闪电 / 播放图标 */}
                  <svg
                    className="h-4 w-4 text-white"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    aria-hidden="true">
                    <path d="M13 2L4.5 13.5H11L9.5 22 19.5 9.5H12.5L13 2z" />
                  </svg>
                </span>
                <span className="flex min-w-0 flex-col leading-tight">
                  <span className="truncate text-sm font-bold text-foreground">
                    {siteConfig.name}
                  </span>
                  <span className="text-[10px] text-muted">视频解析下载</span>
                </span>
              </>
            )}
          </Link>
        </div>

        {/* 右侧：三个入口在 /music 下保持不变 */}
        <nav className="flex flex-none items-center gap-1 text-xs text-secondary sm:gap-1.5">
          <Link href="/" className={linkCls}>
            视频解析
          </Link>
          <Link href="/music" className={linkCls}>
            音乐解析
          </Link>
          <Link href="/faq" className={linkCls}>
            常见问题
          </Link>
          <ThemeToggle />
        </nav>
      </div>
    </header>
  );
}
