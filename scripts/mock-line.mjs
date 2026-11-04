// 手元の試験用の「偽の LINE の窓口」。返信・プッシュの中身を1行ずつ記録し、送信数の残りも偽物で返す。
// 本物の LINE には何も送らない。
//   使い方: node scripts/mock-line.mjs [port] [記録ファイル]
//   wrangler dev に --var LINE_API_BASE:http://localhost:9999 を付けて、Worker をここに向ける
//   残りを変える: curl -X POST localhost:9999/__used -d 195   （今月使った数）
import { createServer } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";

const port = Number(process.argv[2] ?? 9999);
const log = process.argv[3] ?? "mock-line.jsonl";
let used = 0;
const LIMIT = 200;
writeFileSync(log, "");

// 偽の家族の表示名（「さくらに頼んで」の試験用）。本物の名前ではない
const NAMES = { Upapa: "ひろし", Umama: "さくら", Ubaaba: "よし子", Ujiiji: "ただし" };

createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const json = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  const record = (kind, extra) => appendFileSync(log, JSON.stringify({ kind, ...extra }) + "\n");

  if (p === "/__used") {
    used = Number(body || 0);
    return json(200, { used });
  }
  if (p === "/v2/bot/message/reply") {
    const b = JSON.parse(body);
    record("reply", { replyToken: b.replyToken, messages: b.messages });
    return json(200, {});
  }
  if (p === "/v2/bot/message/push") {
    const b = JSON.parse(body);
    // グループは3人として数える（だんどりさんは数えない）
    const cost = String(b.to).startsWith("U") ? 1 : 3;
    if (used + cost > LIMIT) {
      record("push_rejected", { to: b.to, cost });
      return json(429, { message: "You have reached your monthly limit." });
    }
    used += cost;
    record("push", { to: b.to, cost, used, messages: b.messages });
    return json(200, {});
  }
  if (p === "/v2/bot/message/quota") return json(200, { type: "limited", value: LIMIT });
  if (p === "/v2/bot/message/quota/consumption") return json(200, { totalUsage: used });
  let m = /^\/v2\/bot\/(group|room)\/[^/]+\/members\/count$/.exec(p);
  if (m) return json(200, { count: 3 });
  m = /^\/v2\/bot\/(group|room)\/[^/]+\/member\/([^/]+)$/.exec(p);
  if (m) return NAMES[m[2]] ? json(200, { displayName: NAMES[m[2]], userId: m[2] }) : json(404, {});
  if (p.startsWith("/v2/bot/richmenu")) return json(200, { richMenuId: "richmenu-mock" });
  if (p.endsWith("/content")) return json(404, {});
  if (p.startsWith("/v2/bot/chat/loading")) return json(202, {});
  record("unknown", { path: p });
  return json(404, {});
}).listen(port, () => console.log(`mock LINE on ${port} -> ${log}`));
