"use client";
import React, { useState } from "react";
import Image from "next/image";
import { ApiResponse, ParseData } from "@/types/api";
import VideoPosterCard from "./VideoPosterCard";
import ParseInfoPanel from "./ParseInfoPanel";
import CaptionBox from "./CaptionBox";
import CollapsibleGallery from "./CollapsibleGallery";
import {
  GalleryDownloadBar,
  SelectableImageLink,
  useGallerySelection,
} from "./GalleryMultiSelect";
import PlatformIcon from "@/components/PlatformIcon";
import { Card } from "@/components/ui/card";
import TruncatedText from "@/components/ui/truncated-text";

interface XhsVideoProps {
  data: ApiResponse;
}

export default function XhsVideo({ data }: XhsVideoProps) {
  const [imageLoading, setImageLoading] = useState(true);
  // 图集多选状态（图文笔记 N 张图；张数随解析结果变化时自动清理越界勾选）
  const gallerySel = useGallerySelection(
    (data.data as ParseData | undefined)?.images?.filter(Boolean).length ?? 0
  );

  if (!data.data) {
    return null;
  }

  const xhsData = data.data as ParseData;

  const isImageType = xhsData.type === "image";
  const images = xhsData.images?.filter(Boolean) || [];

  // 数字缩写：>1万 → x.x万 / xx万，其余千分位
  const formatCount = (n: number) =>
    n >= 10000
      ? `${(n / 10000).toFixed(n >= 1000000 ? 0 : 1)}万`
      : n.toLocaleString("zh-CN");

  // 博主主页公开信息徽标：关注 / 粉丝 / 获赞与收藏（小红书主页口径，缺失自动隐藏）
  const authorBadges: { label: string; value?: number }[] = [
    { label: "关注", value: xhsData.followingCount },
    { label: "粉丝", value: xhsData.followerCount },
    { label: "获赞与收藏", value: xhsData.totalFavorited },
  ];

  return (
    <div className="space-y-5" style={{ touchAction: 'pan-y' }}>
      {/* 博主信息卡：头像 + 昵称(可点击主页) + 小红书号 + 简介 + 关注/粉丝/获赞（主页公开信息，缺失自动隐藏） */}
      {(xhsData.avatar || xhsData.author) && (
        <Card className="p-5">
          <div className="flex items-center gap-4">
            {xhsData.avatar && (
              <div className="relative flex-shrink-0">
                <div className="absolute inset-0 rounded-full bg-gradient-to-br from-[#ff2442] to-[#ff5c7c] blur-sm opacity-50" />
                <Image
                  src={xhsData.avatar}
                  alt={xhsData.author || ""}
                  width={56}
                  height={56}
                  className="relative rounded-full border-2 border-glass-3"
                  unoptimized
                />
              </div>
            )}
            <div className="flex-1 min-w-0">
              {xhsData.author && (
                <div className="flex items-center gap-2">
                  <span className="text-[13px] text-secondary">作者</span>
                  {xhsData.authorUrl ? (
                    <TruncatedText
                      as="a"
                      text={xhsData.author}
                      href={xhsData.authorUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[13px] font-medium text-accent truncate hover:underline hover:text-accent/80 transition-colors"
                    />
                  ) : (
                    <TruncatedText
                      text={xhsData.author}
                      className="text-[13px] font-medium text-accent truncate"
                    />
                  )}
                </div>
              )}
              {xhsData.authorId && (
                <TruncatedText
                  as="p"
                  text={`小红书号：${xhsData.authorId}`}
                  className="mt-0.5 text-[13px] text-muted truncate"
                />
              )}
              {xhsData.sign && (
                <p className="mt-0.5 flex items-start gap-1 text-[13px] text-muted">
                  <span className="flex-shrink-0">简介：</span>
                  <TruncatedText
                    text={xhsData.sign}
                    className="min-w-0 line-clamp-2"
                  />
                </p>
              )}
              {/* 关注 / 粉丝 / 获赞（纯文本，左边缘与上方文字严格对齐）。
                  未获取到博主信息或为脱敏估算值时整段过滤，避免展示误导性数字 */}
              {!xhsData.statsUnreliable && (
                <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-[13px]">
                  {authorBadges.map(
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
              )}
            </div>
            <div className="flex-shrink-0">
              <PlatformIcon platform="xhs" size={40} rounded="rounded-xl" />
            </div>
          </div>
        </Card>
      )}

      {/* Video：封面 + 播放/下载（小红书已走代理，内嵌当前页面播放/下载，体验更好） */}
      {!isImageType && xhsData.url && (
        <VideoPosterCard
          url={xhsData.url}
          cover={xhsData.cover}
          alt={xhsData.title || "视频封面"}
          accent="pink"
          tall
          inline
        />
      )}

      {/* Image Gallery：单图大图展示，多图网格（2/3/4 张自适应列数），点击打开原图 */}
      {isImageType && images.length > 0 && (
        <Card className="p-3">
          {images.length === 1 ? (
            <a
              href={images[0]}
              target="_blank"
              rel="noopener noreferrer"
              className="relative block aspect-square rounded-xl overflow-hidden bg-transparent">
              {imageLoading && (
                <div className="absolute inset-0 bg-glass-2 animate-pulse" />
              )}
              <Image
                src={images[0]}
                alt={xhsData.title || "图片"}
                fill
                sizes="(max-width: 800px) 100vw, 800px"
                className="object-cover"
                priority
                unoptimized
                onLoad={() => setImageLoading(false)}
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
                {images.map((imageUrl, index) => (
                  <SelectableImageLink
                    key={index}
                    href={imageUrl}
                    accent="#ff2442"
                    selecting={gallerySel.selecting}
                    selected={gallerySel.isSelected(index)}
                    onToggle={() => gallerySel.toggle(index)}
                    className={`relative aspect-square rounded-xl overflow-hidden group block bg-transparent ${
                      images.length === 4 && index >= 2 ? "col-span-1" : ""
                    }`}>
                    <Image
                      src={imageUrl}
                      alt={`${xhsData.title || "图片"} ${index + 1}`}
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
            urls={images}
            baseName={`xhs-${xhsData.author || "笔记"}`}
            gradient="bg-gradient-to-r from-[#ff2442] to-[#ff5c7c] hover:opacity-90"
            selection={gallerySel}
          />
        </Card>
      )}

      {/* 文案：笔记信息与媒体之间，可一键复制 */}
      {xhsData.desc && <CaptionBox text={xhsData.desc} title="笔记文案" />}

      {/* 笔记信息：标题 / 内容类型（博主卡已展示作者信息） */}
      <ParseInfoPanel platform="xhs" data={xhsData} title="笔记信息" />
    </div>
  );
}
