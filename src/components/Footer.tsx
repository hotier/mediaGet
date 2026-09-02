import Link from "next/link";
import SystemInfoDialog from "./SystemInfoDialog";

export default function Footer() {
  return (
    <footer className="border-t border-border-subtle mt-auto">
      <div className="w-full px-4 sm:px-6 lg:px-8 py-6">
        <div className="flex flex-col items-center gap-2">
          {/* Legal Links */}
          <nav className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-muted">
            <SystemInfoDialog />
            <span className="text-muted opacity-50">·</span>
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
        </div>
      </div>
    </footer>
  );
}
