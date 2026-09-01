"use client";
import React, { useState } from "react";
import Image from "next/image";
import { ApiResponse, ParseData } from "@/types/api";
import VideoPosterCard from "./VideoPosterCard";
import ParseInfoPanel from "./ParseInfoPanel";
import CaptionBox from "./CaptionBox";
import CollapsibleGallery from "./CollapsibleGallery";
import { downloadAllImages } from "@/utils/downloadImages";
import { Download, Loader2 } from "lucide-react";
import PlatformIcon from "@/components/PlatformIcon";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface XhsVideoProps {
  data: ApiResponse;
}

export default function XhsVideo({ data }: XhsVideoProps) {
  const [imageLoading, setImageLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);

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

  // 博主主页公开信息徽标：关注 / 粉丝 / 获赞（缺失自动隐藏）
  const authorBadges: { label: string; value?: number }[] = [
    { label: "关注", value: xhsData.followingCount },
    { label: "粉丝", value: xhsData.followerCount },
    { label: "获赞", value: xhsData.totalFavorited },
  ];

  const handleDownloadAll = async () => {
    if (downloading || images.length === 0) return;
    setDownloading(true);
    try {
      await downloadAllImages(images, `xhs-${xhsData.author || "笔记"}`);
    } finally {
      setDownloading(false);
    }
  };

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
                    <a
                      href={xhsData.authorUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={`打开 ${xhsData.author} 的小红书主页`}
                      className="text-[13px] font-medium text-accent truncate hover:underline hover:text-accent/80 transition-colors">
                      {xhsData.author}
                    </a>
                  ) : (
                    <span className="text-[13px] font-medium text-accent truncate">
                      {xhsData.author}
                    </span>
                  )}
                </div>
              )}
              {xhsData.authorId && (
                <p className="mt-0.5 text-[13px] text-muted truncate">
                  小红书号：{xhsData.authorId}
                </p>
              )}
              {xhsData.sign && (
                <p className="mt-0.5 flex items-start gap-1 text-[13px] text-muted">
                  <span className="flex-shrink-0">简介：</span>
                  <span className="min-w-0 line-clamp-2">{xhsData.sign}</span>
                </p>
              )}
              {/* 关注 / 粉丝 / 获赞（纯文本，左边缘与上方文字严格对齐） */}
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
              className="relative block aspect-square rounded-xl overflow-hidden bg-black">
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
                  <a
                    key={index}
                    href={imageUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`relative aspect-square rounded-xl overflow-hidden group block bg-black ${
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
                  </a>
                ))}
              </div>
            </CollapsibleGallery>
          )}

          {/* 一键下载全部图片 */}
          <Button
            type="button"
            onClick={handleDownloadAll}
            disabled={downloading}
            size="lg"
            className="mt-3 w-full bg-gradient-to-r from-[#ff2442] to-[#ff5c7c] hover:opacity-90">
            {downloading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                正在下载...
              </>
            ) : (
              <>
                <Download className="h-4 w-4" />
                一键下载全部图片（{images.length} 张）
              </>
            )}
          </Button>
        </Card>
      )}

      {/* 文案：笔记信息与媒体之间，可一键复制 */}
      {xhsData.desc && <CaptionBox text={xhsData.desc} title="笔记文案" />}

      {/* 笔记信息：标题 / 内容类型（博主卡已展示作者信息） */}
      <ParseInfoPanel platform="xhs" data={xhsData} title="笔记信息" />
    </div>
  );
}
