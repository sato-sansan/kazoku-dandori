// 「決まった報告」の読み取り（src/pickup.ts の parseAssignment）を、11/4 に家族のグループで実際に出た言い方（名前は架空）で確かめる。
// Claude も LINE も呼ばない。今日を 2026-11-04 として読む。
//   使い方: node scripts/test-assignment.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = join(mkdtempSync(join(tmpdir(), "dandori-")), "pickup.mjs");
execFileSync("npx", ["--no-install", "esbuild", "src/pickup.ts", "--bundle", "--format=esm", "--platform=neutral", `--outfile=${out}`, "--log-level=warning"]);
const { parseAssignment } = await import(out);
const today = "2026-11-04";
const cases = [
  ["明日5時迎えばーばになりました", "2026-11-05 迎え 17:00 ばあば -"],
  ["ばあばは明日の17時お迎えです入れておいて", "2026-11-05 迎え 17:00 ばあば -"],
  ["28日土曜お迎え パパ\nさくら遅番", "2026-11-28 迎え - パパ -"],
  ["5日、保育所3人はファミサポにお迎え頼みました。", "2026-11-05 迎え - - ファミサポ"],
  ["16日は全員お休みだからお迎えなし。", "2026-11-16 送り - - お休み|2026-11-16 迎え - - お休み"],
  ["子供園だよりはきょうのかれんだーにいれて\n16日は全員お休みだからお迎えなし。", "2026-11-16 送り - - お休み|2026-11-16 迎え - - お休み"],
  ["5日のことに関しては私は何も言っていません。\nそこはパパが言った通りでいいので16日を全員休み、家庭の都合としてください", "2026-11-16 送り - - お休み|2026-11-16 迎え - - お休み"],
  ["だんどりさん\nばあば、18:00 保育所3人のお迎えです。よろしくお願いします。\nまちがってるよ\n明日ね11/5\n\nあと事前通知は1回で良い。", "2026-11-05 迎え 18:00 ばあば -"],
  ["子供園だよりはきょうのかれんだーにいれて 16日は全員お休みだからお迎えなし。", "2026-11-16 送り - - お休み|2026-11-16 迎え - - お休み"],
  ["28日土曜お迎え パパ さくら遅番", "2026-11-28 迎え - パパ -"],
  ["11/5(木)のお迎えはファミサポです", "2026-11-05 迎え - - ファミサポ"],
  ["金曜の送り じいじ", "2026-11-06 送り - じいじ -"],
  ["来週の月曜のお迎えはばあばになった", "2026-11-09 迎え - ばあば -"],
  ["明日お迎え：ばあば", "2026-11-05 迎え - ばあば -"],
  ["明日の朝 ママが送ります", "2026-11-05 送り - ママ -"],
  ["明日は雨だからパパが送ってあげて", null],
  // 報告ではないもの → null
  ["来週火曜の送りはおばあちゃんにお願いしといて", null],
  ["明日のお迎え ばあばに聞いといて", null],
  ["明日のお迎え パパに頼んどいて", null],
  ["5日ごめん、朝送り難しいかも", null],
  ["さくらに依頼して", null],
  ["明日のお迎えだれか行ける？", null],
  ["明日17時のお迎え頼んでおいて", null],
  ["バンソーこーははずしてとうこうした", null],
  ["パパのお迎え遅かったね", null],
  ["明日の送りパパが寝坊しないか心配", null],
  ["ちがう\n\nファミサポは18:30迎えです", null], // 日付なし・直前の報告なし
  ["16日は全員休みです 休みの連絡文作って", null],
  ["明日のお迎え、祖父が行きます", "2026-11-05 迎え - じいじ -"],
  ["明日の朝の送りはママです", "2026-11-05 送り - ママ -"],
  ["今日のお迎えはパパ、ママ遅番", null],
];
let fail = 0;
const fmt = (r) => r === null ? null : r.map((a) => `${a.date} ${a.kind} ${a.time ?? "-"} ${a.who ?? "-"} ${a.note ?? "-"}`).join("|");
for (const [text, want] of cases) {
  const got = fmt(parseAssignment(text, today));
  const ok = got === want;
  if (!ok) fail++;
  console.log(ok ? "OK  " : "NG  ", JSON.stringify(text).slice(0, 50), "→", got, ok ? "" : `（期待 ${want}）`);
}
// 直前の報告の続き
const follow = fmt(parseAssignment("はい、そうです。\nファミサポのお迎えは18:30です", today, "2026-11-05"));
console.log(follow === "2026-11-05 迎え 18:30 - ファミサポ" ? "OK  " : (fail++, "NG  "), "続き →", follow);

// 「段取り 明日」でどの日を聞くか（撮影 C04f：金曜に打つと月曜）。family.ts の分かれ道を、同じ道具（time.ts・pickup.ts）でなぞる
const timeOut = join(mkdtempSync(join(tmpdir(), "dandori-")), "time.mjs");
execFileSync("npx", ["--no-install", "esbuild", "src/time.ts", "--bundle", "--format=esm", "--platform=neutral", `--outfile=${timeOut}`, "--log-level=warning"]);
const { addDays, jstWeekday } = await import(timeOut);
const { nextWeekday } = await import(out);
const target = (day, busy = false) => {
  const t = addDays(day, 1);
  const weekend = [0, 6].includes(jstWeekday(t));
  return weekend && !busy ? nextWeekday(t) : t;
};
for (const [day, busy, want] of [
  ["2026-11-05", false, "2026-11-06"], // 木 → 金
  ["2026-11-06", false, "2026-11-09"], // 金 → 月（撮影の日）
  ["2026-11-07", false, "2026-11-09"], // 土 → 月
  ["2026-11-08", false, "2026-11-09"], // 日 → 月（明日がもう平日）
  ["2026-11-06", true, "2026-11-07"], // 金でも、土曜に聞くこと（習い事など）があれば土曜
  ["2026-11-27", false, "2026-11-30"], // 月末の金曜 → 翌週の月曜
]) {
  const got = target(day, busy);
  console.log(got === want ? "OK  " : (fail++, "NG  "), `段取り 明日（${day}${busy ? "・週末に用事" : ""}）→`, got, got === want ? "" : `（期待 ${want}）`);
}
console.log(fail === 0 ? "ALL PASS" : `FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
