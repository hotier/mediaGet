"use client";
import React, { useState } from "react";
import Image from "next/image";
import { ApiResponse, ParseData } from "@/types/api";
import VideoPosterCard from "./VideoPosterCard";
import ParseInfoPanel from "./ParseInfoPanel";
import CaptionBox from "./CaptionBox";
import CollapsibleGallery from "./CollapsibleGallery";
import { sanitizeFilename } from "@/utils/filename";
import { Download, Loader2 } from "lucide-react";
import {
  GalleryDownloadBar,
  SelectableImageLink,
  useGallerySelection,
} from "./GalleryMultiSelect";
import PlatformIcon from "@/components/PlatformIcon";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import TruncatedText from "@/components/ui/truncated-text";

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
  // 一键下载全部分P视频：触发期间禁用按钮防重复
  const [downloadingAll, setDownloadingAll] = useState(false);
  // 图集多选状态（图文 N 张图；张数随解析结果变化时自动清理越界勾选）
  const gallerySel = useGallerySelection(
    (data.data as ParseData | undefined)?.images?.filter(Boolean).length ?? 0
  );

  if (!data.data) {
    return null;
  }

  const weiboData = data.data as ParseData;
  const images = weiboData.images?.filter(Boolean) || [];
  // 多视频：后端把多视频帖各视频直链解析为 videos，播放卡片内分P切换；
  // 单视频/图集时无此字段，仍走 url / images。
  const videos = (weiboData.videos || []).filter((v) => v && v.url);
  const hasMultiVideo = videos.length > 1;
  // 媒体渲染与 type 解耦：有视频直链就渲染视频，有图片就渲染图集，两者可叠加
  // （图文混合微博：视频 + 多图、文字 + 多图）
  // 注意：image 类型时 url 指向第一张图（非视频直链），须排除，否则会误渲染视频卡
  const hasVideo = !!weiboData.url && weiboData.type !== "image";
  const hasImages = images.length > 0;
  const isText = !hasVideo && !hasImages;

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

  // 净化文件名片段：共享工具见 @/utils/filename，移除文件系统不安全的字符并限长。
  // 微博标题常为整段博文文案，可能含换行、引号、表情、零宽字符等，直接拼文件名容易出错。
  // 下载文件名：weibo-作者-标题.mp4（作者 20 字、标题 30 字，走代理强制保存）
  const downloadName = `weibo-${sanitizeFilename(
    weiboData.author || "video",
    20
  )}-${sanitizeFilename(weiboData.title || "video", 30)}.mp4`;

  // 多分P下载文件名：weibo-作者-P{序号}-标题.mp4（带P序号，逐P下载不冲突）
  const buildDownloadName = (index: number): string =>
    `weibo-${sanitizeFilename(weiboData.author || "video", 20)}-P${
      index + 1
    }-${sanitizeFilename(weiboData.title || "video", 30)}.mp4`;

  // 播放卡「下载」按钮：多P时滚动定位到下方「下载选项」列表中对应分P的下载行，
  // 而不是列表顶部——用户正在看/播放第几P，就跳到第几P的下载按钮
  const scrollToDownload = (index: number) => {
    document
      .getElementById(`weibo-download-${index}`)
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
                  <span className="text-[13px] text-secondary">作者</span>
                  {weiboData.authorUrl ? (
                    <TruncatedText
                      as="a"
                      text={weiboData.author}
                      href={weiboData.authorUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[13px] font-medium text-accent truncate hover:underline hover:text-accent/80 transition-colors"
                    />
                  ) : (
                    <TruncatedText
                      text={weiboData.author}
                      className="text-[13px] font-medium text-accent truncate"
                    />
                  )}
                </div>
              )}
              {weiboData.authorId && (
                <TruncatedText
                  as="p"
                  text={`微博号：${weiboData.authorId}`}
                  className="mt-0.5 text-[13px] text-muted truncate"
                />
              )}
              {weiboData.sign && (
                <p className="mt-0.5 flex items-start gap-1 text-[13px] text-muted">
                  <span className="flex-shrink-0">简介：</span>
                  <TruncatedText
                    text={weiboData.sign}
                    className="min-w-0 line-clamp-2"
                  />
                </p>
              )}
              {/* 关注 / 粉丝（纯文本，左边缘与上方文字严格对齐） */}
              <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-[13px]">
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
      {/* 多视频帖：分P切换条展示在播放卡片内，播放/封面跟随当前分P；
          下载按钮多P时滚动定位到下方「下载选项」列表（与B站一致），单视频直接下载 */}
      {hasVideo && (
        <VideoPosterCard
          url={weiboData.url!}
          cover={weiboData.cover}
          alt={weiboData.title || "视频封面"}
          accent="red"
          inline
          parts={hasMultiVideo ? videos : undefined}
          downloadName={downloadName}
          downloadText={hasMultiVideo ? "下载视频" : undefined}
          onDownloadClick={hasMultiVideo ? scrollToDownload : undefined}
        />
      )}

      {/* 图集：单图大图展示，多图网格（2/3/4 张自适应列数），点击打开原图 */}
      {/* 图文混合时与视频叠加展示（视频在上、图集在下） */}
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
                    accent="#e6162d"
                    selecting={gallerySel.selecting}
                    selected={gallerySel.isSelected(index)}
                    onToggle={() => gallerySel.toggle(index)}
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
                  </SelectableImageLink>
                ))}
              </div>
            </CollapsibleGallery>
          )}

          {/* 图集下载：选图多选下载 / 一键下载全部（多选文件名保留原图序） */}
          <GalleryDownloadBar
            urls={images}
            baseName={`weibo-${weiboData.author || "图片"}`}
            gradient="bg-gradient-to-r from-[#e6162d] to-[#ff4d6a] hover:opacity-90"
            selection={gallerySel}
          />
        </Card>
      )}

      {/* 博文：媒体下方，可一键复制（与小红书文案卡片一致） */}
      {(weiboData.desc || weiboData.title) && (
        <CaptionBox
          text={(weiboData.desc || weiboData.title)!}
          title="博文"
        />
      )}

      {/* 微博信息：发布时间 / 点赞 / 评论 / 转发（博主卡已展示作者信息） */}
      <ParseInfoPanel platform="weibo" data={weiboData} title="微博信息" />

      {/* 多P下载选项：分P逐条列出，每条一个下载按钮（微博每P单一清晰度直链，
          无需B站的档位列表）。文件名带P序号，逐P下载互不覆盖 */}
      {hasVideo && hasMultiVideo && (
        <Card id="weibo-download" className="p-5 scroll-mt-24">
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
                id={`weibo-download-${index}`}
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
                  <TruncatedText
                    as="p"
                    text={`P${index + 1}: ${item.title || weiboData.title || "视频"}`}
                    className="text-sm font-medium text-primary truncate"
                  />
                  {item.durationFormat && (
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                      <span className="text-xs text-muted">
                        {item.durationFormat}
                      </span>
                      <span className="rounded-md bg-glass-2 px-1.5 py-0.5 text-[11px] text-accent">
                        720P
                      </span>
                    </div>
                  )}
                </div>
                {/* 下载按钮固定在行右侧，随分P紧凑排列（微博单清晰度，无需档位列表） */}
                <Button
                  asChild
                  size="sm"
                  className="flex-shrink-0 bg-gradient-to-r from-[#e6162d] to-[#ff4d6a] hover:opacity-90">
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
