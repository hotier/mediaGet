import type { Metadata } from "next";
import "./music.css";
import MusicExplorer from "@/components/music/MusicExplorer";
import { siteConfig } from "@/config/site";

export const metadata: Metadata = {
  title: "音乐解析下载 - 多源聚合",
  description:
    "多源聚合音乐解析播放器：统一接入网易云音乐、酷我音乐、JOOX 等音源，输入歌名或歌手关键词即可搜索点播，一键获取试听 / 下载直链，即搜即听、即点即下。",
  keywords: [
    "音乐解析",
    "音乐下载",
    "在线搜歌",
    "在线听歌",
    "网易云音乐解析",
    "网易云音乐下载",
    "酷我音乐下载",
    "JOOX",
    "多源聚合",
    "音乐直链",
    "音频下载",
    siteConfig.name,
  ],
  alternates: {
    canonical: `${siteConfig.url}/music`,
  },
  openGraph: {
    title: `音乐解析下载 - 多源聚合 - ${siteConfig.name}`,
    description:
      "统一接入网易云、酷我、JOOX 等聚合音源，按关键词搜索即可获取歌曲试听与下载直链；全民K歌等视频内容请前往视频解析页。",
    url: `${siteConfig.url}/music`,
    siteName: siteConfig.name,
    type: "website",
    locale: "zh_CN",
  },
};

export default function MusicPage() {
  return <MusicExplorer />;
}
