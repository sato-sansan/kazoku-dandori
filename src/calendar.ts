// 家族の予定ページ（ログインなし・合言葉つき URL）と購読用の ICS。純粋関数だけ（取り出し・保存は family.ts）
// ばあばがスマホで見る前提：字は 18px 以上、色は3色（予定・送迎・未定）、Google カレンダーと同じ並び

import type { Card } from "./card";
import type { Slot } from "./types";
import { addDays, jstToMs, jstWeekday } from "./time";

export interface CalendarInput {
  today: string; // YYYY-MM-DD（JST）
  view: "week" | "month";
  anchor: string; // 表示の基準日 YYYY-MM-DD
  cards: Card[]; // 予定カード（date が null のものは「日付未定」の欄にまとめる）
  slots: Slot[]; // 送迎の枠
  photos: { date: string; url: string; label: string }[]; // その日の写真（お便りの写真など）。url は期限つき
  baseUrl: string; // "https://.../cal/<token>" ページ自身の URL（週↔月の切り替えリンクに使う）
  familyName?: string; // 「さとう家」など。無ければ「わが家」
}

type Photo = CalendarInput["photos"][number];

const WEEKDAY = ["日", "月", "火", "水", "木", "金", "土"];
// 週の時刻の縦軸。この外に予定があれば広げる
const HOUR_FROM = 7;
const HOUR_TO = 20;

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

/** 未定＝担当がいない */
function undecided(slot: Slot) {
  return slot.who === null;
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

/** 1枚のカード（週の升・日付未定の欄で使う） */
function cardHtml(card: Card, showTime: boolean) {
  const time = showTime && card.time ? `<span class="t">${esc(card.time)}</span> ` : "";
  const note = cardNote(card);
  return `<div class="ev">${time}<b>${esc(cardTitle(card))}</b>${note ? `<small>${esc(note)}</small>` : ""}</div>`;
}

/** 日ごとの送迎の担当。「朝 ママ」「夕 ばあば」。同じ種類が2つ以上ある日は「17:30 保育所 じいじ」と時刻と場所で呼ぶ。未定は赤で「だれ？」 */
function slotChips(slots: Slot[]) {
  const sorted = [...slots].sort((a, b) => a.time.localeCompare(b.time));
  return sorted
    .map((s) => {
      const same = sorted.filter((o) => o.kind === s.kind).length;
      const label = same > 1 ? `${s.time} ${s.place}` : s.kind === "送り" ? "朝" : "夕";
      const who = s.who ?? "だれ？";
      return `<span class="chip${undecided(s) ? " nd" : ""}">${esc(label)} ${esc(who)}</span>`;
    })
    .join("");
}

function photoThumb(p: Photo) {
  return `<button type="button" class="ph" data-src="${esc(p.url)}" data-label="${esc(p.label)}"><img src="${esc(p.url)}" alt="${esc(p.label)}" loading="lazy"></button>`;
}

function navLink(baseUrl: string, view: CalendarInput["view"], anchor: string) {
  return esc(`${baseUrl}?view=${view}&anchor=${anchor}`);
}

/** 週：上に曜日・左に時刻。各日の上に送迎の担当と終日の予定 */
function weekHtml(input: CalendarInput) {
  const monday = mondayOf(input.anchor);
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const slots = liveSlots(input.slots);
  const inWeek = input.cards.filter((c) => c.date && days.includes(c.date));

  // 縦軸の範囲。早朝や夜の予定があれば広げる
  let from = HOUR_FROM;
  let to = HOUR_TO;
  for (const c of inWeek) {
    if (!c.time) continue;
    const h = Number(c.time.slice(0, 2));
    from = Math.min(from, h);
    to = Math.max(to, h + 1);
  }
  const hours = Array.from({ length: to - from }, (_, i) => from + i);

  const head = days
    .map((d) => {
      const [, , dd] = d.split("-").map(Number);
      const today = d === input.today ? " today" : "";
      const daySlots = slots.filter((s) => s.date === d);
      const allDay = inWeek.filter((c) => c.date === d && !c.time).sort(byTime);
      const photos = input.photos.filter((p) => p.date === d);
      return `<div class="dh${today}">
  <div class="dn"><span class="num">${dd}</span><span class="wd">${WEEKDAY[jstWeekday(d)]}</span></div>
  <div class="chips">${slotChips(daySlots)}</div>
  <div class="allday">${allDay.map((c) => cardHtml(c, false)).join("")}${photos.map(photoThumb).join("")}</div>
</div>`;
    })
    .join("");

  const rows = hours
    .map((h) => {
      const cells = days
        .map((d) => {
          const here = inWeek
            .filter((c) => c.date === d && c.time && Number(c.time.slice(0, 2)) === h)
            .sort(byTime);
          return `<div class="cell${d === input.today ? " today" : ""}">${here.map((c) => cardHtml(c, true)).join("")}</div>`;
        })
        .join("");
      return `<div class="hl">${h}:00</div>${cells}`;
    })
    .join("");

  const label = `${shortDate(days[0])}〜${shortDate(days[6])}`;
  return `<section id="week" class="view">
<nav class="sub">
  <a class="arrow" href="${navLink(input.baseUrl, "week", addDays(monday, -7))}" aria-label="前の週">‹</a>
  <span class="range">${esc(label)}</span>
  <a class="arrow" href="${navLink(input.baseUrl, "week", addDays(monday, 7))}" aria-label="次の週">›</a>
</nav>
<div class="scroll"><div class="wgrid">
  <div class="corner"></div>${head}
  ${rows}
</div></div>
</section>`;
}

/** 月：升目。1升に題名を最大3つ、超えたら「+n」。送迎の未定は赤い点、写真は 📷 */
function monthHtml(input: CalendarInput) {
  const first = firstOfMonth(input.anchor);
  const next = addMonths(first, 1);
  const start = mondayOf(first);
  // 月末の日曜まで。最大6週
  const cells: string[] = [];
  const slots = liveSlots(input.slots);
  const photoDays = new Set(input.photos.map((p) => p.date));
  for (let d = start; d < next || jstWeekday(d) !== 1; d = addDays(d, 1)) {
    const inMonth = d >= first && d < next;
    const [, , dd] = d.split("-").map(Number);
    const cards = input.cards.filter((c) => c.date === d).sort(byTime);
    const nd = slots.some((s) => s.date === d && undecided(s));
    const shown = cards.slice(0, 3);
    const more = cards.length - shown.length;
    const cls = ["mcell", inMonth ? "" : "out", d === input.today ? "today" : ""].filter(Boolean).join(" ");
    cells.push(`<div class="${cls}">
  <div class="dn"><span class="num">${dd}</span>${nd ? '<span class="dot" title="送迎がまだ決まっていません"></span>' : ""}${photoDays.has(d) ? '<span class="cam">📷</span>' : ""}</div>
  ${shown.map((c) => `<div class="mt">${esc(cardTitle(c))}</div>`).join("")}
  ${more > 0 ? `<div class="more">+${more}</div>` : ""}
</div>`);
  }
  const photos = input.photos.filter((p) => p.date >= first && p.date < next).sort((a, b) => a.date.localeCompare(b.date));
  return `<section id="month" class="view">
<nav class="sub">
  <a class="arrow" href="${navLink(input.baseUrl, "month", addMonths(first, -1))}" aria-label="前の月">‹</a>
  <span class="range">${esc(monthLabel(first))}</span>
  <a class="arrow" href="${navLink(input.baseUrl, "month", next)}" aria-label="次の月">›</a>
</nav>
<div class="scroll"><div class="mgrid">
  ${WEEKDAY.slice(1).concat(WEEKDAY[0]).map((w) => `<div class="mh">${w}</div>`).join("")}
  ${cells.join("")}
</div></div>
${
  photos.length > 0
    ? `<h2>この月の写真</h2><div class="photos">${photos.map((p) => `<figure>${photoThumb(p)}<figcaption>${esc(shortDate(p.date))} ${esc(p.label)}</figcaption></figure>`).join("")}</div>`
    : ""
}
</section>`;
}

/** 日付が読めなかったカード。一番下にまとめる */
function undatedHtml(cards: Card[]) {
  const list = cards.filter((c) => !c.date);
  if (list.length === 0) return "";
  return `<section class="undated"><h2>日付が決まっていない予定</h2>${list.map((c) => cardHtml(c, false)).join("")}</section>`;
}

const CSS = `
:root{--ink:#222;--line:#ccc;--ev:#1a5fb4;--ev-bg:#e6eefc;--sv:#1b7f4c;--sv-bg:#e3f3ea;--nd:#c0202a;--nd-bg:#fbe4e6;--today:#fff6d6}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;padding:12px;font:18px/1.4 -apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;color:var(--ink);background:#fff}
h1{font-size:24px;margin:0 0 8px}
h2{font-size:20px;margin:20px 0 8px}
a{color:var(--ev)}
.top{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between}
.toggle{display:flex;gap:4px}
.toggle button{font-size:18px;padding:8px 16px;border:2px solid var(--ev);background:#fff;color:var(--ev);border-radius:8px;cursor:pointer}
.toggle button[aria-pressed=true]{background:var(--ev);color:#fff}
.sub{display:flex;align-items:center;gap:8px;margin:12px 0}
.arrow{font-size:28px;line-height:1;padding:4px 16px;border:1px solid var(--line);border-radius:8px;text-decoration:none}
.range{font-weight:bold;font-size:20px}
.view{display:none}
.view.on{display:block}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
.today{background:var(--today)}
.num{font-weight:bold}
.today .num{display:inline-block;min-width:32px;height:32px;line-height:32px;text-align:center;border-radius:50%;background:var(--ev);color:#fff}
.dn{display:flex;align-items:center;gap:6px}
.wd{color:#555}
/* 週 */
.wgrid{display:grid;grid-template-columns:56px repeat(7,minmax(110px,1fr));min-width:830px;border-top:1px solid var(--line);border-left:1px solid var(--line)}
.wgrid>*{border-right:1px solid var(--line);border-bottom:1px solid var(--line);min-height:44px;padding:4px}
.corner{background:#f6f6f6}
.dh{padding:6px 4px}
.hl{font-size:18px;color:#555;text-align:right;padding-right:6px;background:#f6f6f6}
.chips{display:flex;flex-wrap:wrap;gap:4px;margin:4px 0}
.chip{font-size:18px;padding:2px 8px;border-radius:12px;background:var(--sv-bg);color:var(--sv)}
.chip.nd{background:var(--nd-bg);color:var(--nd);font-weight:bold}
.ev{background:var(--ev-bg);border-left:4px solid var(--ev);border-radius:4px;padding:4px 6px;margin:2px 0;overflow-wrap:anywhere}
.ev .t{color:var(--ev);font-weight:bold}
.ev small{display:block;font-size:18px;color:#555}
/* 月 */
.mgrid{display:grid;grid-template-columns:repeat(7,minmax(92px,1fr));min-width:644px;border-top:1px solid var(--line);border-left:1px solid var(--line)}
.mgrid>*{border-right:1px solid var(--line);border-bottom:1px solid var(--line);padding:4px}
.mh{text-align:center;background:#f6f6f6;color:#555}
.mcell{min-height:96px}
.mcell.out{color:#aaa;background:#fafafa}
.mt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:var(--ev-bg);border-left:3px solid var(--ev);padding:0 4px;margin:2px 0}
.out .mt{opacity:.5}
.more{color:#555}
.dot{width:12px;height:12px;border-radius:50%;background:var(--nd);display:inline-block}
.cam{font-size:18px}
/* 写真 */
.ph{border:0;padding:0;background:none;cursor:pointer;margin:2px 0}
.ph img{width:72px;height:72px;object-fit:cover;border-radius:6px;border:1px solid var(--line)}
.photos{display:flex;flex-wrap:wrap;gap:12px}
.photos figure{margin:0;width:120px}
.photos .ph img{width:120px;height:120px}
figcaption{font-size:18px}
#lb{position:fixed;inset:0;background:rgba(0,0,0,.85);display:none;align-items:center;justify-content:center;flex-direction:column;gap:8px;padding:12px;cursor:pointer;z-index:9}
#lb.on{display:flex}
#lb img{max-width:100%;max-height:85vh;border-radius:8px}
#lb p{color:#fff;margin:0}
.undated .ev{max-width:600px}
.howto{margin:8px 0;padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:#f6f6f6}
.howto summary{cursor:pointer;font-weight:bold}
.howto code{display:block;overflow-wrap:anywhere;font-size:18px;user-select:all;-webkit-user-select:all;margin-top:4px}
.howto ol{margin:4px 0 0;padding-left:24px}
.howto p{margin:8px 0 0}
@media print{.toggle,.arrow,.howto{display:none}.scroll{overflow:visible}.view{display:block}.wgrid,.mgrid{min-width:0}.wgrid{grid-template-columns:56px repeat(7,1fr)}body{padding:0}}
`;

const JS = `
(function(){
  var btns=document.querySelectorAll('.toggle button');
  function show(v){
    document.querySelectorAll('.view').forEach(function(s){s.classList.toggle('on',s.id===v)});
    btns.forEach(function(b){b.setAttribute('aria-pressed',b.dataset.view===v?'true':'false')});
  }
  btns.forEach(function(b){b.addEventListener('click',function(){show(b.dataset.view)})});
  var lb=document.getElementById('lb'),img=lb.querySelector('img'),cap=lb.querySelector('p');
  document.querySelectorAll('.ph').forEach(function(p){p.addEventListener('click',function(){
    img.src=p.dataset.src;cap.textContent=p.dataset.label||'';lb.classList.add('on');
  })});
  lb.addEventListener('click',function(){lb.classList.remove('on');img.src=''});
})();
`;

/** HTML 1枚（CSS/JS はインライン。外部の読み込みなし）。スマホ優先・大きな字・月は升目、週は時刻の縦軸 */
export function renderCalendar(raw: CalendarInput): string {
  const input = { ...raw, cards: normCards(raw.cards) };
  const family = input.familyName || "わが家";
  const icsUrl = `${input.baseUrl}.ics`;
  // 週も月も1枚に入れておき、切り替えは JS で（読み込み直さない）
  const week = weekHtml(input).replace('class="view"', `class="view${input.view === "week" ? " on" : ""}"`);
  const month = monthHtml(input).replace('class="view"', `class="view${input.view === "month" ? " on" : ""}"`);
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<title>${esc(family)}の予定</title>
<style>${CSS}</style>
</head>
<body>
<header class="top">
  <h1>${esc(family)}の予定</h1>
  <div class="toggle" role="group" aria-label="表示の切り替え">
    <button type="button" data-view="week" aria-pressed="${input.view === "week"}">今週</button>
    <button type="button" data-view="month" aria-pressed="${input.view === "month"}">今月</button>
  </div>
</header>
<details class="howto">
  <summary>Googleカレンダーに入れる</summary>
  <ol>
    <li>下の URL を長押ししてコピー</li>
    <li>Googleカレンダーの「他のカレンダー」＋ →「URL で追加」に貼る</li>
  </ol>
  <code>${esc(icsUrl)}</code>
  <p>この予定ページの URL は家族だけに。合言葉の代わりなので、ほかの人に送らないでください。</p>
</details>
${week}
${month}
${undatedHtml(input.cards)}
<div id="lb" role="dialog" aria-label="写真"><img alt=""><p></p></div>
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
      summary: `${slot.time} ${slot.place}${kindWord(slot.kind)}：${slot.who ?? "だれ？"}`,
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
