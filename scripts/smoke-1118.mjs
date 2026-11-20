// 11/18 の直し（祝日は聞かない・週の見通し・だんどり帳の「もうすぐ」・短い使い方）を、手元の Worker で通しで確かめる。
// 架空の家族だけ。本物の LINE には何も送らない。今日の日付で動くので、11/23（月・祝）をはさむ週に回す前提の確かめ方をしている
//   1) node scripts/mock-line.mjs 9999 <記録ファイル>
//   2) npx wrangler dev --port 8791 --persist-to <置き場> --var LINE_CHANNEL_SECRET:local-test-secret --var LINE_CHANNEL_ACCESS_TOKEN:fake-token --var LINE_API_BASE:http://localhost:9999
//   3) node scripts/smoke-1118.mjs <記録ファイル> <置き場> [http://localhost:8791]
// Claude は呼ばない。予定カードは家族の箱（手元の SQLite）に直接入れる
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const log = process.argv[2] ?? "mock-line.jsonl";
const persist = process.argv[3];
const base = process.argv[4] ?? "http://localhost:8791";
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
    events: [{ type: "message", webhookEventId: `evt-1118-${n}-${Date.now()}`, replyToken: `rt-${n}`, source: { type: "group", groupId: group, userId }, message: { id: `m${n}${Date.now()}`, type: "text", text } }],
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


/** 手元の家族の箱（batches のある SQLite）に SQL を流す。前に回した家族の箱が残っていても、いま話している（一番新しく書かれた）箱 */
function familyDb() {
  const dir = readdirSync(join(persist, "v3", "do"), { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.includes("Family"));
  const files = dir
    .flatMap((d) => readdirSync(join(persist, "v3", "do", d.name)).filter((f) => f.endsWith(".sqlite")).map((f) => join(persist, "v3", "do", d.name, f)))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const path of files) {
    const has = execFileSync("sqlite3", [path, "SELECT count(*) FROM sqlite_master WHERE name = 'batches'"]).toString().trim();
    if (has === "1") return path;
  }
  throw new Error("家族の箱が見つからない");
}
const sql = (q) => execFileSync("sqlite3", [familyDb(), q]).toString().trim();

const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
console.log("今日", today);

await send("Upapa", "わたしは パパ");
await send("Umama", "わたしは ママ");
await send("Ubaaba", "わたしは ばあば");

// 架空の予定カード（そうたの遠足・発表会・教材費の締切）
const card = (o) => ({ child: "全員", kind: "行事", title: "", date: null, time: null, place: null, deadline: null, items: [], money: null, who_acts: "未定", confidence: "高", ask: null, ...o });
const cards = [
  card({ child: "そうた", title: "遠足", date: "2026-11-25", items: ["お弁当", "水筒"] }),
  card({ title: "発表会", date: "2026-11-20" }),
  card({ kind: "集金", title: "教材費", deadline: "2026-11-27", money: 1200 }),
];
sql(`INSERT INTO batches (message_id, source, cards, status, created_at) VALUES ('m-smoke', 'ひとこと', '${JSON.stringify(cards).replace(/'/g, "''")}', 'ok', ${Date.now()})`);

// 1 来週の見通し（11/23 は勤労感謝の日）
let r = await send("Umama", "来週の予定");
check(r.said.includes("来週の見通し") && r.said.includes("11/23（月）〜11/29（日）"), "「来週の予定」で来週の見通し", r.said);
check(r.said.includes("決まっていない送り迎え 8つ"), "祝日を除いた平日4日×2 = 8つ", r.said);
check(r.said.includes("勤労感謝の日") && r.said.includes("お休みの日"), "お休みの日に祝日の名前", r.said);
check(r.said.includes("そうた 遠足（お弁当・水筒）"), "行事の行（持ち物つき）", r.said);
check(r.said.includes("教材費 の締切 1,200円"), "締切の行", r.said);
check(r.said.includes("［🙋 まとめて聞く］") && r.said.includes("［📒 だんどり帳］"), "ボタン2つ", r.said);

// 2 ボタンの文で、まとめて聞く（祝日は入れない）
r = await send("Umama", "来週の送り迎え、行ける人いる？");
check(r.said.includes("まとめて聞きます（8件）"), "祝日を除いた8件を聞く", r.said);
check(r.said.includes("11/23（月）は勤労感謝の日なので、入れていません"), "祝日を入れなかったことを返す", r.said);

// 3 まとめての報告（月水金の月が祝日）
r = await send("Umama", "来週の月水金のお迎えはばあば");
check(r.said.includes("✅ お迎え ばあば：11/25（水）・11/27（金）"), "祝日を除いて入れる", r.said);
check(r.said.includes("勤労感謝の日なので、入れていません"), "祝日の1行", r.said);
r = await send("Umama", "来週の見通し");
check(r.said.includes("決まっていない送り迎え 6つ"), "決まった2つが減る", r.said);
r = await send("Upapa", "段取り 来週");
check(r.said.includes("来週の見通し"), "「段取り 来週」でも出る", r.said);
r = await send("Upapa", "今週の予定は？");
check(r.said.includes("今週の見通し"), "「今週の予定は？」で今週", r.said);
check(!r.said.includes("来週の見通し"), "今週を聞いたら来週は出ない", r.said);

// 2b 日付ではっきり言った祝日は聞く。時刻を過ぎた今日の枠は聞かない
r = await send("Upapa", "11/23と11/24のお迎え、行ける人いる？");
check(r.said.includes("11/23（月） 17:30") && r.said.includes("まとめて聞きます（2件）"), "日付で言った祝日は聞く", r.said);
r = await send("Upapa", "今週の送り迎え、行ける人いる？");
const nowHm = new Date(Date.now() + 9 * 3600_000).toISOString().slice(11, 16);
const md = `${Number(today.slice(5, 7))}/${Number(today.slice(8, 10))}`;
const passed = ["07:30", "17:30"].filter((t) => t <= nowHm).map((t) => new RegExp(`${md}（.）\\s*${t}`));
check(passed.every((re) => !re.test(r.said)), `時刻を過ぎた今日の枠は聞かない（いま ${nowHm}）`, r.said);

// 4 日曜の相乗り：待っている見通しは、次の返事のときに作り直して出る（月曜以降なら「今週」）
sql(`INSERT OR REPLACE INTO later (kind, payload, created_at, expires_at) VALUES ('weekahead:2026-11-23', '[{"type":"text","text":"（週の見通し）"}]', ${Date.now()}, ${Date.now() + 86400000})`);
r = await send("Upapa", "予定 見せて");
check(r.said.includes("来週の見通し") && !r.said.includes("（週の見通し）"), "相乗りの見通しは作り直して出る", r.said);
check(r.said.includes("わが家のだんどり帳"), "頼んだ返事も一緒に出る", r.said);
check(sql("SELECT count(*) FROM later WHERE kind LIKE 'weekahead:%'") === "0", "出したら消える");

// 5 使い方は短く
r = await send("Umama", "使い方");
const howto = r.said.split("\n").filter((l) => /^(📷|🚗|🤒|📅|🌱|🙏)/.test(l));
check(howto.length === 6 && r.said.includes("ふだんの言葉で"), "使い方は6行", r.said);

// 6 だんどり帳：祝日の名前・「もうすぐ」
const uri = /<(http[^>]+\/c\/[A-Za-z0-9]+)>/.exec((await send("Umama", "予定 見せて")).said)?.[1];
const page = await (await fetch(uri.replace("https://kazoku-dandori.dandori.workers.dev", base) + "?view=month&anchor=2026-11-23")).text();
check(page.includes("🎉 もうすぐ") && page.includes("<b>遠足</b>まで あと"), "「もうすぐ」に遠足", "");
check(page.includes('class="hol">勤労感謝の日'), "週の見出しに祝日の名前", "");
check(page.includes('title="勤労感謝の日"'), "月の升の日付に祝日", "");
const ghost23 = /data-slot-date="2026-11-23"[^>]*ghost|ghost[^>]*data-slot-date="2026-11-23"/.test(page);
check(!ghost23, "祝日には直す画面の空き札を出さない", "");
const ghost24 = /data-slot-date="2026-11-30" data-slot-kind/.test(page);
check(ghost24, "平日には空き札を出す", "");

console.log(fail === 0 ? "\nALL PASS" : `\nFAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
