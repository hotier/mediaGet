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
 * 交互：
 * - 悬停/聚焦触发气泡预览，移开即消失；
 * - 气泡打开期间，直接在文字行上滚动滚轮即可阅读气泡内全文（滚轮改道给
 *   气泡滚动容器，指针移入气泡内则由原生滚动接管）。
 *
 * 说明：
 * - 检测依据 scrollWidth/scrollHeight 与 client 尺寸差，配合 ResizeObserver，
 *   窄屏截断 / 宽屏不截断时会自动切换。
 * - 支持渲染 span / p / div / h2 / h3 及链接 a（Tooltip 通过 asChild 合并
 *   进原元素，不额外包 DOM，不影响原截断与布局）。
 * - 链接形态保持原生点击（跳转）。
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
  // 气泡内可滚动文本容器（只在该容器被指针命中时，其原生滚动才是目标）
  const scrollRef = useRef<HTMLSpanElement | null>(null);
  // 气泡本体（TooltipContent）：接管其内边距/边缘上的滚轮
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [truncated, setTruncated] = useState(false);
  // 由 Radix 悬停自动开合驱动（onOpenChange(true/false) 镜像到此处）
  const [hovering, setHovering] = useState(false);
  const hoveringRef = useRef(false);

  const setRef = useCallback((node: HTMLElement | null) => {
    elRef.current = node;
  }, []);

  // 文本或尺寸变化后重新测量：truncate 横向溢出、line-clamp 纵向溢出，
  // 任一溢出即视为截断。
  // 注意：
  // - 用 useEffect 而非 useLayoutEffect：挂载初期（StrictMode 双挂载 / 字体布局未稳定）
  //   直接读取可能拿到无尺寸的旧节点，改为首帧后再测。
  // - measure 内始终读取 elRef.current，避免闭包引用已卸载节点导致永远测到 0。
  // - 横向不能用 scrollWidth 判断：它是取整值，会漏掉亚像素溢出（内容 93.4px 塞进
  //   93px 容器时浏览器已画省略号、scrollWidth 仍是 93），改用 Range 取文本真实
  //   宽度（亚像素精度），0.1px 容差滤掉浮点噪声
  useEffect(() => {
    let ro: ResizeObserver | null = null;
    const measure = () => {
      const el = elRef.current;
      if (!el) return;
      // 纵向（line-clamp）：scrollHeight 溢出是整行级别，+1px 容差避免取整误报
      let over = el.scrollHeight > el.clientHeight + 1;
      if (!over) {
        const range = document.createRange();
        range.selectNodeContents(el);
        // 用 Range 的边界矩形取文本真实宽度（亚像素精度）。注意取并集宽度而非
        // getClientRects 最后一项——nowrap 单行文本也会因字体回退被拆成多段矩形
        const textW = range.getBoundingClientRect().width;
        over = textW > el.clientWidth + 0.1;
      }
      setTruncated(over);
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

  // 不再截断（内容变短/容器变宽）时清掉悬停态，避免下次再截断时旧状态残留、
  // 气泡莫名自动弹出
  useEffect(() => {
    if (!truncated) {
      hoveringRef.current = false;
      setHovering(false);
    }
  }, [truncated, as]);

  // 把“在触发文字上滚动滚轮”改道给气泡：阅读超长文本时，用户通常停在文字行上
  // 直接滚动（悬停气泡打开期间），此时滚轮默认滚动的是页面/列表，气泡内文本
  // 纹丝不动，看起来就像“滑不到底部”。
  // 实现要点：监听器只在触发元素挂载且确实截断时挂一次（依赖 truncated），不再依赖
  // 气泡是否已挂载 —— 打开瞬间气泡内容往往还没渲染（hasSc=false），若此刻才挂监听
  // 器会永久错过；事件到来时再动态读 hoveringRef/scrollRef 判断是否接管：
  // 未打开/指针已在气泡内（target 在气泡内）/ 气泡在该方向已滚到头 时自然放行
  // （页面滚动、气泡随之自动收起的原逻辑不受影响）。
  useEffect(() => {
    if (!truncated) return;
    const el = elRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const sc = scrollRef.current;
      if (!sc) return; // 气泡尚未挂载：本次让原生行为处理
      if (!hoveringRef.current) return; // 气泡未打开
      const t = e.target;
      if (!(t instanceof Node) || sc.contains(t)) return; // 气泡内部由原生滚动处理
      const max = sc.scrollHeight - sc.clientHeight;
      if (max <= 1) return; // 气泡内无需滚动
      let delta = e.deltaY;
      if (e.deltaMode === 1) delta *= 16; // lines -> px
      else if (e.deltaMode === 2) delta *= window.innerHeight; // pages -> px
      if (delta === 0) return;
      if ((delta > 0 && sc.scrollTop >= max) || (delta < 0 && sc.scrollTop <= 0)) {
        // 已到头/到尾：气泡仍打开时不能交还页面滚动——放行会滚动页面、把触发行
        // 从指针下带走，pointerleave 随即关闭气泡，表现为「长简介快滚到底时气泡
        // 消失，看不到结尾」（触摸板惯性滚动下尤其明显）。气泡打开期间一律拦截，
        // 移开指针（气泡关闭）后页面滚动自然恢复。气泡无需滚动的场景（max<=1）
        // 已在上方提前放行，不影响正常页面滚动。
        e.preventDefault();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      sc.scrollTop = Math.max(0, Math.min(max, sc.scrollTop + delta));
    };
    el.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => el.removeEventListener("wheel", onWheel, { capture: true });
  }, [truncated]);

  // 气泡打开期间，接管气泡本体（内边距/边缘）上的滚轮并改道给文本滚动容器：
  // 气泡经 Portal 挂在 body 下、不是触发器的后代，触发行上的捕获监听器收不到
  // 气泡上的滚轮；若放行，页面滚动会把触发行从指针下带走 → 气泡提前关闭。
  // 文本容器（span）内部的滚轮由原生滚动接管，此处直接放行。
  useEffect(() => {
    if (!hovering) return;
    const content = contentRef.current;
    if (!content) return;
    const onWheel = (e: WheelEvent) => {
      const sc = scrollRef.current;
      if (!sc) return;
      const t = e.target;
      if (t instanceof Node && sc.contains(t)) return; // 文本容器内部：原生滚动
      let delta = e.deltaY;
      if (e.deltaMode === 1) delta *= 16;
      else if (e.deltaMode === 2) delta *= window.innerHeight;
      const max = sc.scrollHeight - sc.clientHeight;
      if (max <= 1) return;
      e.preventDefault();
      e.stopPropagation();
      sc.scrollTop = Math.max(0, Math.min(max, sc.scrollTop + delta));
    };
    content.addEventListener("wheel", onWheel, { passive: false });
    return () => content.removeEventListener("wheel", onWheel);
  }, [hovering]);

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
      <Tooltip
        open={hovering}
        onOpenChange={(next) => {
          hoveringRef.current = next;
          setHovering(next);
        }}>
        <TooltipTrigger asChild>{base}</TooltipTrigger>
        <TooltipContent ref={contentRef} side={side}>
          {/* 高度上限：min(45vh, 当前方向可用高度)。
              写死 45vh 时，若触发器贴近视口上/下缘，Radix 翻转后气泡仍可能超出可用空间，
              被挤出视口的那段内容（尤其底部）永远滚不到；改用 Radix 暴露的可用高度变量后，
              气泡保证完整落在视口内，能一路滚到底。overscroll-contain 防止在滚动区两端
              继续滚动时联动滚动背后的页面（也会连带触发 Radix 的关闭）。 */}
          <span
            ref={scrollRef}
            className="block max-w-full overflow-y-auto whitespace-pre-wrap break-words overscroll-contain"
            style={{
              maxHeight: "min(45vh, calc(var(--radix-tooltip-content-available-height, 100vh) - 16px))",
            }}>
            {text}
          </span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
