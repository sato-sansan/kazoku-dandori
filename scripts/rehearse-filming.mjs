// 撮影（11/6〜7）の台本どおりに、手元の Worker を通しで動かす稽古。架空の家族だけ。本物の LINE には何も送らない。
// 台本は docs の外（撮影の手順書）の S1〜S7。押すボタンは、返ってきた札・ボタンの中から探して押す（台本の文を決め打ちしない）
//   1) node scripts/mock-line.mjs 9999 <記録ファイル>
//   2) npx wrangler dev --port 8787 --var LINE_CHANNEL_SECRET:local-test-secret --var LINE_CHANNEL_ACCESS_TOKEN:fake-token --var LINE_API_BASE:http://localhost:9999
//   3) node scripts/rehearse-filming.mjs <記録ファイル> [画面の文を書き出すファイル]
// 見るもの：場面ごとに台本の「画面に出るもの」が出るか・プッシュは S3 の1回だけか
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const log = process.argv[2] ?? "mock-line.jsonl";
const transcriptFile = process.argv[3] ?? null;
const base = "http://localhost:8787";
const secret = "local-test-secret";
const group = `Cdemo${Date.now() % 1000000}`;
let n = 0;
let failed = 0;
const transcript = [];

const lines = () =>
  readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

/** 返事の文（Flex は altText と中の文字）を1つの文字列に */
function textOf(messages) {
  const flexText = (node) =>
    !node || typeof node !== "object"
      ? []
      : [
          ...(node.type === "text" && node.text ? [node.text] : []),
          ...(node.action?.label ? [`［${node.action.label}］`] : []),
          ...(Array.isArray(node.contents) ? node.contents.flatMap(flexText) : node.contents ? flexText(node.contents) : []),
          ...["header", "hero", "body", "footer"].flatMap((k) => (node[k] ? flexText(node[k]) : [])),
        ];
  return messages
    .map((m) => {
      const body = m.type === "text" || m.type === "textV2" ? m.text : m.type === "flex" ? `[札] ${m.altText}\n${flexText(m.contents).join(" / ")}` : `[${m.type}]`;
      const qr = (m.quickReply?.items ?? []).map((i) => `［${i.action.label}］`).join("");
      return qr ? `${body}\n${qr}` : body;
    })
    .join("\n---\n");
}

/** 返事の中の押せるもの（クイックリプライと Flex のボタン）。{label, text, type} */
function actionsOf(messages) {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.action && typeof node.action === "object") out.push({ ...node.action });
    for (const v of Object.values(node)) if (v && typeof v === "object") walk(v);
  };
  for (const m of messages) {
    for (const i of m.quickReply?.items ?? []) out.push({ ...i.action });
    if (m.type === "flex") walk(m.contents);
  }
  return out;
}

const press = (messages, re) => actionsOf(messages).find((a) => a.type === "message" && re.test(a.text ?? ""));

async function post(events) {
  const body = JSON.stringify({ destination: "U0", events });
  const sig = createHmac("sha256", secret).update(body).digest("base64");
  const res = await fetch(`${base}/line/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "x-line-signature": sig }, body });
  if (res.status !== 200) throw new Error(`webhook ${res.status}`);
}

async function waitReply(replyToken, ms = 120_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const hit = lines().find((l) => l.kind === "reply" && l.replyToken === replyToken);
    if (hit) return { text: textOf(hit.messages), messages: hit.messages };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { text: "", messages: [] };
}

/** だれかが送る。chat="group" はグループ、"1on1" はだんどりさんとの1対1 */
async function say(who, userId, text, { chat = "group", image = null } = {}) {
  n += 1;
  const replyToken = `rt-${group}-${n}`;
  const source = chat === "group" ? { type: "group", groupId: group, userId } : { type: "user", userId };
  const message = image ? { id: `img-${image}-${group}-${n}`, type: "image" } : { id: `m${n}${Date.now()}`, type: "text", text };
  await post([{ type: "message", webhookEventId: `evt-${group}-${n}`, replyToken, source, message }]);
  const r = await waitReply(replyToken);
  const said = image ? `（写真 ${image}）` : text;
  console.log(`\n▶ ${who}${chat === "1on1" ? "（1対1）" : ""}「${said}」\n${r.text ? r.text.replace(/^/gm, "   ") : "   （返事なし）"}`);
  transcript.push({ who, chat, said, reply: r.text });
  return r;
}

function check(name, ok, detail = "") {
  if (!ok) failed += 1;
  console.log(`${ok ? "OK" : "NG"}  ${name}${ok ? "" : `\n      ${String(detail).replace(/\n/g, "\n      ")}`}`);
  transcript.push({ check: name, ok });
}

const ours = (l) => l.kind === "push" && l.to === group;
const pushesBefore = lines().filter(ours).length;

// ── S1 登場 ──────────────────────────────────────────────
console.log(`\n=== S1 登場（グループ ${group}）`);
n += 1;
const joinToken = `rt-${group}-${n}`;
await post([{ type: "join", webhookEventId: `evt-${group}-${n}`, replyToken: joinToken, source: { type: "group", groupId: group } }]);
let r = await waitReply(joinToken, 30_000);
console.log(`\n▶ （だんどりさんを招待）\n${r.text.replace(/^/gm, "   ")}`);
transcript.push({ who: "（招待）", chat: "group", said: "（だんどりさんを招待）", reply: r.text });
check("投げかけ＋［パパ］［ママ］［じいじ］［ばあば］", /あなたはだれですか/.test(r.text) && ["パパ", "ママ", "じいじ", "ばあば"].every((a) => actionsOf(r.messages).some((x) => x.label === a)), r.text);
const baabaButton = press(r.messages, /わたしは\s*ばあば/);
r = await say("ばあば", "Ubaaba", baabaButton?.text ?? "わたしは ばあば");
check("ばあば、よろしくね。何をしますか？＋メニュー", /ばあば、よろしくね。何をしますか？/.test(r.text), r.text);
r = await say("パパ", "Upapa", "架空の家族で");
check("見本の家族（はると・ゆい・そうた・めい）", /はると・ゆい・そうた・めい/.test(r.text), r.text);
r = await say("パパ", "Upapa", "わたしは パパ");
check("パパの名乗り", /パパ、よろしくね/.test(r.text), r.text);
r = await say("ママ", "Umama", "わたしは ママ");
check("ママの名乗り", /ママ、よろしくね/.test(r.text), r.text);
r = await say("パパ", "Upapa", "メニュー");
const menu = (r.messages.at(-1)?.quickReply?.items ?? []).map((i) => i.action.label);
check("メニューのボタン6つ（📷🖼🚗🤒📅❓）", menu.length === 6 && ["📷", "🖼", "🚗", "🤒", "📅", "❓"].every((e, i) => (menu[i] ?? "").startsWith(e)), menu.join(" "));

// ── S2 休み ──────────────────────────────────────────────
console.log("\n=== S2 休み");
r = await say("パパ", "Upapa", "はると 熱37.8 今日休み。スイミングも休む");
check("小学校の連絡文が出る", /小学校/.test(r.text), r.text);
check("習い事（スイミング）の連絡文が出る", /スイミング|習い事/.test(r.text), r.text);
check("［コピー］がある", actionsOf(r.messages).some((a) => a.type === "clipboard"), r.text);
check("どの子か聞き返さない・送迎に取られない", !/どのお子さん|行ける人/.test(r.text), r.text);
check("呼び名が欠けない（「はる」にならない）", !/はる(?!と)[はがのをにも]/.test(r.text), r.text);
check("聞き返し・組み直しの行が出ない（小学生1人の休み）", r.messages.every((m) => m.type === "flex"), r.text);

// ── S3 送迎・1対1（ママ） ─────────────────────────────────
console.log("\n=== S3 送迎・1対1");
r = await say("ママ", "Umama", "お迎えを頼む", { chat: "1on1" });
check("いつのお迎え？［今日］［明日］［やめる］", /いつのお迎え/.test(r.text) && ["今日", "明日", "やめる"].every((l) => actionsOf(r.messages).some((a) => a.label === l)), r.text);
r = await say("ママ", "Umama", "今日", { chat: "1on1" });
check("何時？［17:30］…", /何時/.test(r.text) && actionsOf(r.messages).some((a) => a.label === "17:30"), r.text);
const pushesAtS3 = lines().filter(ours).length;
r = await say("ママ", "Umama", "17:30", { chat: "1on1" });
check("グループで聞きました。グループを見ていてください。", /グループで聞きました。グループを見ていてください。/.test(r.text), r.text);
await new Promise((res) => setTimeout(res, 1500));
const askPush = lines().filter(ours).at(-1);
const askMessages = askPush?.messages ?? [];
console.log(`\n▶ （グループに届いた知らせ）\n${textOf(askMessages).replace(/^/gm, "   ")}`);
transcript.push({ who: "（プッシュ）", chat: "group", said: "（1対1からの頼みがグループに届く）", reply: textOf(askMessages) });
const names = actionsOf(askMessages).filter((a) => /^お迎え引受/.test(a.text ?? "")).map((a) => a.label);
check("グループに「お迎え、行ける人？」が1通", lines().filter(ours).length - pushesAtS3 === 1 && /行ける人/.test(textOf(askMessages)), textOf(askMessages));
check(
  "名前ボタンにママがいない（パパ・じいじ・ばあば＋ファミサポなど）",
  names.filter((n) => n !== "ファミサポなど").join(",") === "パパ,じいじ,ばあば" && names.includes("ファミサポなど"),
  names.join(","),
);
check("頼んだママの名前が文に出ない", !/ママ(から|が頼|より)/.test(textOf(askMessages)), textOf(askMessages));

// ── S4 送迎・グループ ─────────────────────────────────────
console.log("\n=== S4 送迎・グループ");
const take = press(askMessages, /^お迎え引受 #\d+ ばあば$/);
r = await say("ばあば", "Ubaaba", take?.text ?? "（ばあばのボタンが無い）");
check("ばあばに決まりました。ありがとう。", /ばあばに決まりました。ありがとう。/.test(r.text), r.text);
check("保育所への連絡文＋［コピー］", /保育所への連絡文/.test(r.text) && actionsOf(r.messages).some((a) => a.type === "clipboard"), r.text);
check("経験値の行（家族レベル）が出ない（11/5 佐藤 OK で外した）", !/家族レベル|\+\d+ ばあば/.test(r.text), r.text);
const thanks = press(r.messages, /^ありがとう #\d+$/);
check("［ありがとう］のボタンがある", !!thanks, r.text);
r = await say("パパ", "Upapa", thanks?.text ?? "（ありがとうボタンが無い）");
check("ばあばに、パパからのありがとうが届きました", /ばあばに、パパからのありがとうが届きました/.test(r.text), r.text);
r = await say("パパ", "Upapa", "段取り 念押し");
check("（念押しの場面を戻すとき）段取り 念押し：ばあばの念押しが返信で出る", /ばあば/.test(r.text) && /お迎え/.test(r.text), r.text);

// ── S5 19時の聞き方（今日が木曜なら金曜の分。金曜→月曜は scripts/test-assignment.mjs の側で確かめる） ──
console.log("\n=== S5 段取り 明日");
r = await say("パパ", "Upapa", "段取り 明日");
check("名前ボタンつきの札が返信で出る", /行ける人|決まっています/.test(r.text), r.text);
r = await say("パパ", "Upapa", "段取り 明日");
check("撮り直しで2回目に打っても同じ札が出る（「全部決まっています」と言わない）", /行ける人/.test(r.text) && !/全部決まっています/.test(r.text), r.text);

// ── S6 お便り ─────────────────────────────────────────────
console.log("\n=== S6 お便り");
r = await say("パパ", "Upapa", "お便りを送る");
check("［📷 撮る］［🖼 写真を選ぶ］", actionsOf(r.messages).some((a) => a.type === "camera") && actionsOf(r.messages).some((a) => a.type === "cameraRoll"), r.text);
r = await say("パパ", "Upapa", "", { image: "public-01" });
check("学芸会：11/15・9:00", /11\/15|11月15日/.test(r.text) && /9:00|09:00/.test(r.text), r.text);
check("学芸会：体操服・上ばき・500円・期限11/12", /体操服/.test(r.text) && /上ばき|上靴|上履き/.test(r.text) && /500/.test(r.text) && /11\/12|11月12日/.test(r.text), r.text);
check("締切だけの行は「11/12（木）まで」（「日にち未定」と出さない）", /11\/12（木）まで/.test(r.text) && !/日にち未定/.test(r.text), r.text);
let ok = press(r.messages, /^OK #\d+$/);
check("［OK］がある", !!ok, r.text);
r = await say("パパ", "Upapa", ok?.text ?? "OK #0");
check("予定に入れました。", /予定に入れました/.test(r.text), r.text);
r = await say("パパ", "Upapa", "", { image: "public-02" });
const asked = (r.text.match(/？/g) ?? []).length;
check("遠足：曜日の食い違いを1回だけ聞く", asked === 1 && /金曜|曜日/.test(r.text), r.text);
const yes = actionsOf(r.messages).find((a) => a.label === "はい");
check("［はい］［ちがう］", !!yes && actionsOf(r.messages).some((a) => a.label === "ちがう"), r.text);
r = await say("パパ", "Upapa", yes?.text ?? "はい");
check("［はい］のあとは聞き返さない", !/？/.test(r.text), r.text);
ok = press(r.messages, /^OK #\d+$/);
check("直したカードに［OK］", !!ok, r.text);
if (ok) {
  r = await say("パパ", "Upapa", ok.text);
  check("予定に入れました。（遠足）", /予定に入れました/.test(r.text), r.text);
}

// ── S7 だんどり帳 ─────────────────────────────────────────
console.log("\n=== S7 だんどり帳");
r = await say("パパ", "Upapa", "予定 見せて");
const open = actionsOf(r.messages).find((a) => a.type === "uri");
check("［📒 だんどり帳を開く］", /だんどり帳を開く/.test(open?.label ?? ""), r.text);
const path = open ? new URL(open.uri).pathname : null;
if (path) {
  const page = await fetch(`${base}${path}`).then((res) => res.text());
  check("だんどり帳のページが開く", /わが家のだんどり帳/.test(page), page.slice(0, 200));
  check("今日の夕方にばあば", /ばあば/.test(page), "ページに「ばあば」が無い");
  check("学芸会が入っている", /学芸会/.test(page), "ページに「学芸会」が無い");
  // 合言葉が見える文に出るのは「Googleカレンダーに入れる」の .ics の行だけ（撮影ではそこを開かない）
  const token = path.split("/")[2] ?? "@@";
  const visible = page.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, "\n");
  const leaks = visible.split("\n").filter((l) => l.includes(token));
  check("合言葉が見える文に出るのは .ics の行だけ", leaks.every((l) => l.trim().endsWith(".ics")), leaks.join("\n"));
}

const pushes = lines().filter(ours).length - pushesBefore;
check("プッシュは S3 の1通だけ（ほかは全部返信）", pushes === 1, `push ${pushes}`);

if (transcriptFile) {
  const md = transcript
    .map((t) => (t.check ? `- ${t.ok ? "OK" : "**NG**"} ${t.check}` : `\n**${t.who}${t.chat === "1on1" ? "（1対1）" : ""}**「${t.said}」\n\n\`\`\`\n${t.reply || "（返事なし）"}\n\`\`\``))
    .join("\n");
  writeFileSync(transcriptFile, `# 撮影の稽古（手元・架空の家族）\n\n${md}\n`);
}
console.log(`\n${failed === 0 ? "ALL PASS" : `FAIL ${failed}`}  group=${group}`);
process.exit(failed === 0 ? 0 : 1);
