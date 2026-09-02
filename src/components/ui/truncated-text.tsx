"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * 截断文字 + 溢出预览 —— 站点统一入口。
 * 渲染一个带截断样式（truncate / line-clamp-N）的文本元素，运行时检测
 * 内容是否真的溢出；只有溢出时才用 Tooltip 包裹，悬浮/聚焦即展示完整
 * 原文气泡（未截断则原样输出，避免多余提示）。
 *
 * 说明：
 * - 检测依据 scrollWidth/scrollHeight 与 client 尺寸差，配合 ResizeObserver，
 *   窄屏截断 / 宽屏不截断时会自动切换。
 * - 支持渲染 span / p / div / h2 / h3 及链接 a（Tooltip 通过 asChild 合并
 *   进原元素，不额外包 DOM，不影响原截断与布局）。
 */
type TruncatedTextElement = "span" | "p" | "div" | "h2" | "h3" | "dd" | "a";

interface TruncatedTextProps {
  /** 完整文本（预览气泡展示的也是这段原文） */
  text: string;
  /** 截断样式：单行用 truncate；多行用 line-clamp-N（布局类如 min-w-0 需一并传入） */
  className?: string;
  /** 渲染标签，默认 span */
  as?: TruncatedTextElement;
  /** as="a" 时的跳转地址 */
  href?: string;
  target?: string;
  rel?: string;
  onClick?: React.MouseEventHandler<HTMLElement>;
  /** 气泡方向，默认 top（上方空间不足时 Radix 会自动翻转避让） */
  side?: "top" | "bottom" | "left" | "right";
  /** 气泡出现延迟 ms，默认 200（避免快速划过误弹） */
  delay?: number;
}

export default function TruncatedText({
  text,
  className,
  as = "span",
  href,
  target,
  rel,
  onClick,
  side = "top",
  delay = 200,
}: TruncatedTextProps) {
  const elRef = useRef<HTMLElement | null>(null);
  const [truncated, setTruncated] = useState(false);

  const setRef = useCallback((node: HTMLElement | null) => {
    elRef.current = node;
  }, []);

  // 文本或尺寸变化后重新测量：truncate 横向溢出、line-clamp 纵向溢出，
  // 任一溢出即视为截断（+1px 容差避免取整误差误报）。
  // 注意：
  // - 用 useEffect 而非 useLayoutEffect：挂载初期（StrictMode 双挂载 / 字体布局未稳定）
  //   直接读取可能拿到无尺寸的旧节点，改为首帧后再测。
  // - measure 内始终读取 elRef.current，避免闭包引用已卸载节点导致永远测到 0。
  useEffect(() => {
    let ro: ResizeObserver | null = null;
    const measure = () => {
      const el = elRef.current;
      if (!el) return;
      setTruncated(
        el.scrollWidth > el.clientWidth + 1 ||
          el.scrollHeight > el.clientHeight + 1
      );
    };
    const raf = requestAnimationFrame(() => {
      const el = elRef.current;
      if (!el) return;
      ro = new ResizeObserver(measure);
      ro.observe(el);
      measure();
    });
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [text]);

  const cls = cn(className);
  let base: React.ReactNode;
  if (as === "a") {
    base = (
      <a ref={setRef} className={cls} href={href} target={target} rel={rel} onClick={onClick}>
        {text}
      </a>
    );
  } else if (as === "p") {
    base = (
      <p ref={setRef} className={cls} onClick={onClick}>
        {text}
      </p>
    );
  } else if (as === "h2") {
    base = (
      <h2 ref={setRef} className={cls} onClick={onClick}>
        {text}
      </h2>
    );
  } else if (as === "h3") {
    base = (
      <h3 ref={setRef} className={cls} onClick={onClick}>
        {text}
      </h3>
    );
  } else if (as === "div") {
    base = (
      <div ref={setRef} className={cls} onClick={onClick}>
        {text}
      </div>
    );
  } else if (as === "dd") {
    base = (
      <dd ref={setRef} className={cls} onClick={onClick}>
        {text}
      </dd>
    );
  } else {
    base = (
      <span ref={setRef} className={cls} onClick={onClick}>
        {text}
      </span>
    );
  }

  // 未截断（或暂无法测量）时无需提示
  if (!truncated) return base;

  return (
    <TooltipProvider delayDuration={delay}>
      <Tooltip>
        <TooltipTrigger asChild>{base}</TooltipTrigger>
        <TooltipContent side={side}>
          <span className="block max-h-[45vh] max-w-full overflow-y-auto whitespace-pre-wrap break-words">
            {text}
          </span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
