"use client";
import React, { useState } from "react";
import Image from "next/image";
import { ApiResponse, ParseData } from "@/types/api";
import VideoPosterCard from "./VideoPosterCard";
import ParseInfoPanel from "./ParseInfoPanel";
import CaptionBox from "./CaptionBox";
import CollapsibleGallery from "./CollapsibleGallery";
import { downloadAllImages } from "@/utils/downloadImages";
import { sanitizeFilename } from "@/utils/filename";
import { Download, Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import PlatformIcon from "@/components/PlatformIcon";

interface DouyinVideoProps {
  data: ApiResponse;
}

export default function DouyinVideo({ data }: DouyinVideoProps) {
  const [downloading, setDownloading] = useState(false);

  if (!data.data) {
    return null;
  }

  const douyinData = data.data as ParseData;
  const isImageType = douyinData.type === "image";
  const images = douyinData.images?.filter(Boolean) || [];
  // 文案：desc 优先（完整描述），缺失时回退 title
  const caption = douyinData.desc || douyinData.title;
  // 下载文件名：douyin-作者-标题.mp4（走代理强制保存，净化 + 限长见 @/utils/filename）
  const downloadName = `douyin-${sanitizeFilename(
    douyinData.author || "video",
    20
  )}-${sanitizeFilename(douyinData.title || "video", 30)}.mp4`;

  // 数字缩写：>1万 → x.x万 / xx万，其余千分位
  const formatCount = (n: number) =>
    n >= 10000
      ? `${(n / 10000).toFixed(n >= 1000000 ? 0 : 1)}万`
      : n.toLocaleString("zh-CN");

  // 博主主页公开信息徽标：关注 / 粉丝 / 获赞
  const authorBadges: { label: string; value?: number }[] = [
    { label: "关注", value: douyinData.followingCount },
    { label: "粉丝", value: douyinData.followerCount },
    { label: "获赞", value: douyinData.totalFavorited },
  ];

  const handleDownloadAll = async () => {
    if (downloading || images.length === 0) return;
    setDownloading(true);
    try {
      await downloadAllImages(images, `douyin-${douyinData.author || "图集"}`);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-5" style={{ touchAction: 'pan-y' }}>
      {/* 博主信息卡：头像 + 昵称 + 抖音号 + 粉丝/关注/获赞（主页公开信息，缺失自动隐藏） */}
      {(douyinData.avatar || douyinData.author) && (
        <Card className="p-5">
          <div className="flex items-center gap-4">
            {douyinData.avatar && (
              <div className="relative flex-shrink-0">
                <div className="absolute inset-0 rounded-full bg-gradient-to-br from-[#fe2c55] to-[#ff6b8a] blur-sm opacity-50" />
                <Image
                  src={douyinData.avatar}
                  alt={douyinData.author || ""}
                  width={56}
                  height={56}
                  className="relative rounded-full border-2 border-glass-3"
                  unoptimized
                />
              </div>
            )}
            <div className="flex-1 min-w-0">
              {douyinData.author && (
                <div className="flex items-center gap-2">
                  <span className="text-[13px] text-secondary">博主</span>
                  {douyinData.authorUrl ? (
                    <a
                      href={douyinData.authorUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={`打开 ${douyinData.author} 的抖音主页`}
                      className="text-[13px] font-medium text-accent truncate hover:underline hover:text-accent/80 transition-colors">
                      {douyinData.author}
                    </a>
                  ) : (
                    <span className="text-[13px] font-medium text-accent truncate">
                      {douyinData.author}
                    </span>
                  )}
                </div>
              )}
              {douyinData.uid && (
                <p className="mt-0.5 text-[13px] text-muted truncate">
                  抖音号：{douyinData.uid}
                </p>
              )}
              {douyinData.sign && (
                <p className="mt-0.5 flex items-start gap-1 text-[13px] text-muted">
                  <span className="flex-shrink-0">简介：</span>
                  <span className="min-w-0 line-clamp-2">{douyinData.sign}</span>
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
              <PlatformIcon platform="douyin" size={40} rounded="rounded-xl" />
            </div>
          </div>
        </Card>
      )}

      {/* 视频：封面 + 当前页内嵌播放（点击封面或「播放」按钮展开播放器）+ 下载（走代理强制保存）+ 音频下载 */}
      {!isImageType && douyinData.url && (
        <VideoPosterCard
          url={douyinData.url}
          cover={douyinData.cover}
          alt={douyinData.title || "视频封面"}
          accent="dy"
          tall
          inline
          downloadText="下载视频"
          audioUrl={douyinData.audioUrl}
          downloadName={downloadName}
        />
      )}

      {/* Image Gallery：单图全宽展示，多图网格（手机 2 列 / 桌面 3 列），点击打开原图 */}
      {isImageType && images.length > 0 && (
        <Card className="p-3">
          {images.length === 1 ? (
            <a
              href={images[0]}
              target="_blank"
              rel="noopener noreferrer"
              className="block rounded-xl overflow-hidden bg-black">
              <Image
                src={images[0]}
                alt={douyinData.title || "图片"}
                width={864}
                height={1920}
                className="w-full h-auto rounded-xl"
                priority
                unoptimized
              />
            </a>
          ) : (
            <CollapsibleGallery>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {images.map((imageUrl, index) => (
                  <a
                    key={index}
                    href={imageUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="relative aspect-[3/4] rounded-xl overflow-hidden group block bg-black">
                    <Image
                      src={imageUrl}
                      alt={`${douyinData.title || "图片"} ${index + 1}`}
                      fill
                      sizes="(max-width: 640px) 50vw, 33vw"
                      className="object-cover transition-transform duration-500 group-hover:scale-[1.02]"
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
            className="mt-3 w-full bg-gradient-to-r from-[#fe2c55] to-[#ff6b8a] hover:opacity-90">
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

      {/* Image type hint */}
      {isImageType && (
        <Card className="p-3 flex items-center gap-2 text-xs text-muted">
          <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>当前显示为静态图，动图/实况图的动画效果暂不支持</span>
        </Card>
      )}

      {/* 文案：视频信息与下载按钮之间，可一键复制 */}
      {caption && <CaptionBox text={caption} title="文案" />}

      {/* 作品信息：作者 / 抖音号 / 点赞 / 发布时间 / 时长 / 背景音乐 */}
      <ParseInfoPanel platform="douyin" data={douyinData} title="视频信息" />
    </div>
  );
}