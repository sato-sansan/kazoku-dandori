// 読み取りの採点。評価セットのお便りを readNotice に通し、正解と突き合わせて10の観点で○×を付ける
//
// 使い方：npm run eval -- --set public --tag <名前> [--note <何を変えたか1行>] [--only public-02,public-08]
//   --set  public / private / all
//   --tag  その回の名前（例 p1-baseline）。docs/eval-history.md に残る
//   --dry  Claude を呼ばず、正解をそのまま採点に通す（採点の仕組みの確認用。履歴に書かない）
// キーは環境変数 ANTHROPIC_API_KEY か .dev.vars から読む。実物（eval/private/）は番号と○×しか出さない
//
// Node 26 が TypeScript をそのまま実行する。src/ の相対 import には拡張子が無いので、
// 読み込みフックで .ts を補ってから src/reader.ts を読む（src/ は変えない）

import { existsSync, readFileSync, readdirSync, appendFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { basename, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Card, ReadResult } from "../src/card.ts";
import type { FamilyProfile } from "../src/profile.ts";
import type { ReadInput } from "../src/reader.ts";

const ROOT = resolve(import.meta.dirname, "..");
const HISTORY = resolve(ROOT, "docs/eval-history.md");

// ── ケースの形（eval/README.md） ─────────────────────────────

type Kind = Card["kind"];

interface ExpectedCard {
  child: string;
  kind: Kind | Kind[]; // どちらでも正解にしたいときは配列
  title: string;
  date: string | null;
  time: string | null;
  place: string | null;
  deadline: string | null;
  items: string[];
  money: number | null;
}

interface Case {
  id: string;
  topic?: string;
  input: { type: "image" | "text"; image?: string; text?: string };
  today: string;
  family: FamilyProfile;
  expected: {
    is_notice: boolean;
    cards: ExpectedCard[];
    ask_expected: boolean;
    // お便りに書いてあるが答えではない値（開場時刻・発行日など）。出しても「作った」とは数えない
    also_written?: { dates?: string[]; times?: string[]; money?: number[]; items?: string[] };
  };
}

interface LoadedCase {
  case: Case;
  set: "public" | "private";
  dir: string;
}

// ── 採点の結果 ──────────────────────────────────────────────

const VIEWPOINTS = [
  "①子ども",
  "②種類",
  "③日付",
  "④時刻",
  "⑤期限",
  "⑥持ち物",
  "⑦金額",
  "⑧送迎要否",
  "⑩聞き返し",
] as const;
type Viewpoint = (typeof VIEWPOINTS)[number];

interface Grade {
  marks: Record<Viewpoint, boolean>;
  fabricated: string[]; // ⑨ 作った値。1件ずつ
  reasons: string[]; // × の理由（公開セットだけ画面に出す）
  allPass: boolean;
  error?: string;
}

const RED = "\x1b[31m";
const RESET = "\x1b[0m";

// ── 引数 ────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const args = { set: "public", tag: "", note: "", only: [] as string[], dry: false };
  for (let i = 0; i < argv.length; i++) {
    const [key, inline] = argv[i].split("=", 2);
    if (key === "--dry") {
      args.dry = true;
      continue;
    }
    const value = inline ?? argv[++i] ?? "";
    if (key === "--set") args.set = value;
    else if (key === "--tag") args.tag = value;
    else if (key === "--note") args.note = value;
    else if (key === "--only") args.only = value.split(",").map((s) => s.trim()).filter(Boolean);
    else {
      console.error(`知らない引数: ${key}`);
      process.exit(1);
    }
  }
  if (!["public", "private", "all"].includes(args.set)) {
    console.error(`--set は public / private / all のどれか（${args.set}）`);
    process.exit(1);
  }
  if (!args.tag && !args.dry) {
    console.error("--tag <名前> を付ける（例：--tag p1-baseline）");
    process.exit(1);
  }
  return args;
}

// ── 読み込み ────────────────────────────────────────────────

function loadSet(set: "public" | "private"): LoadedCase[] {
  const dir = resolve(ROOT, "eval", set);
  const casesDir = resolve(dir, "cases");
  if (!existsSync(casesDir)) {
    if (set === "public") throw new Error(`評価セットが無い: ${casesDir}`);
    return [];
  }
  return readdirSync(casesDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const c = JSON.parse(readFileSync(resolve(casesDir, f), "utf8")) as Case;
      if (!c.id || !c.input || !c.expected || !Array.isArray(c.expected.cards)) {
        throw new Error(`ケースの形が違う: ${set}/cases/${f}`);
      }
      if (c.input.type === "image") {
        if (!c.input.image || !existsSync(resolve(dir, c.input.image))) {
          throw new Error(`画像が無い: ${set}/${c.input.image ?? "(未指定)"}（${c.id}）`);
        }
      } else if (!c.input.text) {
        throw new Error(`文が無い: ${c.id}`);
      }
      return { case: c, set, dir };
    });
}

/** 環境変数に無ければ .dev.vars を読む（KEY=VALUE の行だけ。値は表示しない） */
function loadApiKey(): string | null {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const file = resolve(ROOT, ".dev.vars");
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.+?)\s*$/);
    if (m) return m[1].replace(/^["']|["']$/g, "") || null;
  }
  return null;
}

const IMAGE_TYPES: Record<string, "image/png" | "image/jpeg" | "image/webp" | "image/gif"> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

// ── 値の正規化 ──────────────────────────────────────────────

function normDate(v: string | null | undefined) {
  if (!v) return null;
  const m = v.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : v;
}

function normTime(v: string | null | undefined) {
  if (!v) return null;
  const m = v.match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : v;
}

/** 持ち物は表記ゆれが多いので、全角半角と空白をそろえて「含む」で見る */
function normItem(v: string) {
  return v.normalize("NFKC").replace(/[\s・,、。()（）]/g, "").toLowerCase();
}

function itemMatches(a: string, b: string) {
  const x = normItem(a);
  const y = normItem(b);
  return x === y || (x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x)));
}

function sameSet<T>(a: Set<T>, b: Set<T>) {
  return a.size === b.size && [...a].every((v) => b.has(v));
}

function subset<T>(a: Set<T>, b: Set<T>) {
  return [...a].every((v) => b.has(v));
}

// ── 採点 ────────────────────────────────────────────────────

function grade(c: Case, actual: ReadResult): Grade {
  const exp = c.expected;
  const also = exp.also_written ?? {};
  const marks = Object.fromEntries(VIEWPOINTS.map((v) => [v, true])) as Record<Viewpoint, boolean>;
  const reasons: string[] = [];
  const fail = (v: Viewpoint, why: string) => {
    marks[v] = false;
    reasons.push(`${v}: ${why}`);
  };
  const cards = actual.cards ?? [];
  const asks = cards.filter((k) => k.ask).length;

  // お便りに書いてある値の集合。ここに無い値を出したら「作った」
  const universe = {
    dates: new Set(
      [
        ...exp.cards.map((k) => k.date),
        ...exp.cards.map((k) => k.deadline),
        ...(also.dates ?? []),
      ]
        .map(normDate)
        .filter((v): v is string => !!v),
    ),
    times: new Set(
      [...exp.cards.map((k) => k.time), ...(also.times ?? [])]
        .map(normTime)
        .filter((v): v is string => !!v),
    ),
    money: new Set(
      [...exp.cards.map((k) => k.money), ...(also.money ?? [])].filter(
        (v): v is number => v != null,
      ),
    ),
    items: [...exp.cards.flatMap((k) => k.items), ...(also.items ?? [])],
  };

  // ⑨ 作らない。同じ値を複数のカードに書いても1件
  const fabricatedSet = new Set<string>();
  for (const k of cards) {
    for (const d of [k.date, k.deadline].map(normDate)) {
      if (d && !universe.dates.has(d)) fabricatedSet.add(`日付 ${d}`);
    }
    const t = normTime(k.time);
    if (t && !universe.times.has(t)) fabricatedSet.add(`時刻 ${t}`);
    if (k.money != null && !universe.money.has(k.money)) fabricatedSet.add(`金額 ${k.money}円`);
    for (const item of k.items ?? []) {
      if (!universe.items.some((u) => itemMatches(u, item))) fabricatedSet.add(`持ち物 ${item}`);
    }
  }
  const fabricated = [...fabricatedSet];

  // 予定でないお便り：is_notice false かカード0枚なら全部○。カードを出したら全部×
  if (!exp.is_notice) {
    const pass = actual.is_notice === false || cards.length === 0;
    if (!pass) {
      for (const v of VIEWPOINTS) marks[v] = false;
      reasons.push(`予定ではないのにカードを${cards.length}枚出した`);
    } else if (asks > 0) {
      fail("⑩聞き返し", "予定ではないのに聞き返した");
    }
    return { marks, fabricated, reasons, allPass: Object.values(marks).every(Boolean) && fabricated.length === 0 };
  }

  if (actual.is_notice === false || cards.length === 0) {
    for (const v of VIEWPOINTS) marks[v] = false;
    reasons.push("予定なのにカードを出さなかった（is_notice false かカード0枚）");
    return { marks, fabricated, reasons, allPass: false };
  }

  // ① 子ども：集合が一致
  const expChildren = new Set(exp.cards.map((k) => k.child));
  const actChildren = new Set(cards.map((k) => k.child));
  if (!sameSet(expChildren, actChildren)) {
    fail("①子ども", `正解 ${[...expChildren].join("/")} ↔ 出力 ${[...actChildren].join("/")}`);
  }

  // ② 種類：正解カード1枚ごとに、同じ子・同じ種類の出力カードを1枚ずつ対応づける
  const used = new Set<number>();
  for (const e of exp.cards) {
    const kinds = Array.isArray(e.kind) ? e.kind : [e.kind];
    const idx = cards.findIndex((k, i) => !used.has(i) && k.child === e.child && kinds.includes(k.kind));
    if (idx < 0) {
      fail("②種類", `${e.child}の「${e.title}」（${kinds.join("か")}）に当たるカードが無い`);
    } else {
      used.add(idx);
    }
  }

  // ③〜⑦：ケース全体の値の集合で比べる。正解側が空なら、書いてある値の範囲内なら○（集金の期限を日付にも入れる等）
  const compare = (
    v: Viewpoint,
    label: string,
    expSet: Set<string | number>,
    actSet: Set<string | number>,
    uni: Set<string | number>,
  ) => {
    const ok = expSet.size === 0 ? subset(actSet, uni) : sameSet(expSet, actSet);
    if (!ok) fail(v, `${label} 正解 {${[...expSet].join(", ")}} ↔ 出力 {${[...actSet].join(", ")}}`);
  };
  const pick = <T,>(xs: (T | null | undefined)[]) => new Set(xs.filter((x): x is T => x != null));

  const actDates = pick(cards.map((k) => normDate(k.date)));
  if (exp.ask_expected) {
    // 曜日のずれ・日付なし：聞き返していて、作った日付が無ければ○
    if (asks === 0) fail("③日付", "聞き返すべき所で聞かなかった");
    else if (!subset(actDates, universe.dates)) fail("③日付", "聞き返したが、書いていない日付を出した");
  } else {
    compare("③日付", "日付", pick(exp.cards.map((k) => normDate(k.date))), actDates, universe.dates);
  }
  compare("④時刻", "時刻", pick(exp.cards.map((k) => normTime(k.time))), pick(cards.map((k) => normTime(k.time))), universe.times);
  compare("⑤期限", "期限", pick(exp.cards.map((k) => normDate(k.deadline))), pick(cards.map((k) => normDate(k.deadline))), universe.dates);

  // ⑥ 持ち物：漏れなし・余計なし（表記ゆれは「含む」で許す）
  const uniq = (xs: string[]) => [...new Set(xs)];
  const expItems = uniq(exp.cards.flatMap((k) => k.items));
  const actItems = uniq(cards.flatMap((k) => k.items ?? []));
  const missing = expItems.filter((e) => !actItems.some((a) => itemMatches(e, a)));
  const extra = actItems.filter((a) => !universe.items.some((u) => itemMatches(u, a)));
  const extraNotAnswer = actItems.filter(
    (a) => !expItems.some((e) => itemMatches(e, a)) && universe.items.some((u) => itemMatches(u, a)),
  );
  if (missing.length || extra.length || (expItems.length > 0 && extraNotAnswer.length)) {
    const why = [
      missing.length && `漏れ ${missing.join("・")}`,
      extra.length && `余計 ${extra.join("・")}`,
      extraNotAnswer.length && `答えでない物 ${extraNotAnswer.join("・")}`,
    ].filter(Boolean);
    fail("⑥持ち物", why.join("／"));
  }

  compare("⑦金額", "金額", pick(exp.cards.map((k) => k.money)), pick(cards.map((k) => k.money)), universe.money);

  // ⑧ 送迎の要否：送り迎えが要る予定を見落としていない（README の定義どおり、余計な送迎カードは減点しない。理由に残すだけ）
  const expPickup = exp.cards.some((k) => k.kind === "送迎" || (Array.isArray(k.kind) && k.kind.includes("送迎")));
  const actPickup = cards.some((k) => k.kind === "送迎");
  if (expPickup && !actPickup) fail("⑧送迎要否", "送迎が要るのに送迎カードが無い");
  if (!expPickup && actPickup) reasons.push("（参考）送迎が要らないのに送迎カードを作った。減点なし");

  // ⑩ 聞き返し：分からない所でだけ。1回に聞くのは1つなので、要るときは1つ以上あれば○
  if (exp.ask_expected && asks === 0) fail("⑩聞き返し", "分からない所があるのに聞かなかった");
  if (!exp.ask_expected && asks > 0) {
    fail("⑩聞き返し", `分かるのに聞いた：${cards.find((k) => k.ask)?.ask ?? ""}`);
  }

  return { marks, fabricated, reasons, allPass: Object.values(marks).every(Boolean) && fabricated.length === 0 };
}

function failedGrade(error: string): Grade {
  const marks = Object.fromEntries(VIEWPOINTS.map((v) => [v, false])) as Record<Viewpoint, boolean>;
  return { marks, fabricated: [], reasons: [], allPass: false, error };
}

// ── 表示 ────────────────────────────────────────────────────

const mark = (ok: boolean) => (ok ? "○" : "×");

function caseRow(id: string, g: Grade) {
  const marks = VIEWPOINTS.map((v) => mark(g.marks[v])).join(" ");
  const fab = g.fabricated.length ? `${RED}${g.fabricated.length}${RESET}` : "0";
  return `${id.padEnd(12)} ${marks} ⑨${fab}  ${g.error ? "エラー" : g.allPass ? "全部○" : ""}`;
}

function summaryLines(tag: string, set: string, results: { id: string; grade: Grade }[]) {
  const n = results.length;
  const lines = [`/eval  tag=${tag}  set=${set}  ${n}件`, "観点      正答"];
  for (const v of VIEWPOINTS) {
    const ok = results.filter((r) => r.grade.marks[v]).length;
    lines.push(`${v.padEnd(5, "　")} ${ok}/${n}`);
  }
  const all = results.filter((r) => r.grade.allPass).length;
  const fab = results.reduce((s, r) => s + r.grade.fabricated.length, 0);
  const errors = results.filter((r) => r.grade.error).length;
  lines.push(`全部合った  ${all}/${n} (${n ? Math.round((all / n) * 100) : 0}%)`);
  lines.push(`⑨でっち上げ ${fab}件${fab === 0 ? " ← 0" : " ← 0でなければならない"}`);
  if (errors) lines.push(`エラー     ${errors}件（×として数えた）`);
  const failed = results.filter((r) => !r.grade.allPass).map((r) => r.id);
  if (failed.length) lines.push(`落ちた     ${failed.join(", ")}`);
  return lines;
}

function appendHistory(tag: string, set: string, note: string, results: { id: string; grade: Grade }[]) {
  const now = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date());
  const block = [
    "",
    `## ${now}  tag=${tag}  set=${set}  ${results.length}件`,
    "```",
    ...summaryLines(tag, set, results),
    "```",
    `変えたこと：${note || "（--note で1行書く）"}`,
    "",
  ].join("\n");
  appendFileSync(HISTORY, block);
}

// ── 本体 ────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const sets: ("public" | "private")[] = args.set === "all" ? ["public", "private"] : [args.set as "public" | "private"];
  let loaded = sets.flatMap(loadSet);
  if (args.only.length) loaded = loaded.filter((l) => args.only.includes(l.case.id));
  if (loaded.length === 0) {
    console.error("ケースが0件。--set と --only を確かめる");
    process.exit(1);
  }

  const apiKey = args.dry ? "" : (loadApiKey() ?? "");
  if (!args.dry && !apiKey) {
    console.error(
      [
        "ANTHROPIC_API_KEY が無い。次のどちらかで入れる：",
        "  1. .dev.vars に ANTHROPIC_API_KEY=... を書く（コミットしない）",
        "  2. ANTHROPIC_API_KEY=... npm run eval -- --set public --tag <名前>",
        `（ケースの読み込みは ${loaded.length}件とも通った）`,
      ].join("\n"),
    );
    process.exit(1);
  }

  const read = args.dry ? readFromExpected : await loadReader();

  console.log(`/eval  tag=${args.tag || "(dry)"}  set=${args.set}  ${loaded.length}件${args.dry ? "  ※ --dry：正解をそのまま採点" : ""}`);
  console.log("（今日の日付は実行時のもの。ケースは 2026-11-03 前提で作ってある）");
  console.log(`${"case".padEnd(12)} ${VIEWPOINTS.map((v) => v.slice(0, 1)).join(" ")} ⑨`);

  const results: { id: string; grade: Grade; set: string }[] = [];
  for (const { case: c, set, dir } of loaded) {
    let g: Grade;
    try {
      const input =
        c.input.type === "image"
          ? {
              profile: c.family,
              image: {
                mediaType: IMAGE_TYPES[extname(c.input.image!).toLowerCase()] ?? "image/jpeg",
                data: readFileSync(resolve(dir, c.input.image!)).toString("base64"),
              },
            }
          : { profile: c.family, text: c.input.text! };
      const actual = await read(apiKey, input, c);
      g = grade(c, actual);
    } catch (e) {
      g = failedGrade(e instanceof Error ? e.message : String(e));
    }
    results.push({ id: c.id, grade: g, set });

    // 実物は番号と○×だけ。題材・理由・作った値は出さない
    console.log(caseRow(c.id, g));
    if (set === "public") {
      if (c.topic) console.log(`             ${c.topic}`);
      for (const r of g.reasons) console.log(`             × ${r}`);
      for (const f of g.fabricated) console.log(`             ${RED}⑨ 作った：${f}${RESET}`);
      if (g.error) console.log(`             エラー：${g.error.slice(0, 200)}`);
    } else if (g.error) {
      console.log(`             エラー（内容は出さない）`);
    }
  }

  console.log("");
  const fabTotal = results.reduce((s, r) => s + r.grade.fabricated.length, 0);
  for (const line of summaryLines(args.tag, args.set, results)) {
    console.log(line.startsWith("⑨") && fabTotal > 0 ? `${RED}${line}${RESET}` : line);
  }

  if (args.dry) {
    console.log("\n--dry なので履歴には書かない");
    return;
  }
  appendHistory(args.tag, args.set, args.note, results);
  console.log(`\n${basename(HISTORY)} に追記した`);
}

type Reader = (apiKey: string, input: ReadInput, c: Case) => Promise<ReadResult>;

/** src/reader.ts を読む。src/ の拡張子なし相対 import に .ts を補う（静的 import は巻き上がるので、登録後に動的 import） */
async function loadReader(): Promise<Reader> {
  registerHooks({
    resolve(specifier, context, next) {
      if ((specifier.startsWith("./") || specifier.startsWith("../")) && !extname(specifier) && context.parentURL) {
        const base = fileURLToPath(new URL(specifier, context.parentURL));
        if (existsSync(`${base}.ts`)) return next(`${specifier}.ts`, context);
      }
      return next(specifier, context);
    },
  });
  const { readNotice } = await import("../src/reader.ts");
  return (apiKey, input) => readNotice(apiKey, input);
}

/** --dry 用。正解のカードをそのまま読み取り結果の形にする（全部○・でっち上げ0件になるはず） */
async function readFromExpected(_apiKey: string, _input: ReadInput, c: Case): Promise<ReadResult> {
  const cards: Card[] = c.expected.cards.map((e) => ({
    child: e.child,
    kind: Array.isArray(e.kind) ? e.kind[0] : e.kind,
    title: e.title,
    date: e.date,
    time: e.time,
    place: e.place,
    deadline: e.deadline,
    items: e.items,
    money: e.money,
    who_acts: "未定",
    confidence: "高",
    ask: c.expected.ask_expected ? "この読み取りで合っていますか？" : null,
  }));
  return { is_notice: c.expected.is_notice, cards, summary: [] };
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
