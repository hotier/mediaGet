import type { Metadata, Viewport } from "next";
import "./globals.css";
import Footer from "@/components/Footer";
import SiteHeader from "@/components/SiteHeader";
import { siteConfig } from "@/config/site";

export const metadata: Metadata = {
  metadataBase: new URL(siteConfig.url),
  title: {
    default: `${siteConfig.name} - 短视频解析下载工具`,
    template: `%s - ${siteConfig.name}`,
  },
  description:
    "在线免费短视频解析工具，支持抖音、快手、B站、微博、小红书、西瓜、虎牙、X 等 24+ 平台，粘贴链接即得无水印视频下载地址，无需安装、即贴即用。",
  keywords: [
    "视频解析",
    "短视频解析",
    "视频下载",
    "无水印视频下载",
    "去水印",
    "视频去水印",
    "抖音解析",
    "抖音去水印",
    "抖音视频下载",
    "快手解析",
    "快手去水印",
    "B站解析",
    "bilibili解析",
    "微博解析",
    "微博视频下载",
    "小红书解析",
    "小红书视频下载",
    "西瓜视频解析",
    "虎牙解析",
    "皮皮虾解析",
    "微视解析",
    "火山解析",
    "梨视频解析",
    "AcFun解析",
    "美拍解析",
    "全民K歌解析",
    "X视频解析",
    "Twitter解析",
    "视频解析工具",
    "免费视频解析",
    "在线视频解析",
    siteConfig.name,
  ],
  manifest: "/manifest.webmanifest",
  authors: [{ name: siteConfig.domain }],
  openGraph: {
    title: `${siteConfig.name} - 短视频解析下载工具`,
    description:
      "免费在线短视频解析，支持抖音、快手、B站、微博、小红书、西瓜、虎牙、X 等 24+ 平台，粘贴链接即得无水印视频下载地址。",
    url: siteConfig.url,
    siteName: siteConfig.name,
    type: "website",
    locale: "zh_CN",
    images: [
      { url: "/og-image.png", width: 1200, height: 630, alt: `${siteConfig.name} 短视频解析` },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: `${siteConfig.name} - 短视频解析下载工具`,
    description:
      "免费在线短视频解析，支持抖音、快手、B站、微博、小红书、西瓜、虎牙、X 等 24+ 平台，粘贴链接即得无水印视频下载地址。",
    images: ["/og-image.png"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true },
  },
  alternates: {
    canonical: siteConfig.url,
  },
};

export const viewport: Viewport = {
  themeColor: "#0b0b14",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="scroll-smooth" suppressHydrationWarning>
      <head>
        {/* 主题初始化：body 渲染前同步挂载 class，避免闪烁（FOUC） */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("theme");var d=t?t==="dark":window.matchMedia("(prefers-color-scheme: dark)").matches;document.documentElement.classList.add(d?"dark":"light");}catch(e){document.documentElement.classList.add("light");}})();`,
          }}
        />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <link rel="icon" type="image/svg+xml" href="/icon.svg" />
        <link rel="apple-touch-icon" href="/icon.png" />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "WebApplication",
              name: siteConfig.name,
              url: siteConfig.url,
              applicationCategory: "UtilityApplication",
              operatingSystem: "Any",
              description:
                "免费在线短视频解析工具，支持抖音、快手、B站、微博、小红书、西瓜、虎牙、X 等 24+ 平台，粘贴链接即得无水印视频下载地址。",
              inLanguage: "zh-CN",
              offers: { "@type": "Offer", price: "0", priceCurrency: "CNY" },
            }),
          }}
        />
      </head>
      <body className="antialiased min-h-screen flex flex-col noise-overlay">
        {/* 全站 AI 感网格背景层 */}
        <div className="aurora-grid" aria-hidden="true" />
        <div className="relative flex min-h-screen flex-1 flex-col" style={{ zIndex: 1 }}>
          <SiteHeader />
          <main className="flex-1">{children}</main>
          <Footer />
        </div>
      </body>
    </html>
  );
}
