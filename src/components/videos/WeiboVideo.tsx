"use client";
import React, { useState } from "react";
import Image from "next/image";
import { ApiResponse, ParseData } from "@/types/api";
import VideoPosterCard from "./VideoPosterCard";
import ParseInfoPanel from "./ParseInfoPanel";
import CaptionBox from "./CaptionBox";
import { downloadAllImages } from "@/utils/downloadImages";
import { Download, Loader2 } from "lucide-react";
import PlatformIcon from "@/components/PlatformIcon";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

/**
 * 微博结果卡片 —— 结构对齐小红书标准：
 * 博主信息卡 → 视频/图集 → 博文（可复制）→ 作品信息面板。
 * 博主卡展示主页公开信息（昵称可点主页 / 微博号 / 简介 / 关注 / 粉丝），
 * 作品信息面板只保留与内容相关的字段（发布时间 / 点赞 / 评论 / 转发 / 类型）。
 */
interface WeiboVideoProps {
  data: ApiResponse;
}

export default function WeiboVideo({ data }: WeiboVideoProps) {
  const [imageLoading, setImageLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);

  if (!data.data) {
    return null;
  }

  const weiboData = data.data as ParseData;
  const images = weiboData.images?.filter(Boolean) || [];
  const isImageType = weiboData.type === "image";
  const isText =
    weiboData.type === "text" || (!weiboData.url && images.length === 0);

  // 计数解析：兼容数字 / 数字字符串 / 中文单位字符串（"32.1万"、"1.2亿"）
  const parseCount = (v: unknown): number => {
    if (typeof v === "number") return Number.isFinite(v) ? v : Number.NaN;
    if (typeof v === "string") {
      const w = /^([\d.]+)\s*万$/.exec(v.trim());
      if (w) return parseFloat(w[1]) * 10000;
      const y = /^([\d.]+)\s*亿$/.exec(v.trim());
      if (y) return parseFloat(y[1]) * 100000000;
      return parseFloat(v);
    }
    return Number.NaN;
  };

  // 数字缩写：>1万 → x.x万 / xx万，其余千分位；无效或 ≤0 返回 undefined
  const formatCount = (n: number) =>
    n >= 10000
      ? `${(n / 10000).toFixed(n >= 1000000 ? 0 : 1)}万`
      : n.toLocaleString("zh-CN");

  // 博主主页公开信息徽标：关注 / 粉丝（微博无「获赞」公开字段，缺失自动隐藏）
  const authorBadges: { label: string; value?: number }[] = [
    { label: "关注", value: weiboData.followingCount },
    { label: "粉丝", value: weiboData.followerCount },
  ];

  const handleDownloadAll = async () => {
    if (downloading || images.length === 0) return;
    setDownloading(true);
    try {
      await downloadAllImages(images, `weibo-${weiboData.author || "图片"}`);
    } finally {
      setDownloading(false);
    }
  };

  // 下载文件名：weibo-作者-标题.mp4（走代理强制保存，需先净化非法字符）
  const safe = (s: string) =>
    s.replace(/[\\/:*?"<>|\r\n]/g, "_").replace(/\.{2,}/g, "_").trim();
  const downloadName = `weibo-${safe(weiboData.author || "video")}-${safe(
    (weiboData.title || "video").slice(0, 30)
  )}.mp4`;

  return (
    <div className="space-y-5" style={{ touchAction: 'pan-y' }}>
      {/* 博主信息卡：头像 + 昵称(可点击主页) + 微博号 + 简介 + 关注/粉丝（主页公开信息，缺失自动隐藏） */}
      {(weiboData.avatar || weiboData.author) && (
        <Card className="p-5">
          <div className="flex items-center gap-4">
            {weiboData.avatar && (
              <div className="relative flex-shrink-0">
                <div className="absolute inset-0 rounded-full bg-gradient-to-br from-[#e6162d] to-[#ff4d6a] blur-sm opacity-50" />
                <Image
                  src={weiboData.avatar}
                  alt={weiboData.author || ""}
                  width={56}
                  height={56}
                  className="relative rounded-full border-2 border-glass-3"
                  unoptimized
                />
              </div>
            )}
            <div className="flex-1 min-w-0">
              {weiboData.author && (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-secondary">作者</span>
                  {weiboData.authorUrl ? (
                    <a
                      href={weiboData.authorUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={`打开 ${weiboData.author} 的微博主页`}
                      className="text-sm font-medium text-accent truncate hover:underline hover:text-accent/80 transition-colors">
                      {weiboData.author}
                    </a>
                  ) : (
                    <span className="text-sm font-medium text-accent truncate">
                      {weiboData.author}
                    </span>
                  )}
                </div>
              )}
              {weiboData.authorId && (
                <p className="mt-0.5 text-xs text-muted truncate">
                  微博号：{weiboData.authorId}
                </p>
              )}
              {weiboData.sign && (
                <p className="mt-0.5 flex items-start gap-1 text-xs text-muted">
                  <span className="flex-shrink-0">简介：</span>
                  <span className="min-w-0 line-clamp-2">{weiboData.sign}</span>
                </p>
              )}
              {/* 关注 / 粉丝（纯文本，左边缘与上方文字严格对齐） */}
              <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                {authorBadges.map((badge) => {
                  const n = parseCount(badge.value);
                  if (!Number.isFinite(n) || n <= 0) return null;
                  return (
                    <span
                      key={badge.label}
                      className="inline-flex items-center gap-1">
                      <span className="text-muted">{badge.label}</span>
                      <span className="font-semibold text-primary">
                        {formatCount(n)}
                      </span>
                    </span>
                  );
                })}
              </div>
            </div>
            <div className="flex-shrink-0">
              <PlatformIcon platform="weibo" size={40} rounded="rounded-xl" />
            </div>
          </div>
        </Card>
      )}

      {/* 视频：封面 + 播放/下载（内嵌播放，直链走代理，体验与小红书一致） */}
      {!isImageType && weiboData.url && (
        <VideoPosterCard
          url={weiboData.url}
          cover={weiboData.cover}
          alt={weiboData.title || "视频封面"}
          accent="red"
          inline
          downloadName={downloadName}
        />
      )}

      {/* 图集：单图大图展示，多图网格（2/3/4 张自适应列数），点击打开原图 */}
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
                alt={weiboData.title || "图片"}
                fill
                sizes="(max-width: 800px) 100vw, 800px"
                className="object-cover"
                priority
                unoptimized
                onLoad={() => setImageLoading(false)}
              />
            </a>
          ) : (
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
                    alt={`${weiboData.title || "图片"} ${index + 1}`}
                    fill
                    sizes="(max-width: 800px) 50vw, 400px"
                    className="object-cover transition-transform duration-500 group-hover:scale-105"
                    unoptimized
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                </a>
              ))}
            </div>
          )}

          {/* 一键下载全部图片 */}
          <Button
            type="button"
            onClick={handleDownloadAll}
            disabled={downloading}
            size="lg"
            className="mt-3 w-full bg-gradient-to-r from-[#e6162d] to-[#ff4d6a] hover:opacity-90">
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

      {/* 博文：媒体下方，可一键复制（与小红书文案卡片一致） */}
      {(weiboData.desc || weiboData.title) && (
        <CaptionBox text={weiboData.desc || weiboData.title} title="博文" />
      )}

      {/* 微博信息：发布时间 / 点赞 / 评论 / 转发（博主卡已展示作者信息） */}
      <ParseInfoPanel platform="weibo" data={weiboData} title="微博信息" />

      {/* 纯文字微博：无媒体可下载，展示提示而非报错 */}
      {isText && (
        <Card className="p-6 text-center">
          <p className="text-sm text-muted leading-relaxed">
            该微博仅包含文字内容，无可下载的视频或图片
          </p>
        </Card>
      )}
    </div>
  );
}
