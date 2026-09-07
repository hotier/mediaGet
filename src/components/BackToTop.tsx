"use client";

import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/** 页面滚动超过该距离后显示按钮（px） */
const SHOW_AFTER = 480;

/**
 * 全局「回到顶部」悬浮按钮：
 * - 外层为占位高度 0 的 sticky 容器，位于 main 与 Footer 之间（文档流）：
 *   滚动全程悬浮在视口右下角（含移动端安全区），滚到底部后自然停在
 *   页脚线上方（mb-3 留出间距），不会遮挡页脚内容
 * - 按钮外圈为 conic-gradient 滚动进度环：随滚动进度由灰渐变填充强调色
 * - 点击平滑回到顶部；系统开启「减少动态效果」时直接跳转
 * - 无障碍：带 aria-label，未显示时不进入 Tab 焦点
 */
export default function BackToTop() {
  const [visible, setVisible] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1

  useEffect(() => {
    let raf = 0;

    const update = () => {
      raf = 0;
      const doc = document.documentElement;
      const maxScroll = doc.scrollHeight - window.innerHeight;
      const y = window.scrollY || doc.scrollTop;
      setVisible(y > SHOW_AFTER);
      setProgress(maxScroll > 0 ? Math.min(1, Math.max(0, y / maxScroll)) : 0);
    };

    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  const scrollToTop = useCallback(() => {
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  }, []);

  const deg = Math.round(progress * 360);

  return (
    <div
      className="pointer-events-none sticky bottom-[max(0px,env(safe-area-inset-bottom))] z-40 flex h-0 items-end justify-end pb-4 pr-4"
    >
      <button
        type="button"
        onClick={scrollToTop}
        aria-label="回到顶部"
        tabIndex={visible ? 0 : -1}
        aria-hidden={!visible}
        className={cn(
          "group pointer-events-auto rounded-full p-[3px] transition-all duration-300 ease-out",
          "shadow-card hover:shadow-glow",
          "focus-visible:outline-offset-2",
          visible
            ? "translate-y-0 opacity-100"
            : "translate-y-3 opacity-0"
        )}
        style={{
          background: `conic-gradient(var(--accent) ${deg}deg, var(--border-subtle) ${deg}deg)`,
        }}
      >
        <span className="grid h-11 w-11 place-items-center rounded-full bg-glass-2 text-primary backdrop-blur-xl transition-colors duration-200 group-hover:bg-accent group-hover:text-white sm:h-12 sm:w-12">
          <svg
            className="h-5 w-5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true">
            <path d="M12 19V5" />
            <path d="m5 12 7-7 7 7" />
          </svg>
        </span>
      </button>
    </div>
  );
}
