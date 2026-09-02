"use client";
import React, { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { ApiResponse, ParsedVideoItem } from "@/types/api";
import { sanitizeFilename } from "@/utils/filename";
import VideoPosterCard from "./VideoPosterCard";
import ParseInfoPanel from "./ParseInfoPanel";
import CaptionBox from "./CaptionBox";
import CollapsibleGallery from "./CollapsibleGallery";
import {
  GalleryDownloadBar,
  SelectableImageLink,
  useGallerySelection,
} from "./GalleryMultiSelect";
import { Check, ChevronDown, Download } from "lucide-react";
import PlatformIcon from "@/components/PlatformIcon";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import TruncatedText from "@/components/ui/truncated-text";

/**
 * 站内图片代理（图集展示专用）：hdslb 图床有 Referer 防盗链 —— 实测浏览器带本站
 * Referer 直链加载 i*.hdslb.com 会被 403（text/html 防盗链页），而服务端无 Referer
 * fetch 返回 200。因此图文图集在展示/下载时统一包成 /api/image 代理（同源返回），
 * 原理与后端对头像/封面/小红书/微博图片的处理一致；API 的 data.images 仍保持原图
 * 直链（契约与 fmt=text 直链输出不受影响）。已代理路径幂等返回。
 */
function proxifyImageUrl(url?: string): string {
  if (!url) return "";
  if (url.startsWith("/api/image")) return url;
  return `/api/image?url=${encodeURIComponent(url)}`;
}

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
function QualitySelect({
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

      {/* 弹出菜单：与选择器同款玻璃样式 */}
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

/* ---------------- 下载行（对齐微博紧凑布局） ---------------- */

interface DownloadRowProps {
  item: ParsedVideoItem;
  index: number;
  fallbackTitle: string;
  buildName: (item: ParsedVideoItem, index: number, label?: string) => string;
}

/**
 * 单个分P的下载行 —— 与微博下载卡同款紧凑单行布局
 * （封面 + P序号标题 + 时长 + 右侧下载按钮）；
 * 与微博的差异：B站每P可能提供多个清晰度直链，右侧用下拉切换档位，
 * 选中档位后点「下载」即走代理下载对应清晰度的文件。
 */
function DownloadRow({
  item,
  index,
  fallbackTitle,
  buildName,
}: DownloadRowProps) {
  // 可下载档位：有清晰度列表按档位列出，否则回退为默认直链单条
  const rows =
    Array.isArray(item.qualities) && item.qualities.length > 0
      ? item.qualities.map((q) => ({ url: q.url, label: q.label }))
      : [{ url: item.url, label: item.accept?.[0] || "默认" }];
  // 默认选第一档（后端 accept_quality 从高到低，即最高清晰度）
  const [qualityIndex, setQualityIndex] = useState(0);
  const active = rows[Math.min(qualityIndex, rows.length - 1)];
  const multiple = rows.length > 1;

  return (
    <div
      id={`bilibili-download-${index}`}
      className="flex flex-wrap items-center gap-3 rounded-xl bg-glass-2 hover:bg-glass-3 transition-colors duration-200 px-4 py-3 scroll-mt-24">
      {item.cover && (
        <Image
          src={item.cover}
          alt={item.title || fallbackTitle}
          width={120}
          height={75}
          className="w-[120px] h-[75px] rounded-lg object-cover flex-shrink-0 border border-glass-3"
          unoptimized
        />
      )}
      <div className="flex-1 min-w-0 basis-40">
        <TruncatedText
          as="p"
          text={`P${index + 1}: ${item.title || fallbackTitle}`}
          className="text-sm font-medium text-primary truncate"
        />
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
          {item.durationFormat && (
            <span className="text-xs text-muted">{item.durationFormat}</span>
          )}
          {/* 仅单档位时展示清晰度徽标（多档位已由下拉承载，避免信息重复） */}
          {!multiple && item.accept?.[0] && (
            <span className="rounded-md bg-glass-2 px-1.5 py-0.5 text-[11px] text-accent">
              {item.accept[0]}
            </span>
          )}
        </div>
      </div>
      <div className="flex-shrink-0 flex items-center gap-2">
        {multiple && (
          <QualitySelect
            options={rows}
            value={qualityIndex}
            onChange={setQualityIndex}
            ariaLabel={`${item.title || fallbackTitle} 清晰度`}
          />
        )}
        <Button
          asChild
          size="sm"
          className="flex-shrink-0 bg-gradient-to-r from-[#00aeec] to-[#4dc9ff] hover:opacity-90">
          <a
            href={`/api/video-proxy?url=${encodeURIComponent(
              active.url
            )}&download=1&filename=${encodeURIComponent(
              buildName(item, index, active.label)
            )}`}
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

interface BilibiliVideoProps {
  data: ApiResponse;
}

export default function BilibiliVideo({ data }: BilibiliVideoProps) {
  // 图文图集加载状态（图片分支专用）
  const [imageLoading, setImageLoading] = useState(true);

  const parsed = data.data;
  const videoItems = parsed?.videos || [];
  const hasVideo = videoItems.length > 0;
  // 直链 host 已在后端归一化为国内节点（upos-sz-mirrorbd.bilivideo.com），
  // 可内嵌当前页 <video> 播放
  const primaryVideoUrl = hasVideo ? videoItems[0].url : "";
  const posterUrl = parsed?.cover || undefined;
  // 图文动态（/opus/）归一化后 type="image" + images[]，走图集卡片分支
  const isImage =
    parsed?.type === "image" && (parsed?.images?.length ?? 0) > 0;
  const images = (parsed?.images?.filter(Boolean) as string[]) || [];
  // 图集展示/下载走站内代理（hdslb 防盗链：浏览器直链加载 403），images 直链契约不变
  const displayImages = images.map(proxifyImageUrl);
  // 图集多选状态（图文动态 N 张图；张数随解析结果变化时自动清理越界勾选）
  const gallerySel = useGallerySelection(images.length);

  /** 下载文件名：bilibili-UP主-P分P-标题-清晰度.mp4 */
  const buildDownloadName = (
    item: ParsedVideoItem,
    index: number,
    label?: string
  ): string => {
    const qs = item.qualities;
    const qualityLabel =
      label ?? (qs?.length ? (qs[0]?.label ?? "") : "");
    const labelPart = qualityLabel ? `-${qualityLabel.replace(/\s+/g, "")}` : "";
    const titlePart = sanitizeFilename(item.title || `P${index + 1}`, 40);
    return `bilibili-${sanitizeFilename(
      parsed?.author || "up",
      20
    )}-P${index + 1}-${titlePart}${labelPart}.mp4`;
  };

  // 数字缩写：>1万 → x.x万 / xx万，其余千分位
  const formatCount = (n: number) =>
    n >= 10000
      ? `${(n / 10000).toFixed(n >= 1000000 ? 0 : 1)}万`
      : n.toLocaleString("zh-CN");

  // UP主主页公开信息徽标：关注 / 粉丝 / 获赞（缺失自动隐藏）
  const upBadges: { label: string; value?: number }[] = [
    { label: "关注", value: parsed?.followingCount },
    { label: "粉丝", value: parsed?.followerCount },
    { label: "获赞", value: parsed?.totalFavorited },
  ];

  // 播放器下方「下载视频」按钮：滚动定位到下方下载卡中当前分P对应的下载行
  // （多分P时跟随正在播放的分P；找不到目标行时回退到下载卡顶部）
  const scrollToDownload = (index: number) => {
    const target = document.getElementById(`bilibili-download-${index}`);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      document
        .getElementById("bilibili-download")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  return (
    <div className="space-y-5" style={{ touchAction: 'pan-y' }}>
      {/* UP主信息卡：头像 + 昵称(可点击主页) + UID + 简介 + 关注/粉丝/获赞（主页公开信息，缺失自动隐藏） */}
      {(parsed?.avatar || parsed?.author) && (
        <Card className="p-5">
          <div className="flex items-center gap-4">
            {parsed?.avatar && (
              <div className="relative flex-shrink-0">
                <div className="absolute inset-0 rounded-full bg-gradient-to-br from-[#00aeec] to-[#4dc9ff] blur-sm opacity-50" />
                <Image
                  src={parsed.avatar}
                  alt={parsed.author || ""}
                  width={56}
                  height={56}
                  className="relative rounded-full border-2 border-glass-3"
                  unoptimized
                />
              </div>
            )}
            <div className="flex-1 min-w-0">
              {parsed?.author && (
                <div className="flex items-center gap-2">
                  <span className="text-[13px] text-secondary">UP主</span>
                  {parsed.authorUrl ? (
                    <TruncatedText
                      as="a"
                      text={parsed.author}
                      href={parsed.authorUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[13px] font-medium text-accent truncate hover:underline hover:text-accent/80 transition-colors"
                    />
                  ) : (
                    <TruncatedText
                      text={parsed.author}
                      className="text-[13px] font-medium text-accent truncate"
                    />
                  )}
                </div>
              )}
              {parsed?.authorId && (
                <TruncatedText
                  as="p"
                  text={`UID：${parsed.authorId}`}
                  className="mt-0.5 text-[13px] text-muted truncate"
                />
              )}
              {parsed?.sign && (
                <p className="mt-0.5 flex items-start gap-1 text-[13px] text-muted">
                  <span className="flex-shrink-0">简介：</span>
                  <TruncatedText
                    text={parsed.sign}
                    className="min-w-0 line-clamp-2"
                  />
                </p>
              )}
              {/* 关注 / 粉丝 / 获赞（纯文本，左边缘与上方文字严格对齐） */}
              <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-[13px]">
                {upBadges.map(
                  (badge) =>
                    badge.value != null &&
                    Number(badge.value) > 0 && (
                      <span
                        key={badge.label}
                        className="inline-flex items-center gap-1">
                        <span className="text-muted">{badge.label}</span>
                        <span className="font-semibold text-primary">
                          {formatCount(Number(badge.value))}
                        </span>
                      </span>
                    )
                )}
              </div>
            </div>

            {/* Bilibili Logo */}
            <div className="flex-shrink-0">
              <PlatformIcon platform="bilibili" size={40} rounded="rounded-xl" />
            </div>
          </div>
        </Card>
      )}

      {/* Video：封面 + 播放 + 「下载视频」按钮（点击滚动定位到下方下载选项卡片）。
          多分P 下载由下方「下载选项」列表提供；直链已归一化为国内节点可直接播放，内嵌当前页播放 */}
      {hasVideo && primaryVideoUrl && (
        <VideoPosterCard
          url={primaryVideoUrl}
          cover={posterUrl}
          alt={parsed?.title || "视频封面"}
          accent="blue"
          inline
          parts={videoItems.length > 1 ? videoItems : undefined}
          downloadText="下载视频"
          onDownloadClick={scrollToDownload}
        />
      )}

      {/* 图文图集：单图大图（B站蓝主题）/ 多图网格（2/3/4 张自适应），点击打开原图，
          与小红书图集卡片交互一致；封面 alt 文案与图片命名同用动态标题 */}
      {isImage && images.length > 0 && (
        <Card className="p-3">
          {images.length === 1 ? (
            <a
              href={displayImages[0]}
              target="_blank"
              rel="noopener noreferrer"
              className="relative block aspect-square rounded-xl overflow-hidden bg-black">
              {imageLoading && (
                <div className="absolute inset-0 bg-glass-2 animate-pulse" />
              )}
              <Image
                src={displayImages[0]}
                alt={parsed?.title || "图片"}
                fill
                sizes="(max-width: 800px) 100vw, 800px"
                className="object-cover"
                priority
                unoptimized
                onLoad={() => setImageLoading(false)}
                onError={() => setImageLoading(false)}
              />
            </a>
          ) : (
            <CollapsibleGallery>
              <div
                className={`grid gap-2 ${
                  images.length === 2
                    ? "grid-cols-2"
                    : images.length === 3
                      ? "grid-cols-3"
                      : images.length === 4
                        ? "grid-cols-2"
                        : "grid-cols-3"
                }`}>
                {displayImages.map((imageUrl, index) => (
                  <SelectableImageLink
                    key={index}
                    href={imageUrl}
                    accent="#00aeec"
                    selecting={gallerySel.selecting}
                    selected={gallerySel.isSelected(index)}
                    onToggle={() => gallerySel.toggle(index)}
                    className={`relative aspect-square rounded-xl overflow-hidden group block bg-black ${
                      images.length === 4 && index >= 2 ? "col-span-1" : ""
                    }`}>
                    <Image
                      src={imageUrl}
                      alt={`${parsed?.title || "图片"} ${index + 1}`}
                      fill
                      sizes="(max-width: 800px) 50vw, 400px"
                      className="object-cover transition-transform duration-500 group-hover:scale-105"
                      unoptimized
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                  </SelectableImageLink>
                ))}
              </div>
            </CollapsibleGallery>
          )}

          {/* 图集下载：选图多选下载 / 一键下载全部（多选文件名保留原图序） */}
          <GalleryDownloadBar
            urls={displayImages}
            baseName={`bilibili-${parsed?.author || "图文动态"}`}
            gradient="bg-gradient-to-r from-[#00aeec] to-[#4dc9ff] hover:opacity-90"
            selection={gallerySel}
          />
        </Card>
      )}

      {/* 文案：视频简介 / 图文动态文案，可一键复制 */}
      {parsed?.desc && (
        <CaptionBox text={parsed.desc} title={isImage ? "动态文案" : "视频简介"} />
      )}

      {/* 信息面板：视频信息 / 图文信息（图文用专用字段集避免「视频标题/视频」错标） */}
      <ParseInfoPanel
        platform={isImage ? "bilibiliOpus" : "bilibili"}
        data={parsed}
        title={isImage ? "图文信息" : "视频信息"}
      />

      {/* Download Options：微博同款紧凑布局 —— 每个分P一行（封面 / P序号标题 / 时长），
          多清晰度时行内下拉切换档位，点「下载」走视频代理 + Content-Disposition 强制保存文件 */}
      {hasVideo && (
        <Card id="bilibili-download" className="p-5 scroll-mt-24">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-primary flex items-center gap-2">
              <svg
                className="w-4 h-4 text-accent"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth={2}>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                />
              </svg>
              下载选项 ({videoItems.length})
            </h3>
          </div>

          <div className="space-y-3">
            {videoItems.map((item, index) => (
              <DownloadRow
                key={index}
                item={item}
                index={index}
                fallbackTitle={parsed?.title || "视频"}
                buildName={buildDownloadName}
              />
            ))}
          </div>
        </Card>
      )}

    </div>
  );
}
