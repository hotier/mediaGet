import Link from "next/link";
import { siteConfig } from "@/config/site";

export default function Footer() {
  return (
    <footer className="border-t border-border-subtle mt-auto">
      <div className="w-full px-4 sm:px-6 lg:px-8 py-6">
        <div className="flex flex-col items-center gap-2">
          {/* Brand Mark */}
          <div className="mb-1 flex items-center gap-1.5 text-xs text-muted">
            <span className="grid h-4 w-4 place-items-center rounded-md bg-[var(--accent)]">
              <svg
                className="h-2.5 w-2.5 text-white"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true">
                <path d="M13 2L4.5 13.5H11L9.5 22 19.5 9.5H12.5L13 2z" />
              </svg>
            </span>
            <span>{siteConfig.name}</span>
          </div>

          {/* Legal Links */}
          <nav className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-muted">
            <Link
              href="/legal/terms"
              className="hover:text-primary transition-colors duration-200">
              用户协议
            </Link>
            <span className="text-muted opacity-50">·</span>
            <Link
              href="/legal/privacy"
              className="hover:text-primary transition-colors duration-200">
              隐私政策
            </Link>
            <span className="text-muted opacity-50">·</span>
            <Link
              href="/legal/dmca"
              className="hover:text-primary transition-colors duration-200">
              权利通知
            </Link>
          </nav>

          {/* Copyright */}
          <p className="text-center text-xs text-muted">
            &copy; {new Date().getFullYear()} {siteConfig.name} · {siteConfig.domain}
          </p>
        </div>
      </div>
    </footer>
  );
}
