"use client";

/**
 * 图集「多选下载」共享实现（小红书/微博/B站图文/抖音/快手/X 图集通用）：
 * - useGallerySelection：选择状态 hook（进入选择模式 → 逐张勾选 → 退出清空）
 * - SelectableImageLink：网格图片外壳（默认点击打开原图；选择模式点击切换勾选 + 右上角勾选指示）
 * - GalleryDownloadBar：图集底部操作条（默认「多选 + 一键下载全部」；
 *   选择模式按钮切换为「取消多选 + 下载选中图片（实时计数）」）
 *
 * 各平台组件保留自己的网格列数、图片比例与主题渐变，仅把图片 <a> 与底部按钮区换成这里的组件。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Check, Download, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { downloadAllImages } from "@/utils/downloadImages";

/* ---------------- 多选状态 hook ---------------- */

export interface GallerySelection {
  /** 是否处于选择模式 */
  selecting: boolean;
  /** 已选图片的原图下标（升序）；下载时按此序号命名文件名 */
  selected: number[];
  isSelected: (index: number) => boolean;
  toggle: (index: number) => void;
  enter: () => void;
  exit: () => void;
}

/** 图集多选状态：进入选择模式 → 勾选若干张 → 取消/下载完成后退出并清空 */
export function useGallerySelection(count: number): GallerySelection {
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);

  // 图集张数变化（同一卡片切换了不同解析结果）时清掉越界下标，避免陈旧的 index 越界
  useEffect(() => {
    setSelected((prev) => prev.filter((i) => i < count));
  }, [count]);

  const isSelected = useCallback(
    (i: number) => selected.includes(i),
    [selected]
  );
  const toggle = useCallback((i: number) => {
    setSelected((prev) =>
      prev.includes(i)
        ? prev.filter((x) => x !== i)
        : [...prev, i].sort((a, b) => a - b)
    );
  }, []);

  return {
    selecting,
    selected,
    isSelected,
    toggle,
    enter: () => setSelecting(true),
    exit: () => {
      setSelecting(false);
      setSelected([]);
    },
  };
}

/* ---------------- 可勾选图片链接 ---------------- */

interface SelectableImageLinkProps {
  href: string;
  className?: string;
  /** 平台主色 hex，用于选中项勾选指示的底色 */
  accent: string;
  selecting: boolean;
  selected: boolean;
  onToggle: () => void;
  children: ReactNode;
}

/**
 * 网格图片外壳：普通点击在新窗口打开原图；
 * 选择模式下点击切换勾选（阻止跳转），右上角显示勾选指示标识选中状态。
 * 用法与原来的 <a> 相同，把 <Image> 等内容作为 children 传入。
 */
export function SelectableImageLink({
  href,
  className,
  accent,
  selecting,
  selected,
  onToggle,
  children,
}: SelectableImageLinkProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      // 选择模式下元素语义变为「切换按钮」，覆盖隐式 link 角色以合法承载 aria-pressed；
      // 普通浏览模式保持链接语义（无 role/aria-pressed，新窗口打开原图）
      role={selecting ? "button" : undefined}
      aria-pressed={selecting ? selected || undefined : undefined}
      title={
        selecting ? (selected ? "取消选择此图" : "选择此图") : undefined
      }
      onClick={(e) => {
        if (!selecting) return;
        e.preventDefault();
        onToggle();
      }}
      className={className}>
      {children}
      {selecting && (
        <span
          aria-hidden
          className="pointer-events-none absolute right-1.5 top-1.5 z-10 flex h-6 w-6 items-center justify-center rounded-full border-2 border-white/90 text-white shadow-sm transition-colors"
          style={{
            backgroundColor: selected ? accent : "rgba(15, 23, 42, 0.55)",
          }}>
          {selected && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
        </span>
      )}
    </a>
  );
}

/* ---------------- 图集底部下载操作条 ---------------- */

interface GalleryDownloadBarProps {
  /** 下载用 URL 列表（B 站传代理 URL；其余平台传直链，downloadImage 内部自动回退 /api/image） */
  urls: string[];
  /** 下载文件名前缀，如 `xhs-作者` */
  baseName: string;
  /** 主按钮渐变/样式类，如 `bg-gradient-to-r from-[#00aeec] to-[#4dc9ff] hover:opacity-90` */
  gradient: string;
  selection: GallerySelection;
}

/**
 * 图集底部操作区（单行双按钮，原位切换）：
 * - 主下载按钮在左、占整体 5/6：多图默认「一键下载全部图片 (N 张)」，单图（total === 1）
 *   仅显示「下载图片」；选择态实时显示「下载选中图片 (M 张)」，M 随勾选更新，
 *   0 张禁用；下载完成自动退出多选。
 * - 多选切换按钮在右、占整体 1/6：默认显示「多选」文字，点击后图片进入多选状态；
 *   选择态原位变为「取消多选」文字 + 图标 (X)，点击退出并清空勾选。
 * - 单图（total === 1）时不渲染多选按钮。
 * 下载文件名沿用图集原序号（如 xhs-作者-3）。
 */
export function GalleryDownloadBar({
  urls,
  baseName,
  gradient,
  selection,
}: GalleryDownloadBarProps) {
  const [downloading, setDownloading] = useState(false);
  const { selecting, selected } = selection;
  const total = urls.length;

  const handleDownloadAll = async () => {
    if (downloading || total === 0) return;
    setDownloading(true);
    try {
      await downloadAllImages(urls, baseName);
    } finally {
      setDownloading(false);
    }
  };

  const handleDownloadSelected = async () => {
    if (downloading || selected.length === 0) return;
    setDownloading(true);
    try {
      await downloadAllImages(
        selected.map((i) => urls[i]),
        baseName,
        selected
      );
    } finally {
      setDownloading(false);
      // 下载完成自动退出多选（exit 会同时清空已选），回到默认双按钮
      selection.exit();
    }
  };

  // 主下载按钮在左（5/6），多选切换按钮在右（1/6）：
  // 默认态 =「一键下载全部 + 多选」；点击多选后原位切换为
  // 「下载选中图片（实时显示已选张数）+ 取消多选」
  return (
    <div className="mt-3 flex items-stretch gap-2">
      <Button
        type="button"
        size="lg"
        onClick={selecting ? handleDownloadSelected : handleDownloadAll}
        disabled={downloading || (selecting && selected.length === 0)}
        className={`flex-[5] ${gradient}`}>
        {downloading ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            正在下载...
          </>
        ) : selecting ? (
          <>
            <Download className="h-4 w-4" />
            下载选中图片（{selected.length} 张）
          </>
        ) : total === 1 ? (
          <>
            <Download className="h-4 w-4" />
            下载图片
          </>
        ) : (
          <>
            <Download className="h-4 w-4" />
            一键下载全部图片（{total} 张）
          </>
        )}
      </Button>
      {total > 1 && (
        <Button
          type="button"
          size="lg"
          variant="outline"
          onClick={selecting ? selection.exit : selection.enter}
          disabled={downloading}
          aria-label={selecting ? "取消多选" : "多选"}
          title={selecting ? "取消多选" : "多选"}
          className="flex-1 whitespace-nowrap px-0">
          {selecting ? (
            <>
              <X className="h-5 w-5" />
              取消多选
            </>
          ) : (
            "多选"
          )}
        </Button>
      )}
    </div>
  );
}
