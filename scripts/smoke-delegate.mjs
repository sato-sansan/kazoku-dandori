// 手元の Worker（wrangler dev）に、@名指しつきの偽の LINE イベントを送る。「送り難しい」「○○に頼んで」の流れ。
// LINE への返事は偽トークンなので 401 で失敗する（想定どおり）。見るのは「handle failed」が出ないことと、枠の状態。
//   使い方: node scripts/smoke-delegate.mjs [http://localhost:8787]
import { createHmac } from "node:crypto";

const base = process.argv[2] ?? "http://localhost:8787";
const secret = process.env.LINE_CHANNEL_SECRET ?? "local-test-secret";
const group = `Cdelegate${Date.now() % 100000}`;
let n = 0;

/** text の中の "@名前" を mention にする。self=true はだんどりさん */
async function send(userId, text, mentions = [], wait = 1500) {
  n += 1;
  const mentionees = mentions.map(({ at, userId: id, self }) => {
    const index = text.indexOf(at);
    return self ? { index, length: at.length, type: "user", isSelf: true } : { index, length: at.length, type: "user", userId: id };
  });
  const message = { id: `m${n}${Date.now()}`, type: "text", text, ...(mentionees.length ? { mention: { mentionees } } : {}) };
  const body = JSON.stringify({
    destination: "U0",
    events: [{ type: "message", webhookEventId: `evt-del-${n}-${Date.now()}`, replyToken: `rt-${n}`, source: { type: "group", groupId: group, userId }, message }],
  });
  const sig = createHmac("sha256", secret).update(body).digest("base64");
  const res = await fetch(`${base}/line/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "x-line-signature": sig }, body });
  console.log(`${text.padEnd(30)} -> ${res.status}`);
  await new Promise((r) => setTimeout(r, wait));
}

await send("Upapa", "わたしは パパ");
await send("Umama", "わたしは ママ");
// ① 決まっていない日の「送り難しい」＋@名指し → 5日の送りの枠を立てて、ママに名指しで聞く
await send("Upapa", "5日ごめん、朝送り難しいかも @さくら", [{ at: "@さくら", userId: "Umama" }]);
// ② 表示名で頼む（手元は偽トークンで表示名が引けない → 「どなたですか？」のボタン）
await send("Upapa", "さくらに依頼して @だんどりさん", [{ at: "@だんどりさん", self: true }]);
// ③ ボタンの答え → 一番近い聞いている枠（5日の送り）をママに
await send("Upapa", "ママに頼んで");
// ④ 送り迎えつきで頼む
await send("Upapa", "6日のお迎え ばあばに頼んで");
// ⑤ ママが引き受ける → 5日の送りはママに決定
await send("Umama", "送り引受 #1 ママ");
// ⑥ 決まった後に日付つきで断る → 5日の送りが「お願い中」に戻り、取消が1件残る
await send("Umama", "5日の朝の送り、やっぱり難しい");
// ⑦ じいじが6日の迎えを引き受けた後、パパが「ばあばに頼んで」→ じいじの担当は外さない（「もうじいじに決まっています」）
await send("Ujiiji", "わたしは じいじ");
await send("Ujiiji", "お迎え引受 #2 じいじ");
await send("Upapa", "6日のお迎え ばあばに頼んで");
// ⑧ 「今すぐお迎え ばあばにお願い」→ 今日・今の時刻の迎えの枠（明日ではない）
await send("Upapa", "今すぐお迎え、ばあばにお願い");
console.log(`done. group=${group}`);
console.log("期待：#1 11/5 送り お願い中・#2 11/6 迎え じいじ 決定・#3 今日 今の時刻 迎え お願い中／events 引受 ママ #1・取消 ママ #1・引受 じいじ #2");
