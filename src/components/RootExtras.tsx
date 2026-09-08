"use client";

import { usePathname } from "next/navigation";
import BackToTop from "./BackToTop";
import Footer from "./Footer";

/**
 * 布局尾部（回到顶部 + 页脚）。
 * 沉浸式页面（如 /music 播放器）中隐藏，避免多出滚动空间。
 */
export default function RootExtras() {
  const pathname = usePathname();
  if (pathname === "/music") return null;
  return (
    <>
      <BackToTop />
      <Footer />
    </>
  );
}
