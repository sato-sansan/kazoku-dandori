// 11/17 の直し（子どもの呼び名・まとめての頼み・だんどり帳の編集）を、手元の Worker で通しで確かめる。架空の家族だけ。本物の LINE には何も送らない。
//   1) node scripts/mock-line.mjs 9999 <記録ファイル>
//   2) npx wrangler dev --port 8791 --persist-to <置き場> --var LINE_CHANNEL_SECRET:local-test-secret --var LINE_CHANNEL_ACCESS_TOKEN:fake-token --var LINE_API_BASE:http://localhost:9999
//   3) node scripts/smoke-1117.mjs <記録ファイル> [http://localhost:8791]
// Claude は呼ばない（呼ぶ言い方を使わない）
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const log = process.argv[2] ?? "mock-line.jsonl";
const base = process.argv[3] ?? "http://localhost:8791";
const secret = "local-test-secret";
const group = `Csmoke${Date.now() % 1000000}`;
let n = 0;
let fail = 0;
const check = (ok, label, detail = "") => {
  if (!ok) fail++;
  console.log(ok ? "OK  " : "NG  ", label, ok ? "" : detail);
};
const lines = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const flexText = (node) =>
  !node || typeof node !== "object"
    ? []
    : [
        ...(node.type === "text" && node.text ? [node.text] : []),
        ...(node.action?.label ? [`［${node.action.label}］`] : []),
        ...(node.action?.uri ? [`<${node.action.uri}>`] : []),
        ...(Array.isArray(node.contents) ? node.contents.flatMap(flexText) : node.contents ? flexText(node.contents) : []),
        ...["header", "hero", "body", "footer"].flatMap((k) => (node[k] ? flexText(node[k]) : [])),
      ];
const textOf = (messages) =>
  messages
    .map((m) => {
      const body = m.type === "text" ? m.text : m.type === "flex" ? `[札] ${m.altText} / ${flexText(m.contents).join(" / ")}` : `[${m.type}]`;
      const qr = (m.quickReply?.items ?? []).map((i) => `［${i.action.label}］`).join("");
      return qr ? `${body} ${qr}` : body;
    })
    .join("\n");

async function send(userId, text, wait = 8000) {
  n += 1;
  const before = lines().length;
  const body = JSON.stringify({
    destination: "U0",
    events: [{ type: "message", webhookEventId: `evt-1117-${n}-${Date.now()}`, replyToken: `rt-${n}`, source: { type: "group", groupId: group, userId }, message: { id: `m${n}${Date.now()}`, type: "text", text } }],
  });
  const sig = createHmac("sha256", secret).update(body).digest("base64");
  await fetch(`${base}/line/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "x-line-signature": sig }, body });
  // 返事は家族の箱のアラームの中で出る。届くまで待つ（届かない言い方は wait まで）
  const start = Date.now();
  let out = [];
  while (Date.now() - start < wait) {
    await new Promise((r) => setTimeout(r, 300));
    out = lines().slice(before).filter((l) => l.kind === "reply" || l.kind === "push");
    if (out.length > 0) break;
  }
  const said = out.map((l) => textOf(l.messages)).join("\n");
  console.log(`\n▶ ${text}\n${said}`);
  return { said, out };
}

async function edit(token, body, headers = {}) {
  const res = await fetch(`${base}/c/${token}/edit`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base, ...headers }, body: JSON.stringify(body) });
  const json = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  console.log(`  POST ${JSON.stringify(body)} → ${res.status} ${json ? json.message : ""}`);
  return { status: res.status, json };
}

await send("Upapa", "わたしは パパ");
await send("Umama", "わたしは ママ");
await send("Ubaaba", "わたしは ばあば");

// 1 子どもの呼び名を変える（見本の家族の呼び名で試す）
let r = await send("Umama", "子どもの名前 ゆい→ゆいか");
check(r.said.includes("✅ 子どもの呼び名を変えました：ゆい→ゆいか"), "呼び名を変える（LINE）", r.said);
r = await send("Umama", "子どもの名前 そうた → そうちゃん");
check(r.said.includes("そうた→そうちゃん"), "矢印の前後に空白があっても変えられる", r.said);
r = await send("Umama", "子どもの名前 そうちゃん→はる");
check(r.said.includes("重なります"), "ほかの子の呼び名と重なる呼び名は断る", r.said);
r = await send("Umama", "子どもの名前 そうちゃん→そうた");
r = await send("Umama", "子どもの名前 さくら→もも");
check(r.said.includes("どの子か分かりませんでした"), "知らない呼び名は変えない", r.said);
// 前の呼び名でも同じ子として読む（休みの連絡のボタンの道）
r = await send("Umama", "休みの連絡");
check(r.said.includes("［ゆいか］") && !r.said.includes("［ゆい］"), "休みの連絡の子のボタンが新しい呼び名", r.said);
r = await send("Umama", "ゆい");
check(r.said.includes("理由は？"), "前の呼び名を押しても（打っても）同じ子として進む", r.said);
await send("Umama", "やめる");

// 2 予定（全員お休み）を1枚つくる → だんどり帳で消す用
r = await send("Umama", "12/16は全員お休みだからお迎えなし。");
check(r.said.includes("全員お休み"), "全員お休み（1日）はふだんどおり", r.said);

// 3 まとめての報告
r = await send("Umama", "来週の月水金のお迎えはばあば、火木はパパ");
check(/✅ お迎え ばあば：.+・.+・/.test(r.said) && /✅ お迎え パパ：/.test(r.said) && r.said.includes("［↩️ 取り消す］"), "まとめての報告：担当ごとに1行・取り消すボタン", r.said);
// 4 まとめての「行ける人？」
r = await send("Umama", "来週の送り、行ける人いる？");
const bubbles = r.out.flatMap((l) => l.messages).filter((m) => m.type === "flex" && m.contents?.type === "carousel").map((m) => m.contents.contents.length)[0];
check(bubbles === 5 && r.said.includes("まとめて聞きます（5件）") && !r.said.includes("［ママ］"), "まとめて聞く：5日ぶんの札を1通・頼んだママのボタンは出ない", `bubbles=${bubbles} ${r.said}`);
// 1日だけの報告はふだんどおり
r = await send("Upapa", "明後日のお迎えはじいじになりました");
check(/✅ .+のお迎えは じいじ。/.test(r.said), "1日だけの報告はふだんどおり", r.said);

// 5 だんどり帳
r = await send("Umama", "予定 見せて");
const token = /\/c\/([a-z0-9]{10})>/.exec(r.said)?.[1];
check(!!token, "だんどり帳の合言葉", r.said);
const ics = /［Googleカレンダー用URLをコピー］/.test(r.said) ? r.out.flatMap((l) => l.messages).flatMap((m) => JSON.stringify(m).match(/\/i\/[a-z0-9]{10}\.ics/g) ?? [])[0] : null;
check(!!ics && !ics.includes(token), "Google カレンダー用の URL は別の合言葉", String(ics));
const feed = await fetch(`${base}${ics}`);
check(feed.status === 200 && (await feed.text()).includes("BEGIN:VCALENDAR"), "購読 URL で予定が読める");
const icsToken = /\/i\/([a-z0-9]{10})/.exec(ics ?? "")?.[1];
let res0 = await fetch(`${base}/c/${icsToken}/edit`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ action: "removePhoto", id: 1 }) });
check(res0.status === 404, "購読 URL の合言葉では直せない（404）");
res0 = await fetch(`${base}/c/${icsToken}`);
check(res0.status === 404, "購読 URL の合言葉ではだんどり帳も開けない（404）");
let page = await (await fetch(`${base}/c/${token}?view=week&anchor=2026-12-16`)).text();
check(page.includes("ゆいか") && page.includes("だんどり帳を直す") && page.includes('data-del-card="'), "だんどり帳：新しい呼び名・直すボタン・消すボタン");
// 先の送迎の担当を選ぶ（4週ぶん）
const [y, m, d] = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).split("-").map(Number);
const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
const nextTue = new Date(Date.UTC(y, m - 1, d + ((2 - wd + 7) % 7 || 7) + 7)).toISOString().slice(0, 10); // 再来週の火曜
let e = await edit(token, { action: "slot", date: nextTue, kind: "送り", who: "じいじ", weeks: 4 });
check(e.status === 200 && e.json.ok && e.json.message.includes("4週ぶん"), "だんどり帳：先の送りを4週ぶん じいじ", JSON.stringify(e.json));
e = await edit(token, { action: "slot", date: nextTue, kind: "送り", who: null });
check(e.json?.ok && e.json.message.includes("未定に戻しました"), "だんどり帳：未定に戻す", JSON.stringify(e.json));
e = await edit(token, { action: "slot", date: "2026-13-01", kind: "送り", who: "パパ" });
check(e.status === 200 && e.json && !e.json.ok, "無い日付は 500 にせず断る", JSON.stringify(e.json));
e = await edit(token, { action: "slot", date: "2020-01-01", kind: "送り", who: "パパ" });
check(e.json && !e.json.ok, "過ぎた日は変えない", JSON.stringify(e.json));
// 予定を消す
const ref = /data-del-card="([^"]+)"/.exec(page)?.[1];
e = await edit(token, { action: "removeCard", ref });
check(e.json?.ok, "だんどり帳：予定を消す", JSON.stringify(e.json));
e = await edit(token, { action: "removeCard", ref });
check(e.json && !e.json.ok, "同じ予定を2回は消さない", JSON.stringify(e.json));
e = await edit(token, { action: "removePhoto", id: 99999 });
check(e.json && !e.json.ok, "無い写真は消さない", JSON.stringify(e.json));
page = await (await fetch(`${base}/c/${token}?view=week&anchor=2026-12-16`)).text();
check(!page.includes(`data-del-card="${ref}"`), "消した予定はだんどり帳に出ない");
// 呼び名をページから戻す
e = await edit(token, { action: "rename", pairs: [{ from: "ゆいか", to: "ゆい" }] });
check(e.json?.ok, "だんどり帳：呼び名を変える", JSON.stringify(e.json));
// よそからの書き込みは断る
e = await edit(token, { action: "removeCard", ref: "1:0" }, { Origin: "https://evil.example" });
check(e.status === 403, "よそのサイトからの書き込みは 403");
let res = await fetch(`${base}/c/${token}/edit`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
check(res.status === 403, "JSON でない書き込みは 403");
res = await fetch(`${base}/c/${token}/edit`);
check(res.status === 405, "GET の /edit は 405");
res = await fetch(`${base}/c/zzzzzzzzzz/edit`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: "{}" });
check(res.status === 404, "知らない合言葉は 404");

console.log(`\ngroup=${group}`);
console.log(fail === 0 ? "ALL PASS" : `FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
