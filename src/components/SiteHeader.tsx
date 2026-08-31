import Link from "next/link";
import { siteConfig } from "@/config/site";
import ThemeToggle from "@/components/ThemeToggle";

/**
 * 站点顶部导航（自研组件）
 * - 左侧品牌：渐变 logo + 站点名
 * - 右侧导航链接
 * 纯服务端组件，无外部依赖
 */
export default function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-border-subtle bg-glass-1 backdrop-blur-xl">
      <div className="flex h-14 w-full items-center justify-between px-4 sm:px-6 lg:px-8">
        {/* Brand */}
        <Link href="/" className="group flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-xl bg-[var(--accent)]">
            {/* 闪电 / 播放图标 */}
            <svg
              className="h-4 w-4 text-white"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true">
              <path d="M13 2L4.5 13.5H11L9.5 22 19.5 9.5H12.5L13 2z" />
            </svg>
          </span>
          <span className="flex flex-col leading-tight">
            <span className="text-sm font-bold text-foreground">
              {siteConfig.name}
            </span>
            <span className="text-[10px] text-muted">视频解析下载</span>
          </span>
        </Link>

        {/* Nav */}
        <nav className="flex items-center gap-1 text-xs text-secondary">
          <Link
            href="/"
            className="rounded-lg px-3 py-1.5 transition-colors hover:bg-glass-2 hover:text-primary">
            视频解析
          </Link>
          <Link
            href="/platform/douyin"
            className="rounded-lg px-3 py-1.5 transition-colors hover:bg-glass-2 hover:text-primary">
            平台列表
          </Link>
          <Link
            href="/faq"
            className="rounded-lg px-3 py-1.5 transition-colors hover:bg-glass-2 hover:text-primary">
            常见问题
          </Link>
          <ThemeToggle />
        </nav>
      </div>
    </header>
  );
}
