/**
 * AiKF 冒烟 mock server (:3000)
 * 浏览器模式走 http://localhost:3000/api/anich 代理，响应 {ok, data} 包装。
 * 提供假 HLS（m3u8 + ts 分段）与假 MP4 直链源，用于播放链路与线路协议 chip 验证。
 */
import http from "node:http";

const IMG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

const bangumiItem = {
  id: 1,
  title: "冒烟测试番剧",
  episode: 12,
  episodesTotal: 12,
  status: "连载中",
  date: 1700000000000,
  image: "/img.png",
  tagline: "mock tagline",
};

const detail = {
  id: 1,
  airdate: 1700000000000,
  title: "冒烟测试番剧",
  titles: ["Smoke Anime"],
  image: "/img.png",
  lang: "日语",
  region: ["日本"],
  genres: ["搞笑", "奇幻"],
  marks: [{ name: "在看", count: 3 }],
  rating: [{ site: "bangumi", score: 7.8, count: 120 }],
  overview: "这是一部用于无头冒烟测试的番剧简介。".repeat(3),
  episode: 12,
  episodesTotal: 12,
  status: "连载中",
};

/** 无资源番剧：验证剧集页「无资源」角标 + 播放器无源态返回键 */
const bangumi2 = {
  id: 2,
  title: "无资源测试番剧",
  episode: 0,
  episodesTotal: 6,
  status: "连载中",
  date: 1700000000000,
  image: "/img.png",
  tagline: "no resources",
};
const detail2 = {
  ...detail,
  id: 2,
  title: "无资源测试番剧",
  titles: ["No Resource Anime"],
  episodesTotal: 6,
};

const M3U8_URL = "http://localhost:3000/fake.m3u8";
const MP4_URL = "http://localhost:3000/fake.mp4";

/** vod：一条 m3u8 线 + 一条 MP4 直链线（adkwai 命名验证优选/协议 chip） */
const vod = {
  sources: [
    { url: M3U8_URL, rawURL: M3U8_URL, caption: "测试M3U8线" },
    { url: MP4_URL, rawURL: MP4_URL, caption: "adkwai直链" },
  ],
};

const m3u8 = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXT-X-TARGETDURATION:4",
  "#EXT-X-MEDIA-SEQUENCE:0",
  ...[0, 1, 2].map((i) => `#EXTINF:4.0,\n/seg${i}.ts`),
  "#EXT-X-ENDLIST",
].join("\n");

function segBuf(i) {
  return Buffer.alloc(220 * 1024, i + 1);
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const json = (res, data) => {
  res.writeHead(200, { "Content-Type": "application/json", ...CORS });
  res.end(JSON.stringify({ ok: true, data }));
};

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost:3000");
  const p = u.pathname;
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (p === "/img.png" || p.endsWith(".jpg")) {
    res.writeHead(200, { "Content-Type": "image/png", ...CORS });
    return res.end(IMG);
  }
  if (p === "/fake.m3u8") {
    res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", ...CORS });
    return res.end(m3u8);
  }
  if (p.startsWith("/seg")) {
    res.writeHead(200, { "Content-Type": "video/mp2t", ...CORS });
    return res.end(segBuf(Number(p.replace(/\D/g, "")) || 0));
  }
  if (p === "/fake.mp4") {
    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": String(3 * 1024 * 1024),
      ...CORS,
    });
    return res.end(Buffer.alloc(3 * 1024 * 1024, 7));
  }
  if (p.startsWith("/api/anich/")) {
    const path = p.replace("/api/anich", "");
    if (path.startsWith("/latest") || path.startsWith("/list"))
      return json(res, {
        items: [
          {
            status: true,
            id: 1,
            episode: 12,
            airdate: 1700000000000,
            duration: 24,
            image: "/img.png",
            title: "冒烟测试番剧",
            name: "冒烟测试番剧 第12话",
          },
        ],
      });
    if (path.startsWith("/search"))
      return json(res, { items: [bangumiItem, bangumi2], prev: 0, next: 0 });
    if (path.startsWith("/detail/2")) return json(res, detail2);
    if (path.startsWith("/detail/")) return json(res, detail);
    if (path.startsWith("/calendar")) return json(res, []);
    if (path.startsWith("/episodes/2"))
      // 无资源番剧：全部集数 status=false（验证「无资源」角标）
      return json(
        res,
        Array.from({ length: 6 }, (_, i) => ({
          status: false,
          sort: i + 1,
          airdate: 1700000000000 + i * 86400000,
          duration: 24,
          sites: [],
          rating: [],
          image: "/img.png",
          title: `第${i + 1}话`,
          overview: "",
        }))
      );
    if (path.startsWith("/episodes/"))
      return json(
        res,
        Array.from({ length: 12 }, (_, i) => ({
          status: true,
          sort: i + 1,
          airdate: 1700000000000 + i * 86400000,
          duration: 24,
          sites: [],
          rating: [],
          image: "/img.png",
          title: i === 0 ? "冒烟第一话" : `第${i + 1}话`,
          overview: "",
        }))
      );
    if (path.startsWith("/related/")) return json(res, []);
    if (path.startsWith("/characters/")) return json(res, []);
    if (path.startsWith("/persons/")) return json(res, []);
    if (path.startsWith("/character/")) return json(res, null);
    if (path.startsWith("/danmaku")) return json(res, { items: [], skip: 0 });
    if (path.startsWith("/vod/2/")) return json(res, { sources: [] }); // 无资源番剧：无可用播放源
    if (path.startsWith("/vod/")) return json(res, vod);
    return json(res, null);
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(3000, () => console.log("[mock] :3000 ready"));
