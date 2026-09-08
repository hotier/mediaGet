"use client";
import Image from "next/image";
import { Download, ExternalLink } from "lucide-react";
import { ApiResponse, ParseData } from "@/types/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import TruncatedText from "@/components/ui/truncated-text";

/** failType → 访客友好的试听缺失提示（运维细节如 Cookie 配置不外露） */
const AUDIO_FAIL_HINTS: Record<string, string> = {
  "vip-only": "该歌曲为 VIP/付费歌曲，暂无可下载的试听直链",
  "need-cookie": "试听链接暂时无法获取，请稍后重试",
  "sign-stale": "试听链接暂时无法获取，请稍后重试",
  "sources-down": "QQ音乐解析源暂时不可用，请稍后重试",
};

interface QymusicVideoProps {
  data: ApiResponse;
}

export default function QymusicVideo({ data }: QymusicVideoProps) {
  if (!data.data) {
    return null;
  }

  const musicData = data.data as ParseData;
  const audioHint =
    !musicData.url && data.failType
      ? AUDIO_FAIL_HINTS[data.failType] || "试听链接暂时无法获取，请稍后重试"
      : "";

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="flex items-center gap-4 mb-5">
          {musicData.cover && (
            <Image
              src={musicData.cover}
              alt={musicData.name || "音乐封面"}
              width={80}
              height={80}
              className="rounded-lg border border-border-subtle"
              unoptimized
            />
          )}
          <div className="min-w-0">
            <TruncatedText
              as="h2"
              text={musicData.name || ""}
              className="text-lg font-semibold text-primary line-clamp-2"
            />
            {musicData.author && (
              <p className="text-sm text-secondary mt-1">{musicData.author}</p>
            )}
            {musicData.core && (
              <p className="text-xs text-muted mt-0.5">{musicData.core}</p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {musicData.url && (
            <Button
              asChild
              className="gap-2 bg-gradient-to-r from-[#31C27C] to-[#5ED5A2] hover:opacity-90">
              <a href={musicData.url} target="_blank" rel="noopener noreferrer">
                <Download className="h-4 w-4" />
                下载试听
              </a>
            </Button>
          )}
          {musicData.url && (
            <Button asChild variant="outline" className="gap-2">
              <a href={musicData.url} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4" />
                新窗口打开
              </a>
            </Button>
          )}
        </div>

        {audioHint && (
          <p className="text-sm text-muted mt-3">{audioHint}</p>
        )}
      </Card>
    </div>
  );
}
