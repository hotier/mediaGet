// 站点级配置：集中管理品牌名、联系邮箱、域名等信息
// 修改品牌名/邮箱时只需改这一处，所有页面、页脚、法律页面会同步更新
export const siteConfig = {
  name: "即刻解析",
  domain: "hotier.cc.cd",
  url: "https://get.hotier.cc.cd",

  // 版权 / 权利通知专用邮箱
  // 请替换为真实可收件的邮箱，版权方投诉会发到这里
  copyrightEmail: "contact@hotier.cc.cd",

  // 通用联系邮箱
  contactEmail: "contact@hotier.cc.cd",
} as const;
