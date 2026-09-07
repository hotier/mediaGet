"use client";
import React, { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Check, ChevronDown, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import TruncatedText from "@/components/ui/truncated-text";

/**
 * 下载选项卡片的共享行组件与清晰度下拉。
 * B站 / YouTube / 微博 / 推特的「下载选项」行统一走这里，保证四端
 * 行布局（封面 + 标题 + 时长/清晰度徽标 + 档位下拉 + 下载按钮）与
 * 弹出层级一致：下拉菜单 absolute z-30，配合外层结果卡片不设
 * overflow-hidden，保证选项浮在卡片与后续内容之上、不被裁剪。
 */

/* ---------------- 清晰度下拉（自绘，风格与玻璃选择器一致） ---------------- */

interface QualitySelectProps {
  options: { label: string }[];
  value: number;
  onChange: (index: number) => void;
  ariaLabel: string;
}

/**
 * 档位下拉：原生 <select> 弹出的选项列表由浏览器绘制、无法跟随主题，
 * 这里改为「触发器 + 弹出菜单」自绘实现，菜单沿用选择器同一套玻璃样式
 * （rounded / border-glass-3 / bg-glass-1·2 / text-primary / text-accent）。
 */
export function QualitySelect({
  options,
  value,
  onChange,
  ariaLabel,
}: QualitySelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const active = options[Math.min(Math.max(value, 0), options.length - 1)];

  // 点击外部 / Escape 关闭菜单
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative flex-shrink-0">
      {/* 触发器：外观与原清晰度选择器一致 */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        className="flex h-8 w-max max-w-[13rem] items-center justify-between gap-1.5 rounded-lg border border-glass-3 bg-glass-1 px-2.5 text-xs text-primary transition-colors hover:border-glass-3/60 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/60">
        <span className="min-w-0 truncate">{active?.label}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 flex-shrink-0 text-muted transition-transform duration-200 ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {/* 弹出菜单：与选择器同款玻璃样式；z-30 浮于下载卡片内容之上 */}
      {open && (
        <ul
          role="listbox"
          aria-label={ariaLabel}
          className="absolute right-0 top-full z-30 mt-1.5 w-max min-w-full rounded-xl border border-glass-3 bg-glass-2 p-1 shadow-xl backdrop-blur-xl">
          {options.map((opt, i) => {
            const selected = i === value;
            return (
              <li
                key={`${i}-${opt.label}`}
                role="option"
                aria-selected={selected}
                tabIndex={0}
                onClick={() => {
                  onChange(i);
                  setOpen(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onChange(i);
                    setOpen(false);
                  }
                }}
                className={`flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-xs whitespace-nowrap transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 ${
                  selected
                    ? "bg-accent/15 font-medium text-accent"
                    : "text-primary hover:bg-glass-1"
                }`}>
                <span>{opt.label}</span>
                {selected && <Check className="h-3.5 w-3.5 flex-shrink-0" />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ---------------- 下载行（B站紧凑行布局，全平台统一） ---------------- */

interface DownloadRowProps {
  /** 行锚点 id（「下载视频」按钮滚动定位用），如 bilibili-download-0 */
  id?: string;
  /** 封面直链（可选；与 iconPlaceholder 二选一） */
  cover?: string;
  coverAlt?: string;
  /** 无封面时的占位内容（如 YouTube 分离音频行的音符图标） */
  iconPlaceholder?: React.ReactNode;
  /** 行标题全文（调用方拼好前缀，如 "P1: xxx" / "视频：xxx"） */
  title: string;
  /** 时长副信息（如 0:19 / 00:03:32） */
  durationText?: string;
  /** 单档位清晰度徽标；多档位时由下拉承载、不再展示，避免信息重复 */
  badge?: string;
  /** 单一直链（无档位列表的平台：YouTube / 微博 / 推特） */
  href?: string;
  /** 多档位直链（B站分P，>1 条时行内下拉切换档位） */
  qualities?: { url: string; label: string }[];
  /** 组装下载代理地址：单档位传 (href, badge)，多档位传所选 (url, label) */
  buildHref: (url: string, label?: string) => string;
  /** 平台渐变（不含 bg-gradient-to-r 前缀），如 from-[#00aeec] to-[#4dc9ff] */
  gradient: string;
}

/**
 * 单条下载行 —— 与 B站紧凑单行布局同款：
 * （封面 + 标题 + 时长/清晰度徽标 + 右侧档位下拉与下载按钮）。
 * 窄屏 flex-wrap 自动换行，档位下拉与下载按钮作为一组整体换行，
 * 选中档位后点「下载」走代理下载对应清晰度的文件。
 */
export default function DownloadRow({
  id,
  cover,
  coverAlt,
  iconPlaceholder,
  title,
  durationText,
  badge,
  href,
  qualities,
  buildHref,
  gradient,
}: DownloadRowProps) {
  // 可下载档位：>1 条时行内下拉切换；否则回退单直链 + 清晰度徽标
  const multiple = !!qualities && qualities.length > 1;
  const [qualityIndex, setQualityIndex] = useState(0);
  const activeQuality = multiple
    ? qualities![Math.min(qualityIndex, qualities!.length - 1)]
    : null;

  return (
    <div
      id={id}
      className="flex flex-wrap items-center gap-3 rounded-xl bg-glass-2 hover:bg-glass-3 transition-colors duration-200 px-4 py-3 scroll-mt-24">
      {cover ? (
        <Image
          src={cover}
          alt={coverAlt || title}
          width={120}
          height={75}
          className="w-[120px] h-[75px] rounded-lg object-cover flex-shrink-0 border border-glass-3"
          unoptimized
        />
      ) : (
        iconPlaceholder && (
          <div className="flex w-[120px] h-[75px] flex-shrink-0 items-center justify-center rounded-lg border border-glass-3 bg-glass-1">
            {iconPlaceholder}
          </div>
        )
      )}
      <div className="flex-1 min-w-0 basis-40">
        <TruncatedText
          as="p"
          text={title}
          className="text-sm font-medium text-primary truncate"
        />
        {(durationText || (badge && !multiple)) && (
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            {durationText && (
              <span className="text-xs text-muted">{durationText}</span>
            )}
            {badge && !multiple && (
              <span className="rounded-md bg-glass-2 px-1.5 py-0.5 text-[11px] text-accent">
                {badge}
              </span>
            )}
          </div>
        )}
      </div>
      {/* 档位下拉 + 下载按钮为一组，窄屏换行时保持相邻 */}
      <div className="flex-shrink-0 flex items-center gap-2">
        {multiple && (
          <QualitySelect
            options={qualities!}
            value={qualityIndex}
            onChange={setQualityIndex}
            ariaLabel={`${title} 清晰度`}
          />
        )}
        <Button
          asChild
          size="sm"
          className={`flex-shrink-0 bg-gradient-to-r ${gradient} hover:opacity-90`}>
          <a
            href={
              multiple
                ? buildHref(activeQuality!.url, activeQuality!.label)
                : buildHref(href!, badge)
            }
            target="_blank"
            rel="noopener noreferrer">
            <Download className="h-4 w-4" />
            下载
          </a>
        </Button>
      </div>
    </div>
  );
}
