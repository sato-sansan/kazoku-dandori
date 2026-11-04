// 11/4 に家族のグループで動かなかったやり取りを、架空の家族（はると・ゆい・そうた・めい）で流し直す。
// 手元の Worker（wrangler dev）を偽の LINE の窓口（scripts/mock-line.mjs）に向けて使う。本物の LINE には何も送らない。
//   1) node scripts/mock-line.mjs 9999 <記録ファイル>
//   2) npx wrangler dev --port 8787 --var LINE_CHANNEL_SECRET:local-test-secret --var LINE_CHANNEL_ACCESS_TOKEN:fake-token --var LINE_API_BASE:http://localhost:9999
//   3) node scripts/replay-1104.mjs <記録ファイル>
// 見るもの：返事が1回の返信で来る・プッシュ0通・同じ問いを繰り返さない・決まった報告がその場で枠に入る
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const log = process.argv[2] ?? "mock-line.jsonl";
const base = "http://localhost:8787";
const secret = "local-test-secret";
const group = `Creplay${Date.now() % 1000000}`;
let n = 0;
let failed = 0;

const lines = () =>
  readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

/** 返事の文（Flex は altText）を1つの文字列に */
const textOf = (messages) =>
  messages
    .map((m) => (m.type === "text" || m.type === "textV2" ? m.text : m.type === "flex" ? `[札] ${m.altText}` : `[${m.type}]`))
    .join("\n---\n");

async function send(userId, text, { mentionSelf = false, expectReply = true } = {}) {
  n += 1;
  const replyToken = `rt-${group}-${n}`;
  const message = { id: `m${n}${Date.now()}`, type: "text", text };
  if (mentionSelf) {
    const at = "@だんどりさん";
    message.mention = { mentionees: [{ index: text.indexOf(at), length: at.length, type: "user", isSelf: true }] };
  }
  const body = JSON.stringify({
    destination: "U0",
    events: [{ type: "message", webhookEventId: `evt-${group}-${n}`, replyToken, source: { type: "group", groupId: group, userId }, message }],
  });
  const sig = createHmac("sha256", secret).update(body).digest("base64");
  const res = await fetch(`${base}/line/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "x-line-signature": sig }, body });
  if (res.status !== 200) throw new Error(`webhook ${res.status}`);
  // 返事を待つ（読み取りは Claude を呼ぶので最大2分）
  const until = Date.now() + (expectReply ? 120_000 : 8_000);
  while (Date.now() < until) {
    const hit = lines().find((l) => l.kind === "reply" && l.replyToken === replyToken);
    if (hit) return { text: textOf(hit.messages), messages: hit.messages };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { text: "", messages: [] };
}

function check(name, ok, detail = "") {
  if (!ok) failed += 1;
  console.log(`${ok ? "OK" : "NG"}  ${name}${ok ? "" : `\n      ${detail.replace(/\n/g, "\n      ")}`}`);
}

function show(who, said, r) {
  console.log(`\n▶ ${who}「${said.replace(/\n/g, " / ")}」\n${r.text ? r.text.replace(/^/gm, "   ") : "   （返事なし）"}`);
}

async function step(who, userId, said, opts) {
  const r = await send(userId, said, opts);
  show(who, said, r);
  return r;
}

// ほかの試験の家族の予約（手元に残っている箱）もプッシュするので、この家族あてだけ数える
const ours = (l) => l.kind === "push" && l.to === group;
const pushesBefore = lines().filter(ours).length;
await fetch("http://localhost:9999/__used", { method: "POST", body: "195" });

await step("パパ", "Upapa", "わたしは パパ");
await step("ママ", "Umama", "わたしは ママ");
await step("ばあば", "Ubaaba", "わたしは ばあば");

// ① 決まった報告（11/4 は読み取りに回って「明日は11/5でよいですか？」が何往復も続いた）
let r = await step("パパ", "Upapa", "28日土曜お迎え パパ\nさくら遅番");
check("28日のお迎えがパパに決まる", /11\/28（土）.*お迎えは パパ/.test(r.text), r.text);
r = await step("パパ", "Upapa", "明日5時迎えばーばになりました @だんどりさん", { mentionSelf: true });
check("明日17:00のお迎えがばあばに決まる（5時＝17時）", /明日 17:00、保育所3人のお迎えは ばあば/.test(r.text), r.text);
check("問い返さない", !/ですか？|でよいですか/.test(r.text), r.text);
r = await step("パパ", "Upapa", "ばあばは明日の17時お迎えです入れておいて");
check("同じ報告2回目も1行で返す", /明日 17:00、保育所3人のお迎えは ばあば/.test(r.text) && r.messages.length === 1, r.text);

// ② 全員お休み（11/4 は「どのお子さんのお休みですか？」が4回続いた）
r = await step("パパ", "Upapa", "子供園だよりはきょうのかれんだーにいれて\n16日は全員お休みだからお迎えなし。");
check("16日は全員お休み・送迎は聞かない", /11\/16（月）は全員お休み/.test(r.text) && !/どのお子さん/.test(r.text), r.text);
r = await step("ママ", "Umama", "5日のことに関しては私は何も言っていません。\nそこはパパが言った通りでいいので16日を全員休み、家庭の都合としてください");
check("家庭の都合の連絡文が保育所あてに出る", /保育所/.test(r.text) && /家庭の都合/.test(r.text) && !/どのお子さん/.test(r.text), r.text);
r = await step("パパ", "Upapa", "休みの連絡 11/16 全員");
check("［連絡文を作る］の文でも作れる", /保育所/.test(r.text) && /ゆい・そうた・めい/.test(r.text), r.text);

// ③ ファミサポ（11/4 は家族に「行ける人？」が出て、時刻を何度も聞き直した）
r = await step("パパ", "Upapa", "段取り 明日");
check("明日の聞き取り：お迎え（ばあば決定）は聞かない", !/お迎え、行ける人/.test(r.text) && /送り、行ける人/.test(r.text), r.text);
r = await step("ママ", "Umama", "5日、保育所3人はファミサポにお迎え頼みました。");
check("お迎えはファミサポ・家族に聞かない", /お迎えは ファミサポ/.test(r.text), r.text);
r = await step("ママ", "Umama", "ちがう\n\nファミサポは18:30迎えです");
check("続きの「18:30」をそのまま入れる", /18:30、保育所3人のお迎えは ファミサポ/.test(r.text) && !/ですか？/.test(r.text), r.text);
r = await step("パパ", "Upapa", "段取り 明日");
check("ファミサポの日はお迎えを聞かない", !/お迎え、行ける人/.test(r.text), r.text);

// ④ お便りの読み取り：返事は短く・きょうだいは1行に・聞き返しは1回まで
r = await step(
  "ママ",
  "Umama",
  "保育所からのお知らせです。11月10日（火）歯科健診、11月11日（水）誕生会、11月12日（木）内科健診。11月27日（金）はお迎えの時に布団を持ち帰ってください。保育参観の日にちは後日お知らせします。",
);
const lineCount = r.text.split("\n---\n")[0].split("\n").filter(Boolean).length;
check("お便りの返事が8行以内", lineCount <= 8, r.text);
check("きょうだいの同じ予定は1行（ゆい・そうた・めい）", /ゆい・そうた・めい|全員/.test(r.text), r.text);
check("「承知しました」のような約束を書かない", !/承知/.test(r.text), r.text);
if (/ですか？|でしょうか/.test(r.text)) {
  r = await step("ママ", "Umama", "ちがう");
  check("「ちがう」だけなら正しい形を聞く（読み直さない）", /正しくは/.test(r.text), r.text);
  r = await step("ママ", "Umama", "保育参観はありません");
  check("答えのあとは聞き返さない（1回まで）", !/ですか？|でしょうか/.test(r.text) && /OK/.test(JSON.stringify(r.messages)), r.text);
}
const ok = JSON.stringify(r.messages).match(/OK #(\d+)/);
if (ok) {
  r = await step("ママ", "Umama", `OK #${ok[1]}`);
  check("［OK］で予定に入る", /予定に入れました/.test(r.text), r.text);
}

// ④' 聞き返しの流れ：問いは1回まで。「ちがう」だけなら正しい形を聞き、答えのあとは［OK］［直す］
r = await step("ママ", "Umama", "来週の月曜に遠足があります。お弁当と水筒を持ってきてください。");
check("遠足：問いは1つだけ", (r.text.match(/？/g) ?? []).length <= 1, r.text);
if (/？/.test(r.text)) {
  r = await step("ママ", "Umama", "ちがう");
  check("「ちがう」だけなら正しい形を聞く（読み直さない）", /正しくは/.test(r.text), r.text);
  r = await step("ママ", "Umama", "11/16です");
  check("答えのあとは聞き返さない", !/？/.test(r.text) && /OK #/.test(JSON.stringify(r.messages)), r.text);
  check("答えのあとは変わった予定だけ（1〜2行）", r.text.split("\n").filter(Boolean).length <= 2, r.text);
}
r = await step("パパ", "Upapa", "12/5(土)に生活発表会があります。開始時刻はまだ分かりません。");
if (/？/.test(r.text)) {
  r = await step("パパ", "Upapa", "はい");
  check("「はい」のあとは聞き返さない", !/？/.test(r.text), r.text);
}

// ⑤ 白紙にして
r = await step("パパ", "Upapa", "学童から：12月の土曜開所日の申込は11/20まで。");
r = await step("パパ", "Upapa", "これは一旦全部白紙にして");
check("確かめ中の内容を消す", /消しました/.test(r.text), r.text);

// ⑦ 11/5 朝の言い方：済んだ日の直し・「AではなくB」・読み違いの取り消し
// （11/5 7:31：「4日のお迎えはママでした」を 12/4 のこととして入れた。名前が2つ並ぶ直しには黙った）
r = await step("ママ", "Umama", "昨日のお迎えはばぁばではなくママでした");
check("済んだ日の直し：昨日のお迎えはママ（ありがとうの促しは出さない）", /✅ .*お迎えは ママ/.test(r.text) && !/をどうぞ/.test(r.text), r.text);
r = await step("パパ", "Upapa", "明日のお迎えはばあばではなくじいじです");
check("決まっていた人を直す：（ばあばから直しました）", /お迎えは じいじ（ばあばから直しました）/.test(r.text), r.text);
const tmr = new Date(Date.now() + 9 * 3600_000 + 86_400_000);
r = await step("パパ", "Upapa", `${tmr.getUTCMonth() + 1}/${tmr.getUTCDate()}のお迎え 取り消し`);
check("「○/○のお迎え 取り消し」で決まった枠を戻す", /取り消しました/.test(r.text), r.text);
r = await step("パパ", "Upapa", "段取り 明日");
check("取り消した枠は、また家族に聞く", /お迎え、行ける人/.test(r.text), r.text);
// 札の［ファミサポなど］（11/5 パパ「その他の項目も作って ファミサポとかもあるらしい」）
const other = JSON.stringify(r.messages).match(/お迎え引受 #(\d+) ほか/);
check("札に［ファミサポなど］がある", !!other, r.text);
if (other) {
  r = await step("ママ", "Umama", other[0]);
  check("［ファミサポなど］で、家族には聞かない枠になる", /家族以外（ファミサポなど）/.test(r.text), r.text);
  r = await step("パパ", "Upapa", "段取り 明日");
  check("ファミサポなどにした枠は、もう聞かない", !/お迎え、行ける人/.test(r.text), r.text);
}

// ⑥ 数字と送信数
r = await step("パパ", "Upapa", "段取り 数字");
check("LINE の残りが出る", /LINE の今月の残り：5通/.test(r.text), r.text);
const pushes = lines().filter(ours).length - pushesBefore;
check("プッシュは0通（全部返信）", pushes === 0, `push ${pushes}`);

console.log(`\n${failed === 0 ? "ALL PASS" : `FAIL ${failed}`}  group=${group}`);
process.exit(failed === 0 ? 0 : 1);
