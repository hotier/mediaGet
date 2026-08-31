"use client";
import React from "react";
import Image from "next/image";
import { ApiResponse, ParsedVideoItem } from "@/types/api";
import VideoPosterCard from "./VideoPosterCard";
import ParseInfoPanel from "./ParseInfoPanel";
import CaptionBox from "./CaptionBox";
import { Download } from "lucide-react";
import PlatformIcon from "@/components/PlatformIcon";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface BilibiliVideoProps {
  data: ApiResponse;
}

export default function BilibiliVideo({ data }: BilibiliVideoProps) {
  const parsed = data.data;
  const videoItems = parsed?.videos || [];
  const hasVideo = videoItems.length > 0;
  // 直链 host 已在后端归一化为国内节点（upos-sz-mirrorbd.bilivideo.com），
  // 可内嵌当前页 <video> 播放
  const primaryVideoUrl = hasVideo ? videoItems[0].url : "";
  const posterUrl = parsed?.cover || undefined;

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
    const titlePart = (item.title || `P${index + 1}`)
      .replace(/[\\/:*?"<>|\r\n]/g, "_")
      .slice(0, 40);
    return `bilibili-${parsed?.author || "up"}-P${index + 1}-${titlePart}${labelPart}.mp4`;
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

  // 播放器下方「下载视频」按钮：点击平滑滚动定位到下方下载选项卡片
  const scrollToDownload = () => {
    document
      .getElementById("bilibili-download")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
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
                  <span className="text-sm text-secondary">UP主</span>
                  {parsed.authorUrl ? (
                    <a
                      href={parsed.authorUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={`打开 ${parsed.author} 的B站主页`}
                      className="text-sm font-medium text-accent truncate hover:underline hover:text-accent/80 transition-colors">
                      {parsed.author}
                    </a>
                  ) : (
                    <span className="text-sm font-medium text-accent truncate">
                      {parsed.author}
                    </span>
                  )}
                </div>
              )}
              {parsed?.authorId && (
                <p className="mt-0.5 text-xs text-muted truncate">
                  UID：{parsed.authorId}
                </p>
              )}
              {parsed?.sign && (
                <p className="mt-0.5 flex items-start gap-1 text-xs text-muted">
                  <span className="flex-shrink-0">简介：</span>
                  <span className="min-w-0 line-clamp-2">{parsed.sign}</span>
                </p>
              )}
              {/* 关注 / 粉丝 / 获赞（纯文本，左边缘与上方文字严格对齐） */}
              <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-xs">
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
          tall
          inline
          downloadText="下载视频"
          onDownloadClick={scrollToDownload}
        />
      )}

      {/* 文案：视频下方，可一键复制 */}
      {parsed?.desc && <CaptionBox text={parsed.desc} title="视频简介" />}

      {/* 视频信息：UP主 / 分P数量（放在简介下方） */}
      <ParseInfoPanel platform="bilibili" data={parsed} title="视频信息" />

      {/* Download Options：按清晰度下载（走视频代理 + Content-Disposition 强制保存文件） */}
      {hasVideo && (
        <Card id="bilibili-download" className="p-5 scroll-mt-24">
          <h3 className="text-sm font-semibold text-primary mb-4 flex items-center gap-2">
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

          <div className="space-y-3">
            {videoItems.map((item, index) => {
              // 可下载档位：有清晰度列表按档位逐条列出，否则按默认直链单条
              const rows =
                Array.isArray(item.qualities) && item.qualities.length > 0
                  ? item.qualities.map((q) => ({ url: q.url, label: q.label }))
                  : [{ url: item.url, label: item.accept?.[0] || "默认" }];
              return (
                <div
                  key={index}
                  className="rounded-xl bg-glass-2 hover:bg-glass-3 transition-colors duration-200 overflow-hidden">
                  {/* 分P 头 */}
                  <div className="flex items-center gap-3 px-4 pt-4 pb-3">
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
                        {item.title || `视频 ${index + 1}`}
                      </p>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                        {item.durationFormat && (
                          <span className="text-xs text-muted">
                            {item.durationFormat}
                          </span>
                        )}
                        {Array.isArray(item.accept) && item.accept.length > 0 && (
                          <span className="rounded-md bg-glass-2 px-1.5 py-0.5 text-[11px] text-accent">
                            {item.accept.join(" / ")}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* 可下载清晰度列表：每个档位独立一行，点击直接下载 */}
                  <div className="px-4 pb-4 space-y-2">
                    {rows.map((row) => (
                      <div
                        key={row.label}
                        className="flex items-center justify-between rounded-lg bg-glass-1 px-3 py-2">
                        <span className="text-sm text-primary">
                          {row.label}
                        </span>
                        <Button
                          asChild
                          size="sm"
                          className="bg-gradient-to-r from-[#00aeec] to-[#4dc9ff] hover:opacity-90">
                          <a
                            href={`/api/video-proxy?url=${encodeURIComponent(
                              row.url
                            )}&download=1&filename=${encodeURIComponent(
                              buildDownloadName(item, index, row.label)
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
                </div>
              );
            })}
          </div>
        </Card>
      )}

    </div>
  );
}
