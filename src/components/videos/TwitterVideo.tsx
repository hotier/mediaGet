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
import PlatformIcon from "@/components/PlatformIcon";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

/**
 * X (Twitter) 结果卡片 —— 结构对齐微博标准：
 * 博主信息卡 → 视频（多P切换/下载）→ 图集 → 推文（可复制）→ 作品信息面板。
 * 多视频推文（最多 4 个媒体）由后端解析为 videos 列表，播放卡内分P切换，
 * 下载区逐P列出（对齐 B 站/微博心智）；视频+图片混合推文两者叠加展示。
 */
interface TwitterVideoProps {
  data: ApiResponse;
}

export default function TwitterVideo({ data }: TwitterVideoProps) {
  const [imageLoading, setImageLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  // 一键下载全部分P视频：触发期间禁用按钮防重复
  const [downloadingAll, setDownloadingAll] = useState(false);

  if (!data.data) {
    return null;
  }

  const d = data.data as ParseData;
  const images = d.images?.filter(Boolean) || [];
  // 多视频：后端把多视频推文各视频直链解析为 videos，播放卡片内分P切换；
  // 单视频/图集时无此字段，仍走 url / images。
  const videos = (d.videos || []).filter((v) => v && v.url);
  const hasMultiVideo = videos.length > 1;
  // 媒体渲染与 type 解耦：有视频直链就渲染视频，有图片就渲染图集，两者可叠加
  const hasVideo = !!d.url && d.type !== "image";
  const hasImages = images.length > 0;

  // 数字缩写：>1万 → x.x万 / xx万，其余千分位（对齐小红书/微博博主卡）
  const formatCount = (n: number) =>
    n >= 10000
      ? `${(n / 10000).toFixed(n >= 1000000 ? 0 : 1)}万`
      : n.toLocaleString("zh-CN");

  const handleDownloadAllImages = async () => {
    if (downloading || images.length === 0) return;
    setDownloading(true);
    try {
      await downloadAllImages(images, `twitter-${d.author || "图片"}`);
    } finally {
      setDownloading(false);
    }
  };

  // 下载文件名：twitter-作者-标题.mp4（走代理强制保存；标题 30 字，净化后拼接）
  const downloadName = `twitter-${sanitizeFilename(
    d.author || "video",
    20
  )}-${sanitizeFilename(d.title || "video", 30)}.mp4`;

  // 多分P下载文件名：twitter-作者-P{序号}-标题.mp4（带P序号，逐P下载不冲突）
  const buildDownloadName = (index: number): string =>
    `twitter-${sanitizeFilename(d.author || "video", 20)}-P${
      index + 1
    }-${sanitizeFilename(d.title || "video", 30)}.mp4`;

  // 播放卡「下载」按钮：多P时滚动定位到下方「下载选项」列表中对应分P的下载行
  const scrollToDownload = (index: number) => {
    document
      .getElementById(`twitter-download-${index}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  // 一键下载全部分P：逐个触发视频代理下载（同源 URL + Content-Disposition 强制保存），
  // 间隔 600ms 避免浏览器把连续下载当批量行为拦截
  const handleDownloadAllVideos = () => {
    if (downloadingAll || videos.length === 0) return;
    setDownloadingAll(true);
    videos.forEach((item, index) => {
      setTimeout(() => {
        const url = `/api/video-proxy?url=${encodeURIComponent(
          item.url
        )}&download=1&filename=${encodeURIComponent(buildDownloadName(index))}`;
        const a = document.createElement("a");
        a.href = url;
        a.download = "";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, index * 600);
    });
    setTimeout(() => setDownloadingAll(false), videos.length * 600);
  };

  return (
    <div className="space-y-5" style={{ touchAction: "pan-y" }}>
      {/* 博主信息卡：头像 + 昵称 + 用户ID */}
      {(d.avatar || d.author) && (
        <Card className="p-5">
          <div className="flex items-center gap-4">
            {d.avatar && (
              <Image
                src={d.avatar}
                alt={d.author || ""}
                width={56}
                height={56}
                className="rounded-full border-2 border-glass-3"
                unoptimized
              />
            )}
            <div className="flex-1 min-w-0">
              {d.author && (
                <div className="flex items-center gap-2">
                  <span className="text-[13px] text-secondary">作者</span>
                  {d.authorUrl ? (
                    <a
                      href={d.authorUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={`打开 ${d.author} 的 X 主页`}
                      className="text-[13px] font-medium text-accent truncate hover:underline hover:text-accent/80 transition-colors">
                      {d.author}
                    </a>
                  ) : (
                    <span className="text-[13px] font-medium text-accent truncate">
                      {d.author}
                    </span>
                  )}
                </div>
              )}
              {d.authorId && (
                <p className="mt-0.5 text-[13px] text-muted truncate">
                  用户名：{d.authorId}
                </p>
              )}
              {d.sign && (
                <p className="mt-0.5 flex items-start gap-1 text-[13px] text-muted">
                  <span className="flex-shrink-0">简介：</span>
                  <span className="min-w-0 line-clamp-2">{d.sign}</span>
                </p>
              )}
              {(d.followingCount != null && d.followingCount > 0) ||
              (d.followerCount != null && d.followerCount > 0) ? (
                <p className="mt-0.5 flex items-center gap-4 text-[13px] text-muted">
                  {d.followingCount != null && d.followingCount > 0 && (
                    <span>关注：{formatCount(d.followingCount)}</span>
                  )}
                  {d.followerCount != null && d.followerCount > 0 && (
                    <span>粉丝：{formatCount(d.followerCount)}</span>
                  )}
                </p>
              ) : null}
            </div>
            <div className="flex-shrink-0">
              <PlatformIcon platform="twitter" size={40} rounded="rounded-xl" />
            </div>
          </div>
        </Card>
      )}

      {/* 视频：封面 + 播放/下载。多视频推文：分P切换条在播放卡片内，
          下载按钮多P时滚动定位到下方「下载选项」列表（与B站/微博一致） */}
      {hasVideo && (
        <VideoPosterCard
          url={d.url!}
          cover={d.cover}
          alt={d.title || "视频封面"}
          accent="neutral"
          inline
          parts={hasMultiVideo ? videos : undefined}
          downloadName={downloadName}
          downloadText={hasMultiVideo ? "下载视频" : undefined}
          onDownloadClick={hasMultiVideo ? scrollToDownload : undefined}
        />
      )}

      {/* 图集：单图大图展示，多图网格；视频+图片混合时与视频叠加展示 */}
      {hasImages && (
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
                alt={d.title || "图片"}
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
                    className="relative aspect-square rounded-xl overflow-hidden group block bg-black">
                    <Image
                      src={imageUrl}
                      alt={`${d.title || "图片"} ${index + 1}`}
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
            onClick={handleDownloadAllImages}
            disabled={downloading}
            size="lg"
            className="mt-3 w-full bg-gradient-to-r from-[#14171a] to-[#657786] hover:opacity-90">
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

      {/* 推文文案：媒体下方，可一键复制 */}
      {(d.desc || d.title) && (
        <CaptionBox text={(d.desc || d.title)!} title="推文" />
      )}

      {/* 作品信息：发布时间 / 时长 / 类型（博主卡已展示作者信息） */}
      <ParseInfoPanel platform="twitter" data={d} title="推文信息" />

      {/* 多P下载选项：分P逐条列出，每条一个下载按钮（推特每P单一清晰度直链，
          无需B站的档位列表）。文件名带P序号，逐P下载互不覆盖 */}
      {hasVideo && hasMultiVideo && (
        <Card id="twitter-download" className="p-5 scroll-mt-24">
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
              下载选项 ({videos.length})
            </h3>
            {/* 一键下载全部：逐个触发下载，浏览器若提示「允许多次下载」需用户确认一次 */}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleDownloadAllVideos}
              disabled={downloadingAll}
              className="flex-shrink-0">
              {downloadingAll ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  正在触发...
                </>
              ) : (
                <>
                  <Download className="h-4 w-4" />
                  一键下载全部
                </>
              )}
            </Button>
          </div>

          <div className="space-y-3">
            {videos.map((item, index) => (
              <div
                key={index}
                id={`twitter-download-${index}`}
                className="flex items-center gap-3 rounded-xl bg-glass-2 hover:bg-glass-3 transition-colors duration-200 px-4 py-3 scroll-mt-24">
                {item.cover && (
                  <Image
                    src={item.cover}
                    alt={item.title || `视频 ${index + 1}`}
                    width={120}
                    height={75}
                    className="w-[120px] h-[75px] rounded-lg object-cover flex-shrink-0 border border-glass-3"
                    unoptimized
                  />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-primary truncate">
                    P{index + 1}: {item.title || d.title || "视频"}
                  </p>
                  {item.durationFormat && (
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                      <span className="text-xs text-muted">
                        {item.durationFormat}
                      </span>
                      <span className="rounded-md bg-glass-2 px-1.5 py-0.5 text-[11px] text-accent">
                        MP4
                      </span>
                    </div>
                  )}
                </div>
                {/* 下载按钮固定在行右侧，随分P紧凑排列 */}
                <Button
                  asChild
                  size="sm"
                  className="flex-shrink-0 bg-gradient-to-r from-[#14171a] to-[#657786] hover:opacity-90">
                  <a
                    href={`/api/video-proxy?url=${encodeURIComponent(
                      item.url
                    )}&download=1&filename=${encodeURIComponent(
                      buildDownloadName(index)
                    )}`}
                    target="_blank"
                    rel="noopener noreferrer">
                    <Download className="h-4 w-4" />
                    下载
                  </a>
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
