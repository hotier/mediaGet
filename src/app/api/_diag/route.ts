// 临时诊断端点：验证 Next.js 运行时下抖音 user 主页请求是否可用
// 用完即删
/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from "next/server";

const WEB_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";

function extractTtwid(response: Response): string {
  const raw = response.headers.get("set-cookie") || "";
  const m = raw.match(/ttwid=([^;]+)/);
  return m ? `ttwid=${m[1]}` : "";
}

function tryParse(html: string) {
  const m = html.match(/<script id="_ROUTER_DATA"[^>]*>([\s\S]*?)<\/script>/);
  if (m) {
    try {
      return JSON.parse(m[1]);
    } catch {}
  }
  const r = html.match(/<script id="RENDER_DATA"[^>]*>([\s\S]*?)<\/script>/);
  if (r) {
    try {
      return JSON.parse(decodeURIComponent(r[1]));
    } catch {}
  }
  return null;
}

export async function GET(request: NextRequest) {
  const secUid = request.nextUrl.searchParams.get("sec_uid") || "";
  if (!secUid) {
    return NextResponse.json({ ok: false, msg: "missing sec_uid" });
  }

  const report: Record<string, unknown> = {};

  // 1) 短链拿 ttwid
  const res = await fetch("https://v.douyin.com/hYC-GrlrVrM/", {
    headers: { "User-Agent": WEB_UA, Accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
    signal: AbortSignal.timeout(10000),
  });
  const ttwid = extractTtwid(res);
  report.ttwid = ttwid ? "有" : "无";

  // 2) user 主页请求
  const urls = [
    `https://www.douyin.com/user/${secUid}`,
    `https://www.iesdouyin.com/share/user/${secUid}`,
  ];
  for (const u of urls) {
    try {
      const r = await fetch(u, {
        headers: { "User-Agent": WEB_UA, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", Cookie: ttwid },
        signal: AbortSignal.timeout(8000),
      });
      const h = await r.text();
      const p = tryParse(h);
      const loader = (p?.loaderData || {}) as Record<string, any>;
      let user: any = null;
      for (const k of Object.keys(loader)) {
        const v = loader[k]?.user || loader[k]?.userInfo?.user;
        if (v?.sec_uid === secUid) {
          user = v;
          break;
        }
      }
      report[u.slice(0, 60)] = user
        ? {
            nickname: user.nickname,
            follower_count: user.follower_count,
            following_count: user.following_count,
            total_favorited: user.total_favorited,
          }
        : p
          ? { hasData: true, loaderKeys: Object.keys(loader), noUser: true }
          : {
              hasData: false,
              len: h.length,
              risk: /argus|_\$jsvmprt/.test(h),
              snippet: h.replace(/\s+/g, " ").slice(0, 120),
            };
    } catch (e: any) {
      report[u.slice(0, 60)] = { error: e.message };
    }
  }

  return NextResponse.json({ ok: true, ...report });
}
