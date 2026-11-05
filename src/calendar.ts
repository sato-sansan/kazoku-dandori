// 家族の予定ページ（ログインなし・合言葉つき URL）と購読用の ICS。純粋関数だけ（取り出し・保存は family.ts）
// ばあばがスマホで見る前提：390px で横スクロールなし、字は「あ 小中大」で 17/18/22px、ボタンは 44px 以上
// 最初は月の升目（1画面で月全体。子どもごとの色の頭文字と、送迎の？で一目）。日を押すとその週を1日ずつ縦に（768px 以上で7列）

import { seasonEmoji, type AdventureStats } from "./adventure";
import type { Card } from "./card";
import type { Slot } from "./types";
import { addDays, jstToMs, jstWeekday } from "./time";

export interface CalendarInput {
  today: string; // YYYY-MM-DD（JST）
  view: "week" | "month";
  anchor: string; // 表示の基準日 YYYY-MM-DD
  cards: Card[]; // 予定カード（date が null のものは「日付未定」の欄にまとめる）
  slots: Slot[]; // 送迎の枠
  photos: { date: string; url: string; label: string; kind?: string }[]; // その日の写真。kind は お便り／家族／成長。url は期限つき
  adventure?: { stats: AdventureStats; takes: { who: string; count: number }[] }; // 家族の冒険（レベル・今週のありがとう・だれが何回）
  baseUrl: string; // "https://.../cal/<token>" ページ自身の URL（週↔月の切り替えリンクに使う）
  familyName?: string; // 「さとう家」など。無ければ「わが家」
}

type Photo = CalendarInput["photos"][number];

const WEEKDAY = ["日", "月", "火", "水", "木", "金", "土"];

// ── 文字の扱い ─────────────────────────────────────────────

/** HTML に入れる文字列は必ずこれを通す（属性にも使う） */
function esc(text: string | number | null | undefined) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 「11/4（火）」 */
function shortDate(date: string) {
  const [, m, d] = date.split("-").map(Number);
  return `${m}/${d}（${WEEKDAY[jstWeekday(date)]}）`;
}

/** 「2026年11月」 */
function monthLabel(date: string) {
  const [y, m] = date.split("-").map(Number);
  return `${y}年${m}月`;
}

/** 月の初日 */
function firstOfMonth(date: string) {
  return `${date.slice(0, 7)}-01`;
}

/** n か月あとの初日 */
function addMonths(date: string, n: number) {
  const [y, m] = date.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}-01`;
}

/** その週の月曜 */
function mondayOf(date: string) {
  return addDays(date, -((jstWeekday(date) + 6) % 7));
}

function kindWord(kind: Slot["kind"]) {
  return kind === "迎え" ? "お迎え" : "送り";
}

/** 取消の枠は出さない */
function liveSlots(slots: Slot[]) {
  return slots.filter((s) => s.status !== "取消");
}

/** 未定＝担当がいない（ファミサポ・お休みで家族が行かない枠は未定にしない） */
function undecided(slot: Slot) {
  return slot.who === null && slot.status !== "不要";
}

/** 担当の名前。家族が行かない枠は「ファミサポ」「お休み」、未定は「だれ？」 */
function slotWho(slot: Slot) {
  return slot.who ?? (slot.status === "不要" ? slot.note || "なし" : "だれ？");
}

/** 「9:00」「17:30〜」を "HH:MM" にそろえる。読めなければ null（終日あつかい）。読み取りは形を縛っていないので、ここで守る */
function normTime(time: string | null) {
  const m = /^(\d{1,2}):(\d{2})/.exec(time ?? "");
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

function normCards(cards: Card[]) {
  return cards.map((c) => ({ ...c, time: normTime(c.time) }));
}

/** 時刻のないカードを先に、あとは時刻順 */
function byTime(a: Card, b: Card) {
  return (a.time ?? "").localeCompare(b.time ?? "");
}

/** 持ち物・集金・期限を1行に。無ければ空 */
function cardNote(card: Card) {
  const parts: string[] = [];
  if (card.place) parts.push(card.place);
  if (card.items.length > 0) parts.push(`持ち物：${card.items.join("・")}`);
  if (card.money !== null) parts.push(`${card.money.toLocaleString("ja-JP")}円`);
  if (card.deadline) parts.push(`期限 ${shortDate(card.deadline)}`);
  if (card.who_acts !== "未定") parts.push(card.who_acts);
  return parts.join("　");
}

/** 「ゆい 運動会」。全員のことなら題名だけ */
function cardTitle(card: Card) {
  return card.child === "全員" || !card.child ? card.title : `${card.child} ${card.title}`;
}

// ── 画面 ─────────────────────────────────────────────────
// 最初は「月」。1画面で月全体が見え、日ごとに「だれの予定があるか」（子どもごとの色の頭文字）と
// 「送迎が決まっているか」（赤い「？」／担当の頭文字）が一目で分かる。日を押すとその週に切り替わり、中身が読める。
// 文字は「あ 小・中・大」で 17/18/22px。クリーム地・濃茶の字・子どもごとのパステル

/** 子どもごとの色。呼び名の出てきた順に割り当てる（6色まで。それ以上は繰り返し） */
const CHILD_COLORS = [
  { bg: "#F7C4CB", fg: "#7A1F2E" },
  { bg: "#BFE0FF", fg: "#103E74" },
  { bg: "#FFE28F", fg: "#6A4700" },
  { bg: "#C8ECB8", fg: "#1E5A1E" },
  { bg: "#E2D2FF", fg: "#46287A" },
  { bg: "#FFD3AE", fg: "#7A3900" },
];

/** 大人の頭文字（月の升に入れる） */
function adultInitial(name: string) {
  return name === "じいじ" ? "じ" : name === "ばあば" ? "ば" : name === "パパ" ? "パ" : name === "ママ" ? "マ" : name.slice(0, 1);
}

/** 呼び名 → 色番号。カードと送迎に出てくる子どもを、出てきた順に */
function childIndex(input: CalendarInput) {
  const order: string[] = [];
  const add = (name: string) => {
    if (name && name !== "全員" && !order.includes(name)) order.push(name);
  };
  for (const c of input.cards) add(c.child);
  for (const s of input.slots) for (const n of s.children) add(n);
  return new Map(order.map((name, i) => [name, i]));
}

function childStyle(idx: Map<string, number>, name: string) {
  const c = CHILD_COLORS[(idx.get(name) ?? 0) % CHILD_COLORS.length];
  return `style="background:${c.bg};color:${c.fg}"`;
}

/** 凡例：● ゆい ● そうた。呼び名だけ */
function legendHtml(idx: Map<string, number>) {
  if (idx.size === 0) return "";
  const items = [...idx.keys()].map((n) => `<span class="lg"><i ${childStyle(idx, n)}>${esc(n.slice(0, 1))}</i>${esc(n)}</span>`);
  items.push(`<span class="lg"><i class="all">全</i>みんな</span>`);
  items.push(`<span class="lg"><i class="nd">？</i>送迎 未定</span>`);
  return `<div class="legend" aria-label="色の意味">${items.join("")}</div>`;
}

/** 1枚のカード（週の中身・日付未定の欄で使う）。子どもの色を左に */
function cardHtml(card: Card, showTime: boolean, idx: Map<string, number>) {
  const time = showTime && card.time ? `<span class="t">${esc(card.time)}</span>` : "";
  const note = cardNote(card);
  const who = card.child && card.child !== "全員" ? `<i class="ci" ${childStyle(idx, card.child)}>${esc(card.child.slice(0, 1))}</i>` : `<i class="ci all">全</i>`;
  return `<div class="ev">${who}<div class="evb">${time}<b>${esc(cardTitle(card))}</b>${note ? `<small>${esc(note)}</small>` : ""}</div></div>`;
}

/** 日ごとの送迎の担当。「朝 ママ」「夕 ばあば」。同じ種類が2つ以上ある日は「17:30 保育所 じいじ」。未定は赤＋「だれ？」 */
function slotChips(slots: Slot[]) {
  const sorted = [...slots].sort((a, b) => a.time.localeCompare(b.time));
  return sorted
    .map((s) => {
      const same = sorted.filter((o) => o.kind === s.kind).length;
      const label = same > 1 ? `${s.time} ${s.place}` : s.kind === "送り" ? "朝の送り" : "お迎え";
      const who = slotWho(s);
      const nd = undecided(s);
      return `<span class="chip${nd ? " nd" : ""}"${nd ? ' aria-label="送迎の担当がまだ決まっていません"' : ""}>${esc(label)}：${esc(who)}</span>`;
    })
    .join("");
}

function photoThumb(p: Photo) {
  return `<button type="button" class="ph" data-src="${esc(p.url)}" data-label="${esc(p.label)}" aria-label="写真を大きく見る：${esc(p.label)}"><img src="${esc(p.url)}" alt="${esc(p.label)}" loading="lazy"></button>`;
}

/** 残してある写真を、新しい順に一覧で。「あのお便り、どこだっけ」のための置き場 */
function noticesHtml(all: Photo[]) {
  const photos = all.filter((p) => !p.kind || p.kind === "お便り");
  if (photos.length === 0) return "";
  const sorted = [...photos].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return `<section class="notices" aria-labelledby="nt-h">
<h2 id="nt-h">📄 お便り（${sorted.length}枚）<small>紙は捨ててOK</small></h2>
<div class="thumbs">${sorted
    .map((p) => `<figure class="nt">${photoThumb(p)}<figcaption>${esc(shortDate(p.date))} ${esc(p.label)}</figcaption></figure>`)
    .join("")}</div>
</section>`;
}

/** 成長記録：「この写真 ○○の成長記録に」と言った写真を、子どもの名前つきで新しい順に。家族の写真もここ */
function growthHtml(all: Photo[], idx: Map<string, number>) {
  const photos = all.filter((p) => p.kind === "成長" || p.kind === "家族");
  const sorted = [...photos].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const items =
    sorted.length === 0
      ? `<p class="none">まだありません。家族の LINE に写真を送って「思い出に入れておいて」と言うと、ここに並びます。子どもの名前を入れると（「○○の成長記録に」）その子の印がつきます。</p>`
      : `<div class="thumbs">${sorted
          .map((p) => {
            const names = p.label.split("・").filter((n) => idx.has(n));
            const chips = names.map((n) => `<i class="ci" ${childStyle(idx, n)}>${esc(n.slice(0, 1))}</i>`).join("");
            return `<figure class="nt gr">${photoThumb(p)}<figcaption>${chips}${esc(shortDate(p.date))} ${esc(p.label)}</figcaption></figure>`;
          })
          .join("")}</div>`;
  return `<section class="notices growth" aria-labelledby="gr-h">
<h2 id="gr-h">🌱 成長記録${sorted.length > 0 ? `（${sorted.length}枚）` : ""}</h2>
${items}
</section>`;
}

/**
 * わが家の冒険：ありがとう・だれが引き受けたか を先に（ママが見たいのは「わたしだけじゃない」こと）、レベルはその下。順位は付けない。
 * 言葉は LINE の日曜のカードと同じ（わが家の冒険・わが家の経験値）。XP とは書かない
 */
function adventureHtml(adv: CalendarInput["adventure"], today: string) {
  if (!adv) return "";
  const s = adv.stats;
  const emoji = seasonEmoji(Number(today.slice(5, 7)));
  const total = s.xp + s.nextLevelXp;
  const pct = total > 0 ? Math.min(100, Math.round((s.xp / total) * 100)) : 100;
  const delta = s.thanksDelta > 0 ? `（先週より +${s.thanksDelta}）` : s.thanksDelta < 0 ? `（先週より ${s.thanksDelta}）` : "";
  const takes = adv.takes.length > 0 ? adv.takes.map((t) => `<span class="chip sv">${esc(t.who)} ${t.count}回</span>`).join("") : `<span class="none">今週はまだ。名前ボタンを押すとここに並びます</span>`;
  const titles = s.titles.length > 0 ? s.titles.map((t) => `<span class="chip ttl">${esc(t.who)}：${esc(t.title)}${t.isNew ? " 🆕" : ""}</span>`).join("") : "";
  const streaks = s.streaks.filter((st) => st.days > 0).map((st) => `<span class="chip">${esc(st.name)} ${st.days}日</span>`).join("");
  return `<section class="adv" aria-labelledby="adv-h">
<h2 id="adv-h">${emoji} わが家の冒険 <small>${esc(s.weekLabel)}</small></h2>
<dl class="advs">
${s.thanks > 0 ? `<dt>ありがとう</dt><dd><b>${s.thanks}</b> 回 ${esc(delta)}</dd>` : ""}
<dt>引き受けた人</dt><dd>${takes}</dd>
${s.finePlay ? `<dt>ファインプレー</dt><dd>${esc(s.finePlay.who)}：${esc(s.finePlay.note)}</dd>` : ""}
${titles ? `<dt>称号</dt><dd>${titles}</dd>` : ""}
${streaks ? `<dt>つづき</dt><dd>${streaks}</dd>` : ""}
</dl>
<p class="lv"><b>レベル${s.level}</b> ${esc(s.levelName)}</p>
<div class="bar" role="progressbar" aria-label="次のレベルまで" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>
<p class="xp">わが家の経験値 ${s.xp}${s.nextLevelXp > 0 ? `　次のレベルまで あと${s.nextLevelXp}` : "　最高レベル"}</p>
<p class="hint">経験値は、引き受け +10・急な引き受け +20・ありがとう（押した人 +2・受けた人 +5）・連絡文 +5。日曜 20:00 に LINE へ今週のカードが届きます</p>
</section>`;
}

function navLink(baseUrl: string, view: CalendarInput["view"], anchor: string) {
  return esc(`${baseUrl}?view=${view}&anchor=${anchor}`);
}

/** 日付の見出し。「3（火）」。今日は丸で囲み「今日」 */
function dayHead(date: string, today: string) {
  const [, , dd] = date.split("-").map(Number);
  const wd = jstWeekday(date);
  return `<h3 class="dn"><span class="num${wd === 0 ? " sun" : wd === 6 ? " sat" : ""}">${dd}</span><span class="wd">${WEEKDAY[wd]}</span>${date === today ? '<span class="tdy">今日</span>' : ""}</h3>`;
}

/** 1日ぶんの中身：送迎の担当 → 予定（時刻順）→ 写真。何もなければ「予定なし」 */
function dayBody(date: string, input: CalendarInput, slots: Slot[], idx: Map<string, number>) {
  const daySlots = slots.filter((s) => s.date === date);
  const cards = input.cards.filter((c) => c.date === date).sort(byTime);
  const photos = input.photos.filter((p) => p.date === date);
  if (daySlots.length === 0 && cards.length === 0 && photos.length === 0) return `<p class="none">予定なし</p>`;
  return `${daySlots.length > 0 ? `<div class="chips">${slotChips(daySlots)}</div>` : ""}${cards.map((c) => cardHtml(c, true, idx)).join("")}${photos.length > 0 ? `<div class="thumbs">${photos.map(photoThumb).join("")}</div>` : ""}`;
}

/** 月の升の中身：日付、子どもごとの頭文字（1人1つ）、送迎（未定は赤い？・決まれば担当の頭文字）、写真は 📷 */
function cellInner(d: string, input: CalendarInput, slots: Slot[], idx: Map<string, number>, photoDays: Set<string>) {
  const [, , dd] = d.split("-").map(Number);
  const wd = jstWeekday(d);
  // 升の中は「何の予定か」まで読めるように、子どもの色の札に題名を入れる（3件まで。長い題名は…で切る）
  const daySlots = slots.filter((s) => s.date === d).sort((a, b) => a.time.localeCompare(b.time));
  // 送迎のカードは、その日の送迎の枠（右下の？・頭文字）と同じことを言うので、枠があれば札を出さない。
  // 枠は前の晩に作られるので、先の日は「🚗遠足」のように短くして残す（「遠足」と「遠足の送り」が並ばない）
  const cards = input.cards
    .filter((c) => c.date === d)
    .filter((c) => !(c.kind === "送迎" && daySlots.some((s) => s.time === (c.time ?? "17:30"))))
    .map((c) => (c.kind === "送迎" ? { ...c, title: `🚗${c.title.replace(/の?(送り迎え|送迎|お迎え|迎え|送り)$/, "") || "送迎"}` } : c))
    .sort(byTime);
  const marks: string[] = [];
  if (daySlots.some(undecided)) marks.push(`<i class="pk nd" title="送迎の担当が未定">？</i>`);
  for (const s of daySlots.filter((s) => !undecided(s)).slice(0, 2)) marks.push(`<i class="pk ok">${esc(adultInitial(slotWho(s)))}</i>`);
  const chips = cards
    .slice(0, 3)
    .map((c) => {
      // だれの予定かは色で（凡例と同じ）。升が狭いので頭文字は付けず、題名だけを入れる
      const all = !c.child || c.child === "全員";
      return `<i class="mev${all ? " all" : ""}" ${all ? "" : childStyle(idx, c.child)} title="${esc(c.title)}">${esc(c.title)}</i>`;
    })
    .join("");
  const extra = cards.length > 3 ? `<span class="more">+${cards.length - 3}</span>` : "";
  return `<span class="dn"><span class="num${wd === 0 ? " sun" : wd === 6 ? " sat" : ""}">${dd}</span>${photoDays.has(d) ? '<span class="cam" aria-label="写真あり">📷</span>' : ""}</span><span class="evs">${chips}${extra}</span><span class="pks">${marks.join("")}</span>`;
}

/** 月の升目と、その月の各週の中身（週の表示は、この中身を1週ずつ出す）。1枚に全部入れておき、切り替えは JS で */
function monthAndWeeks(input: CalendarInput, idx: Map<string, number>) {
  const first = firstOfMonth(input.anchor);
  const next = addMonths(first, 1);
  const start = mondayOf(first);
  const slots = liveSlots(input.slots);
  const photoDays = new Set(input.photos.map((p) => p.date));
  const cells: string[] = [];
  const weeks: string[] = [];
  let week: string[] = [];
  let monday = start;
  for (let d = start; d < next || jstWeekday(d) !== 1; d = addDays(d, 1)) {
    if (jstWeekday(d) === 1) {
      monday = d;
      week = [];
    }
    const inMonth = d >= first && d < next;
    const cls = ["mcell", inMonth ? "" : "out", d === input.today ? "today" : ""].filter(Boolean).join(" ");
    const inner = cellInner(d, input, slots, idx, photoDays);
    cells.push(`<button type="button" class="${cls}" data-day="${esc(d)}" data-week="${esc(monday)}" aria-label="${esc(shortDate(d))}の予定を見る">${inner}</button>`);
    week.push(`<section class="day${d === input.today ? " today" : ""}${inMonth ? "" : " out"}" id="d-${esc(d)}" data-day="${esc(d)}">${dayHead(d, input.today)}${dayBody(d, input, slots, idx)}</section>`);
    if (jstWeekday(d) === 0) {
      const [, m1, d1] = monday.split("-").map(Number);
      const [, m2, d2] = d.split("-").map(Number);
      const label = `${m1}/${d1}〜${m1 === m2 ? "" : `${m2}/`}${d2}`;
      weeks.push(`<div class="wk" data-week="${esc(monday)}" data-label="${esc(label)}" data-prev="${esc(addDays(monday, -7))}" data-next="${esc(addDays(monday, 7))}" hidden>${week.join("")}</div>`);
    }
  }
  const head = WEEKDAY.slice(1)
    .concat(WEEKDAY[0])
    .map((w, i) => `<div class="mh${i === 5 ? " sat" : i === 6 ? " sun" : ""}">${w}</div>`)
    .join("");
  const month = `<section id="month" class="view" data-label="${esc(monthLabel(first))}" data-prev="${navLink(input.baseUrl, "month", addMonths(first, -1))}" data-next="${navLink(input.baseUrl, "month", next)}">
<div class="mgrid">${head}${cells.join("")}</div>
<p class="hint">日にちを押すと、その週の予定が読めます</p>
</section>`;
  const weekSec = `<section id="week" class="view" data-first="${esc(start)}" data-last="${esc(monday)}">
<button type="button" class="btn back" id="back">← 月に戻る</button>
${weeks.join("")}
</section>`;
  return { month, weekSec, first };
}

/**
 * 今日と明日：開いてすぐ「だれが送る・迎える」「何を持たせる」が分かるように、月の升目より上に置く。
 * 共働きの朝は、このページを開く時間が10秒しかない前提
 */
function soonHtml(input: CalendarInput, idx: Map<string, number>) {
  const slots = liveSlots(input.slots);
  const tomorrow = addDays(input.today, 1);
  const day = (date: string, word: string) =>
    `<div class="sd"><h3 class="sdh"><span class="tag">${word}</span>${esc(shortDate(date))}</h3>${dayBody(date, input, slots, idx)}</div>`;
  return `<section class="soon" id="soon" aria-label="今日と明日">${day(input.today, "今日")}${day(tomorrow, "明日")}</section>`;
}

/** 日付が読めなかったカード。一番下にまとめる */
function undatedHtml(cards: Card[], idx: Map<string, number>) {
  const list = cards.filter((c) => !c.date);
  if (list.length === 0) return "";
  return `<section class="undated"><h2>日にち未定の予定</h2>${list.map((c) => cardHtml(c, false, idx)).join("")}</section>`;
}

// 文字の大きさは html の font-size（rem の基準）で決める。17/18/22px。升の数字は 0.85rem（15px 以上）
const CSS = `
:root{--ink:#3A2F24;--sub:#7A6A56;--line:#E6D9C3;--bg:#FFF8EA;--card:#FFFFFF;--bg2:#F6EEDD;--ev:#1F6F8B;--sv:#2E7D5B;--sv-bg:#DFF2E6;--nd:#C0392B;--nd-bg:#FDE3E0;--today:#3A2F24;--tdy-bg:#FFF1C2}
html{font-size:18px;-webkit-text-size-adjust:100%}
html[data-fs=s]{font-size:17px}
html[data-fs=l]{font-size:22px}
*{box-sizing:border-box;min-width:0}
body{margin:0;font:1rem/1.45 -apple-system,"Hiragino Maru Gothic ProN","Hiragino Sans","Noto Sans JP",sans-serif;color:var(--ink);background:var(--bg);overflow-x:clip}
h1{font-size:1.15rem;margin:0}
h2{font-size:1.1rem;margin:16px 0 8px}
h3{font-size:1rem;margin:0 0 6px}
p{margin:8px 0}
a{color:var(--ev)}
button{font:inherit;color:inherit}
.top{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:2px solid var(--line);padding:6px 10px 5px;display:flex;flex-direction:column;gap:5px}
.row{display:flex;align-items:center;gap:4px;flex-wrap:nowrap;width:100%}
.row>*{flex-shrink:0}
.row>.range,.row>h1{flex:1 1 0;min-width:2rem}
.row1 h1{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;min-width:44px;padding:4px 10px;border:2px solid var(--ink);border-radius:12px;background:var(--card);color:var(--ink);font-weight:bold;text-decoration:none;cursor:pointer;line-height:1.2;white-space:nowrap}
.btn[aria-pressed=true]{background:var(--ink);color:#fff}
.btn.sm{min-width:40px;min-height:40px;padding:2px 7px;border-radius:10px}
.range{flex:1 1 auto;text-align:center;font-weight:bold;font-size:1rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.02em}
.grp{display:inline-flex;gap:4px;align-items:center}
.grp .lab{font-weight:bold;color:var(--sub);padding:0 2px}
.grp .fs{min-width:34px;padding:2px 5px;min-height:34px;border-width:1px;border-radius:8px;font-size:.9rem}
.legend{display:flex;flex-wrap:wrap;gap:2px 10px;font-size:.8rem;color:var(--sub);line-height:1.3}
.lg{display:inline-flex;align-items:center;gap:4px;white-space:nowrap}
.ci,.lg i{display:inline-flex;align-items:center;justify-content:center;width:1.35rem;height:1.35rem;border-radius:50%;font-size:.8rem;font-weight:bold;font-style:normal;flex-shrink:0}
.ci.all,.lg i.all{background:#E8E1D3;color:var(--ink)}
.lg i.nd{background:var(--nd);color:#fff}
main{padding:10px 12px 24px}
.view{display:none}
.view.on{display:block}
.num{font-weight:bold}
.num.sun{color:var(--nd)}
.num.sat{color:var(--ev)}
.dn{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.wd{color:var(--sub);font-weight:normal}
.tdy{font-size:.8em;background:var(--ink);color:#fff;border-radius:999px;padding:1px 10px}
.none{color:var(--sub);margin:4px 0}
.hint{color:var(--sub);font-size:.85rem;margin:8px 0 0;text-align:center}
/* 今日と明日：開いてすぐ見る所。月の升目より上 */
.soon{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 0 12px}
.soon[hidden]{display:none}
.sd{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:8px 10px;min-width:0}
.sd:first-child{border:2px solid var(--ink)}
.sdh{display:flex;align-items:center;gap:6px;margin:0 0 4px;font-size:1rem}
.sdh .tag{background:var(--ink);color:#fff;border-radius:999px;padding:1px 10px;font-size:.85rem}
.sd:nth-child(2) .tag{background:var(--sub)}
.sd .chips{margin:2px 0 4px}.sd .thumbs{display:none}
@media (max-width:420px){.soon{grid-template-columns:1fr}}
h2 small{font-weight:normal;color:var(--sub);font-size:.8rem;margin-left:8px}
.nb{white-space:nowrap}
/* 月：升目 */
.mgrid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:2px}
.mh{text-align:center;color:var(--sub);font-weight:bold;font-size:.8rem;padding:2px 0}
.mh.sun{color:var(--nd)}.mh.sat{color:var(--ev)}
.mcell{display:flex;flex-direction:column;align-items:stretch;gap:2px;min-height:4rem;padding:3px 1px 4px;text-align:left;background:var(--card);border:2px solid transparent;border-radius:8px;cursor:pointer;box-shadow:0 1px 0 var(--line)}
.mcell .dn{gap:2px;line-height:1.1;justify-content:space-between}
.mcell .num{font-size:.85rem}
.mcell .cam{font-size:.7rem}
.mcell.today{border-color:var(--today);background:var(--tdy-bg)}
.mcell.today .num{background:var(--ink);color:#fff;border-radius:50%;width:1.4rem;height:1.4rem;display:inline-flex;align-items:center;justify-content:center}
.mcell.out{background:transparent;box-shadow:none;color:#B5A692}
.mcell.out .ci,.mcell.out .pk{opacity:.45}
.evs{display:flex;flex-direction:column;gap:2px;min-width:0}
.mev{display:block;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:.64rem;letter-spacing:-.02em;line-height:1.4;font-style:normal;border-radius:4px;padding:0 2px;color:var(--ink)}
.mev.all{background:#E9E3D8}
.pks{display:flex;gap:2px;margin-top:auto}
.pk{display:inline-flex;align-items:center;justify-content:center;min-width:1.15rem;height:1.15rem;padding:0 3px;border-radius:5px;font-size:.7rem;font-weight:bold;font-style:normal}
.pk.nd{background:var(--nd);color:#fff}
.pk.ok{background:var(--sv-bg);color:var(--sv)}
.more{font-size:.7rem;color:var(--sub)}
/* わが家の冒険 */
.adv{margin:14px 0 0;padding:12px 14px;border:1px solid var(--line);border-radius:12px;background:var(--card)}
.adv h2{margin:0 0 6px;font-size:1.1rem}.adv h2 small{font-weight:normal;color:var(--sub);font-size:.85rem}
.adv .lv{margin:0;font-size:1.15rem}.adv .lv b{margin-right:6px}
.adv .bar{height:14px;border-radius:999px;background:var(--bg2,#EFE8DC);overflow:hidden;margin:6px 0 2px}
.adv .bar span{display:block;height:100%;background:linear-gradient(90deg,#F2B544,#E0503F);border-radius:999px}
.adv .xp{margin:0 0 8px;color:var(--sub);font-size:.9rem}
.advs{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;margin:0;align-items:baseline}
.advs dt{color:var(--sub);font-size:.9rem;white-space:nowrap}.advs dd{margin:0;display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.chip{display:inline-block;padding:1px 8px;border-radius:999px;background:var(--bg2,#EFE8DC);font-size:.9rem}
.chip.sv{background:var(--sv-bg);color:var(--sv)}.chip.ttl{background:#FFF1C2}
.growth .nt figcaption .ci{margin-right:3px}
/* 週：1日ずつ縦（768px 以上は7列） */
.back{margin:0 0 10px}
.wk{display:flex;flex-direction:column;gap:10px}
.wk[hidden]{display:none}
.day{border:1px solid var(--line);border-radius:12px;padding:8px 10px;background:var(--card);scroll-margin-top:var(--top,160px)}
.day.out{opacity:.75}
.day.today{border:2px solid var(--ink);background:var(--tdy-bg)}
.day.sel{outline:3px solid var(--ev);outline-offset:1px}
.day h3{margin:0 0 6px}
.day.today .num{display:inline-block;min-width:36px;height:36px;line-height:36px;text-align:center;border-radius:50%;background:var(--ink);color:#fff}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 6px}
.chip{display:inline-block;padding:4px 12px;border-radius:999px;background:var(--sv-bg);color:var(--sv);font-weight:bold;border:2px solid transparent}
.chip.nd{background:var(--nd-bg);color:var(--nd);border-color:var(--nd)}
.ev{display:flex;gap:8px;align-items:flex-start;background:var(--bg2);border-radius:8px;padding:6px 8px;margin:4px 0;overflow-wrap:anywhere}
.ev .ci{margin-top:2px}
.evb{flex:1 1 auto}
.ev .t{color:var(--ev);font-weight:bold;margin-right:6px}
.ev small{display:block;font-size:.95em;color:var(--sub)}
.thumbs{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
.notices{margin-top:20px;padding-top:12px;border-top:2px solid var(--line)}
.notices h2{font-size:1.1em;margin:0 0 8px}
.nt{margin:0;width:calc(50% - 3px)}
.nt .ph{width:100%}
.nt img{width:100%;height:auto}
.nt figcaption{font-size:.9em;color:var(--ink)}
/* 写真 */
.ph{border:0;padding:0;background:none;cursor:pointer;margin:0;min-width:44px;min-height:44px}
.ph img{width:80px;height:80px;object-fit:cover;border-radius:6px;border:1px solid var(--line);display:block}
#lb{position:fixed;inset:0;background:rgba(0,0,0,.88);display:none;align-items:center;justify-content:center;flex-direction:column;gap:8px;padding:12px;cursor:pointer;z-index:9}
#lb.on{display:flex}
#lb img{max-width:100%;max-height:80vh;border-radius:8px}
#lb p{color:#fff;margin:0}
#lb .close{position:absolute;top:8px;right:8px}
.undated .ev{max-width:600px}
.howto{margin:12px 0 0;padding:8px 12px;border:1px solid var(--line);border-radius:12px;background:var(--card)}
.howto summary{cursor:pointer;font-weight:bold;min-height:44px;display:flex;align-items:center}
.howto code{display:block;overflow-wrap:anywhere;user-select:all;-webkit-user-select:all;margin-top:4px;background:var(--bg2);padding:6px;border-radius:6px}
.howto ol,.howto ul{margin:4px 0 0;padding-left:24px}
.howto p{margin:8px 0 0}
@media(min-width:768px){
  .top{padding:10px 20px 8px}
  main{padding:14px 20px 24px;max-width:1200px;margin:0 auto}
  .wk{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px}
  .mcell{min-height:6rem;padding:6px}
  .mcell .num{font-size:1rem}
  .mcell .ci{width:1.4rem;height:1.4rem;font-size:.85rem}
  .pk{font-size:.85rem;height:1.4rem}
}
@media print{.top,.howto,.hint,.back{display:none}.view,.wk{display:block}main{padding:0}}
`;

// JS は5つ：文字の大きさ／月↔週の切り替え（前・次・今日も表示に合わせる）／月の升を押すとその週へ／週の前後は同じ月の中なら読み込みなし／写真の拡大
const JS = `
(function(){
  var KEY='dandori-fs';
  var html=document.documentElement;
  function fs(v,save){
    if(v==='m'){html.removeAttribute('data-fs')}else{html.setAttribute('data-fs',v)}
    document.querySelectorAll('.fs').forEach(function(b){b.setAttribute('aria-pressed',b.dataset.fs===v?'true':'false')});
    if(save){try{localStorage.setItem(KEY,v)}catch(e){}}
  }
  var saved='m';try{saved=localStorage.getItem(KEY)||'m'}catch(e){}
  fs(saved==='s'||saved==='l'?saved:'m',false);
  document.querySelectorAll('.fs').forEach(function(b){b.addEventListener('click',function(){fs(b.dataset.fs,true)})});

  var P=window.__cal||{};
  var month=document.getElementById('month'),week=document.getElementById('week');
  var range=document.getElementById('range'),prev=document.getElementById('nav-prev'),next=document.getElementById('nav-next'),today=document.getElementById('nav-today');
  var vbtns=document.querySelectorAll('.vw');
  var cur='month',curWeek=null;
  function weekEl(mon){return week.querySelector('.wk[data-week="'+mon+'"]')}
  var soon=document.getElementById('soon');
  function showMonth(){
    cur='month';
    if(soon)soon.hidden=false;
    month.classList.add('on');week.classList.remove('on');
    range.textContent=month.dataset.label;
    prev.href=month.dataset.prev;next.href=month.dataset.next;
    vbtns.forEach(function(b){b.setAttribute('aria-pressed',b.dataset.view==='month'?'true':'false')});
    window.scrollTo(0,0);
  }
  function showWeek(mon,day){
    var w=weekEl(mon);
    if(!w){location.href=P.base+'?view=week&anchor='+mon;return}
    cur='week';curWeek=mon;
    if(soon)soon.hidden=true;
    week.querySelectorAll('.wk').forEach(function(x){x.hidden=x!==w});
    week.querySelectorAll('.day.sel').forEach(function(d){d.classList.remove('sel')});
    month.classList.remove('on');week.classList.add('on');
    range.textContent=w.dataset.label;
    prev.href=weekEl(w.dataset.prev)?'#':P.base+'?view=week&anchor='+w.dataset.prev;
    next.href=weekEl(w.dataset.next)?'#':P.base+'?view=week&anchor='+w.dataset.next;
    vbtns.forEach(function(b){b.setAttribute('aria-pressed',b.dataset.view==='week'?'true':'false')});
    if(day){var d=document.getElementById('d-'+day);if(d){d.classList.add('sel');var h=document.querySelector('.top');html.style.setProperty('--top',(h?h.offsetHeight:0)+8+'px');setTimeout(function(){d.scrollIntoView({block:'start',behavior:'smooth'})},0)}}
    else{window.scrollTo(0,0)}
  }
  function go(dir){
    if(cur!=='week')return true;
    var w=weekEl(curWeek);var to=w&&w.dataset[dir];
    if(to&&weekEl(to)){showWeek(to);return false}
    return true;
  }
  prev.addEventListener('click',function(e){if(!go('prev'))e.preventDefault()});
  next.addEventListener('click',function(e){if(!go('next'))e.preventDefault()});
  today.addEventListener('click',function(e){
    if(P.todayWeek&&weekEl(P.todayWeek)){e.preventDefault();if(cur==='week'){showWeek(P.todayWeek,P.today)}else{showMonth()}}
  });
  vbtns.forEach(function(b){b.addEventListener('click',function(){
    if(b.dataset.view==='month'){showMonth()}else{showWeek(P.anchorWeek,P.anchor)}
  })});
  document.getElementById('back').addEventListener('click',showMonth);
  document.querySelectorAll('.mcell[data-day]').forEach(function(c){c.addEventListener('click',function(){showWeek(c.dataset.week,c.dataset.day)})});

  var lb=document.getElementById('lb'),img=lb.querySelector('img'),cap=lb.querySelector('p');
  document.querySelectorAll('.ph').forEach(function(p){p.addEventListener('click',function(){
    img.src=p.dataset.src;cap.textContent=p.dataset.label||'';lb.classList.add('on');
  })});
  lb.addEventListener('click',function(){lb.classList.remove('on');img.src=''});

  // 最初の表示。LINE から来たとき（URL に view が無い）は月。週のリンクで来たときだけ週
  var q=new URLSearchParams(location.search);
  if(q.get('view')==='week'){showWeek(P.anchorWeek,P.anchor)}else{showMonth()}
})();
`;

// 最初の描画の前に文字の大きさを戻す（ちらつき防止）。失敗しても何もしない
const HEAD_JS = `try{var f=localStorage.getItem('dandori-fs');if(f==='s'||f==='l'){document.documentElement.setAttribute('data-fs',f)}}catch(e){}`;

/** HTML 1枚（CSS/JS はインライン。外部の読み込みなし）。最初は月の升目、日を押すとその週。字は大きく、ログインなし */
export function renderCalendar(raw: CalendarInput): string {
  const input = { ...raw, cards: normCards(raw.cards) };
  const family = input.familyName || "わが家";
  const icsUrl = `${input.baseUrl}.ics`;
  const idx = childIndex(input);
  const { month, weekSec, first } = monthAndWeeks(input, idx);
  const monthOn = input.view !== "week";
  const params = {
    base: input.baseUrl,
    today: input.today,
    todayWeek: mondayOf(input.today),
    anchor: input.anchor,
    anchorWeek: mondayOf(input.anchor),
  };
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<title>${esc(family)}のだんどり帳</title>
<script>${HEAD_JS}</script>
<style>${CSS}</style>
</head>
<body>
<header class="top">
  <div class="row row1">
    <h1>${esc(family)}の<span class="nb">だんどり帳</span></h1>
    <span class="grp" role="group" aria-label="文字の大きさ">
      <span class="lab" aria-hidden="true">あ</span>
      <button type="button" class="btn fs" data-fs="s" aria-pressed="false" aria-label="文字を小さく">小</button>
      <button type="button" class="btn fs" data-fs="m" aria-pressed="true" aria-label="文字をふつうに">中</button>
      <button type="button" class="btn fs" data-fs="l" aria-pressed="false" aria-label="文字を大きく">大</button>
    </span>
  </div>
  <nav class="row row2" aria-label="操作">
    <a class="btn sm" id="nav-prev" href="${navLink(input.baseUrl, "month", addMonths(first, -1))}" aria-label="前へ">＜</a>
    <span class="range" id="range">${esc(monthLabel(first))}</span>
    <a class="btn sm" id="nav-next" href="${navLink(input.baseUrl, "month", addMonths(first, 1))}" aria-label="次へ">＞</a>
    <a class="btn sm" id="nav-today" href="${navLink(input.baseUrl, "month", input.today)}">今日</a>
    <span class="grp" role="group" aria-label="表示の切り替え">
      <button type="button" class="btn sm vw" data-view="month" aria-pressed="${monthOn}">月</button>
      <button type="button" class="btn sm vw" data-view="week" aria-pressed="${!monthOn}">週</button>
    </span>
  </nav>
  ${legendHtml(idx)}
</header>
<main>
${soonHtml(input, idx)}
${month}
${weekSec}
${undatedHtml(input.cards, idx)}
${adventureHtml(input.adventure, input.today)}
${growthHtml(input.photos, idx)}
${noticesHtml(input.photos)}
<details class="howto">
  <summary>だんどりさんへの頼み方（家族の LINE で）</summary>
  <ul>
    <li>📷 お便り・連絡アプリの画面を送る → 予定になって、ここに並ぶ（紙は捨ててOK）</li>
    <li>🚗「明日のお迎え だれか」→ 家族の名前ボタン。先に押した人に決まる</li>
    <li>🙋「5日の朝の送り 難しい」→ だんどりさんが家族に聞き直す</li>
    <li>👉「ばあばに頼んで」「@名前 にお願いして」→ その人に名指しで聞く</li>
    <li>🤒「熱で休み」→ 園・学校・習い事への文を［コピー］／［📞 電話］</li>
    <li>🌱 写真を送って「思い出に入れておいて」→ 成長記録に残る</li>
    <li>🙏 ありがとうは、決まった札を長押ししてリアクションで</li>
  </ul>
</details>
<details class="howto">
  <summary>Googleカレンダーに入れる</summary>
  <ol>
    <li>下の URL を長押ししてコピー</li>
    <li>Googleカレンダーの「他のカレンダー」＋ →「URL で追加」に貼る</li>
  </ol>
  <code>${esc(icsUrl)}</code>
  <p>このだんどり帳の URL は家族だけに。合言葉の代わりなので、ほかの人に送らないでください。</p>
</details>
</main>
<div id="lb" role="dialog" aria-label="写真"><button type="button" class="btn close" aria-label="閉じる">閉じる</button><img alt=""><p></p></div>
<script>window.__cal=${JSON.stringify(params).replace(/</g, "\\u003c")};</script>
<script>${JS}</script>
</body>
</html>`;
}

// ── ICS ──────────────────────────────────────────────────

/** iCalendar のテキストに使えない文字を逃がす */
function icsText(text: string) {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** 75バイトで折り返す。日本語を途中で切らないよう文字ごとに数える。続きの行は先頭の空白が1バイト分 */
function fold(line: string) {
  const enc = new TextEncoder();
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > limit) {
      out.push(cur);
      cur = " ";
      bytes = 1;
      limit = 75;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join("\r\n");
}

/** 文字列から安定した短い ID（FNV-1a）。UID に本文を入れない */
function hash(text: string) {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(text)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** "2026-11-04" → "20261104" */
function icsDate(date: string) {
  return date.replace(/-/g, "");
}

/** epoch ms → "20261104T173000"（JST の壁時計。TZID と組で使う） */
function icsLocal(ms: number) {
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().replace(/[-:]/g, "").slice(0, 15);
}

/** epoch ms → "20261104T083000Z" */
function icsUtc(ms: number) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
}

interface IcsEvent {
  uid: string;
  date: string;
  time: string | null;
  minutes: number; // 時刻があるときの長さ
  summary: string;
  description?: string;
  location?: string;
}

function vevent(ev: IcsEvent) {
  const lines = ["BEGIN:VEVENT", `UID:${ev.uid}`];
  if (ev.time) {
    const start = jstToMs(ev.date, ev.time);
    lines.push(`DTSTAMP:${icsUtc(start)}`);
    lines.push(`DTSTART;TZID=Asia/Tokyo:${icsLocal(start)}`);
    lines.push(`DTEND;TZID=Asia/Tokyo:${icsLocal(start + ev.minutes * 60_000)}`);
  } else {
    // 終日。DTEND は翌日（終わりは含まない）
    lines.push(`DTSTAMP:${icsUtc(jstToMs(ev.date, "00:00"))}`);
    lines.push(`DTSTART;VALUE=DATE:${icsDate(ev.date)}`);
    lines.push(`DTEND;VALUE=DATE:${icsDate(addDays(ev.date, 1))}`);
  }
  lines.push(`SUMMARY:${icsText(ev.summary)}`);
  if (ev.description) lines.push(`DESCRIPTION:${icsText(ev.description)}`);
  if (ev.location) lines.push(`LOCATION:${icsText(ev.location)}`);
  lines.push("END:VEVENT");
  return lines;
}

/** カードの中身を説明欄に。改行区切り */
function cardDescription(card: Card) {
  const parts: string[] = [];
  if (card.child) parts.push(`だれ：${card.child}`);
  parts.push(`種類：${card.kind}`);
  if (card.items.length > 0) parts.push(`持ち物：${card.items.join("・")}`);
  if (card.money !== null) parts.push(`集金：${card.money}円`);
  if (card.deadline) parts.push(`期限：${card.deadline}`);
  if (card.who_acts !== "未定") parts.push(`担当：${card.who_acts}`);
  return parts.join("\n");
}

/** iCalendar（RFC 5545）。予定カードは VEVENT（date があるもの。time があれば時刻つき、なければ終日）、送迎の枠は「17:30 保育所お迎え：ばあば」（未定なら「だれ？」）。UID は安定（card は child+title+date、slot は id）。TZID は Asia/Tokyo。改行は CRLF、75バイトで折り返す */
export function renderIcs(input: { cards: Card[]; slots: Slot[]; familyName?: string }): string {
  const family = input.familyName || "わが家";
  const events: IcsEvent[] = [];
  for (const card of normCards(input.cards)) {
    if (!card.date) continue;
    events.push({
      uid: `card-${hash(`${card.child}|${card.title}|${card.date}`)}@kazoku-dandori`,
      date: card.date,
      time: card.time,
      minutes: 60,
      summary: cardTitle(card),
      description: cardDescription(card),
      location: card.place ?? undefined,
    });
  }
  for (const slot of liveSlots(input.slots)) {
    events.push({
      uid: `slot-${slot.id}@kazoku-dandori`,
      date: slot.date,
      time: slot.time,
      minutes: 30,
      summary: `${slot.time} ${slot.place}${kindWord(slot.kind)}：${slotWho(slot)}`,
      description: slot.children.length > 0 ? `だれ：${slot.children.join("・")}` : undefined,
      location: slot.place,
    });
  }
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//kazoku-dandori//だんどりさん//JA",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(`${family}の予定`)}`,
    "X-WR-TIMEZONE:Asia/Tokyo",
    // 日本は夏時間なし。STANDARD だけ
    "BEGIN:VTIMEZONE",
    "TZID:Asia/Tokyo",
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    "TZOFFSETFROM:+0900",
    "TZOFFSETTO:+0900",
    "TZNAME:JST",
    "END:STANDARD",
    "END:VTIMEZONE",
    ...events.flatMap(vevent),
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

/** 「Googleカレンダーに追加」のリンク。time が無ければ終日。JST を UTC に直す。date が無ければ null */
export function googleCalendarLink(raw: Card): string | null {
  const date = raw.date;
  if (!date) return null;
  const card = { ...raw, time: normTime(raw.time) };
  const dates = card.time
    ? `${icsUtc(jstToMs(date, card.time))}/${icsUtc(jstToMs(date, card.time) + 60 * 60_000)}`
    : `${icsDate(date)}/${icsDate(addDays(date, 1))}`;
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: cardTitle(card),
    dates,
    details: cardDescription(card),
  });
  if (card.place) params.set("location", card.place);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
