// 手元の Worker（wrangler dev）に「@だんどりさん」で呼ぶ一言を送り、聞き分け（Claude Haiku）から今ある仕組みに回るかを見る。
// Claude は .dev.vars のキーで本当に呼ぶ（1回あたり Haiku 1回＋休みの連絡なら下書き1回）。LINE への返事は偽トークンで 401（想定どおり）。
// 見るもの：記録の {"step":"intent",...} の intent と、枠（slots）の状態。呼ばれていない雑談では intent が出ないこと。
//   使い方: node scripts/smoke-called.mjs [http://localhost:8787]
import { createHmac } from "node:crypto";

const base = process.argv[2] ?? "http://localhost:8787";
const secret = process.env.LINE_CHANNEL_SECRET ?? "local-test-secret";
const group = `Ccalled${Date.now() % 100000}`;
const SELF = "@だんどりさん";
let n = 0;

async function send(userId, text, wait = 6000) {
  n += 1;
  const index = text.indexOf(SELF);
  const mention = index >= 0 ? { mention: { mentionees: [{ index, length: SELF.length, type: "user", isSelf: true }] } } : {};
  const message = { id: `m${n}${Date.now()}`, type: "text", text, ...mention };
  const body = JSON.stringify({
    destination: "U0",
    events: [{ type: "message", webhookEventId: `evt-call-${n}-${Date.now()}`, replyToken: `rt-${n}`, source: { type: "group", groupId: group, userId }, message }],
  });
  const sig = createHmac("sha256", secret).update(body).digest("base64");
  const res = await fetch(`${base}/line/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "x-line-signature": sig }, body });
  console.log(`${text.padEnd(36)} -> ${res.status}`);
  await new Promise((r) => setTimeout(r, wait));
}

await send("Upapa", "わたしは パパ", 1500);
await send("Umama", "わたしは ママ", 1500);
await send("Ubaaba", "わたしは ばあば", 1500);
// a 断り（決まった言い方ではない）→ 送迎を断る → 木曜（11/5 なら）の朝の送りが「お願い中」
await send("Upapa", `${SELF} 木曜の朝むりそう`);
// b 別の日の「だれか迎え行ける？」→ 急ぎではなく金曜の迎え
await send("Umama", `${SELF} 金曜の夕方だれか迎え行ける？`);
// c 予定を見る
await send("Upapa", `${SELF} 今週どうなってる？`);
// d 雑談 → 入口のボタン（黙らない）
await send("Ubaaba", `${SELF} ありがとね`);
// e 休みの連絡（「休み」「熱」が無い言い方）
await send("Umama", `${SELF} そうたが朝から咳ひどくて今日は家で様子みる`, 15000);
// f 名簿にいない人 → 「どなたですか？」（Claude を呼ばない）
await send("Ustranger", `${SELF} こんにちは`, 1500);
// g 呼ばれていない雑談 → 聞き分けは呼ばない（intent が出ない）
await send("Upapa", "今日の晩ごはん何にしよう", 8000);
// h 決まった言い方に無い断り → 聞き分け「送迎を断る」→ 来週月曜の迎えが お願い中
await send("Upapa", `${SELF} 来週月曜の夕方はちょっと行けそうにないです`);
// i 言い換え「おばあちゃんに」→ ばあばに名指し → 来週火曜の送りが お願い中
await send("Umama", `${SELF} 来週火曜の朝はおばあちゃんにお願いしといて`, 3000);
// j 聞き分けだけが通る「人に頼む」（「聞いといて」は決まった言い方に無い）→ 来週水曜の送りが お願い中（入口のボタンが出ない）
await send("Umama", `${SELF} 来週水曜の朝、おばあちゃんが行けるか聞いといて`);
// k 聞き分けだけが通る「送迎を頼む」（送り・迎えの言葉が無い）→ 来週水曜の迎えが お願い中
await send("Upapa", `${SELF} 来週水曜の帰り、だれか行けるかな`);
console.log(`done. group=${group}`);
console.log("期待：intent が c 予定を見る・e 休みの連絡・h 送迎を断る の3件（a・b・i は決まった言い方、d はお礼として Claude を呼ばずに通る）。slots：11/5 送り・11/6 迎え・11/9 迎え・11/10 送り・11/11 送り・11/11 迎え が お願い中（今日が 11/4 のとき）。j・k は intent が 人に頼む・送迎を頼む");
