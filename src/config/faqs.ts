import { VIDEO_PLATFORMS } from "@/config/video-platforms";
import { siteConfig } from "@/config/site";

// 平台名称单一数据源：从配置读取，避免与代码脱节
const PLATFORM_NAMES = Object.values(VIDEO_PLATFORMS).map((p) => p.name);

// FAQ 数据单一数据源：/faq 页面展示与 FAQPage JSON-LD 共用
// 注意：此文件为纯数据模块（无 "use client"），可同时被服务端/客户端组件引用
export const FAQS = [
  {
    q: "支持哪些平台？",
    a: `目前已支持 ${PLATFORM_NAMES.join("、")} 等 ${PLATFORM_NAMES.length}+ 个国内外平台，并持续增加中。`,
  },
  {
    q: "解析出来的视频 / 图片带水印吗？",
    a: "本工具会自动提取去水印后的原画地址，多数平台可得到无水印资源；个别平台受接口限制可能仍为原画，请以解析结果为准。",
  },
  {
    q: "需要登录或安装软件吗？",
    a: `无需安装任何软件，也无需注册登录。打开${siteConfig.name}，粘贴链接即可免费解析下载。`,
  },
  {
    q: "粘贴链接后提示解析失败怎么办？",
    a: "请确认链接是从 App「分享」复制的完整链接；部分内容因作者设置权限或已删除会无法解析，可切换具体平台后重试。",
  },
  {
    q: "可以同时解析多个链接吗？",
    a: "可以。在输入框中每行粘贴一个链接，系统会依次解析并逐条展示结果。",
  },
];
