import type { Metadata } from "next";
import { Card } from "@/components/ui/card";
import { HelpCircle } from "lucide-react";
import FaqList from "@/components/FaqList";
import { FAQS } from "@/config/faqs";
import { siteConfig } from "@/config/site";

export const metadata: Metadata = {
  title: "常见问题",
  description: `关于${siteConfig.name}视频解析的常见问题：支持哪些平台、是否带水印、是否需要登录、解析失败如何处理等。`,
  robots: { index: true, follow: true },
  alternates: { canonical: `${siteConfig.url}/faq` },
};

export default function FaqPage() {
  return (
    <>
      {/* Morphing Background（与首页一致） */}
      <div className="morphing-bg">
        <div className="orb orb-1" />
        <div className="orb orb-2" />
        <div className="orb orb-3" />
      </div>

      <div className="relative" style={{ zIndex: 1 }}>
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-12 sm:py-16">
          <header className="mb-8">
            <h1 className="flex items-center gap-2 text-2xl sm:text-3xl font-bold tracking-tight">
              <HelpCircle className="h-7 w-7 text-accent" />
              常见问题
            </h1>
            <p className="mt-3 text-sm text-muted max-w-md">
              关于视频解析下载的常见疑问，点击问题展开查看解答。
            </p>
          </header>

          <Card className="p-5 sm:p-6">
            <FaqList />
          </Card>
        </div>
      </div>

      {/* FAQ 结构化数据（SEO） */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: [
              {
                "@type": "Question",
                name: "短视频怎么去水印下载？",
                acceptedAnswer: {
                  "@type": "Answer",
                  text: "复制视频分享链接或完整分享文案，粘贴到即刻解析输入框，点击解析即可获得无水印视频下载地址，全程免费在线使用，无需安装软件。",
                },
              },
              {
                "@type": "Question",
                name: "支持哪些平台的视频解析？",
                acceptedAnswer: {
                  "@type": "Answer",
                  text: `支持 ${FAQS[0].a}`,
                },
              },
              {
                "@type": "Question",
                name: "解析失败怎么办？",
                acceptedAnswer: {
                  "@type": "Answer",
                  text: `部分视频受平台风控或地区限制可能暂时无法解析，可更换网络环境后重试；如仍失败，可通过${siteConfig.contactEmail}联系站长反馈链接。`,
                },
              },
            ],
          }),
        }}
      />
    </>
  );
}
