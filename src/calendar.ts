// 家族の予定ページ（ログインなし・合言葉つき URL）と購読用の ICS。純粋関数だけ（取り出し・保存は family.ts）
// ばあばがスマホで見る前提：375px で横スクロールなし、字は「あ 小中大」で 16/18/22px、色は3色（予定・送迎・未定）＋黒白、ボタンは 44px 以上
// 月は Google カレンダーと同じ升目。週は無理に7列にせず、1日ずつ縦に並べる（768px 以上で7列）

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
// スマホ優先（375px で横スクロールなし）。週は1日ずつ縦に並ぶ予定表（768px 以上で7列）、月は升目
// 文字は「あ 小・中・大」で 16/18/22px。色は青（予定）・緑（送迎）・赤（未定）＋黒白、コントラスト比 4.5 以上

/** 1枚のカード（週・月の詳細・日付未定の欄で使う） */
function cardHtml(card: Card, showTime: boolean) {
  const time = showTime && card.time ? `<span class="t">${esc(card.time)}</span> ` : "";
  const note = cardNote(card);
  return `<div class="ev">${time}<b>${esc(cardTitle(card))}</b>${note ? `<small>${esc(note)}</small>` : ""}</div>`;
}

/** 日ごとの送迎の担当。「朝 ママ」「夕 ばあば」。同じ種類が2つ以上ある日は「17:30 保育所 じいじ」と時刻と場所で呼ぶ。未定は赤＋太字＋「だれ？」の文字 */
function slotChips(slots: Slot[]) {
  const sorted = [...slots].sort((a, b) => a.time.localeCompare(b.time));
  return sorted
    .map((s) => {
      const same = sorted.filter((o) => o.kind === s.kind).length;
      const label = same > 1 ? `${s.time} ${s.place}` : s.kind === "送り" ? "朝" : "夕";
      const who = s.who ?? "だれ？";
      const nd = undecided(s);
      return `<span class="chip${nd ? " nd" : ""}"${nd ? ' aria-label="送迎の担当がまだ決まっていません"' : ""}>${esc(label)} ${esc(who)}</span>`;
    })
    .join("");
}

function photoThumb(p: Photo) {
  return `<button type="button" class="ph" data-src="${esc(p.url)}" data-label="${esc(p.label)}" aria-label="写真を大きく見る：${esc(p.label)}"><img src="${esc(p.url)}" alt="${esc(p.label)}" loading="lazy"></button>`;
}

/** 残してある写真を、新しい順に一覧で。「あのお便り、どこだっけ」のための置き場 */
function noticesHtml(photos: Photo[]) {
  if (photos.length === 0) return "";
  const sorted = [...photos].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return `<section class="notices" aria-labelledby="nt-h">
<h2 id="nt-h">お便りの写真（${sorted.length}枚）</h2>
<div class="thumbs">${sorted
    .map((p) => `<figure class="nt">${photoThumb(p)}<figcaption>${esc(shortDate(p.date))} ${esc(p.label)}</figcaption></figure>`)
    .join("")}</div>
</section>`;
}

function navLink(baseUrl: string, view: CalendarInput["view"], anchor: string) {
  return esc(`${baseUrl}?view=${view}&anchor=${anchor}`);
}

/** 日付の見出し。「3（火）」。今日は色つき＋「今日」の文字 */
function dayHead(date: string, today: string, tag: "h2" | "h3") {
  const [, , dd] = date.split("-").map(Number);
  const isToday = date === today;
  return `<${tag} class="dn"><span class="num">${dd}</span><span class="wd">${WEEKDAY[jstWeekday(date)]}</span>${isToday ? '<span class="tdy">今日</span>' : ""}</${tag}>`;
}

/** 1日ぶんの中身：送迎の担当 → 予定（時刻順）→ 写真。何もなければ「予定なし」 */
function dayBody(date: string, input: CalendarInput, slots: Slot[]) {
  const daySlots = slots.filter((s) => s.date === date);
  const cards = input.cards.filter((c) => c.date === date).sort(byTime);
  const photos = input.photos.filter((p) => p.date === date);
  if (daySlots.length === 0 && cards.length === 0 && photos.length === 0) return `<p class="none">予定なし</p>`;
  return `${daySlots.length > 0 ? `<div class="chips">${slotChips(daySlots)}</div>` : ""}${cards.map((c) => cardHtml(c, true)).join("")}${photos.length > 0 ? `<div class="thumbs">${photos.map(photoThumb).join("")}</div>` : ""}`;
}

/** 週：月曜から日曜まで1日ずつ縦に並べる（768px 以上は7列） */
function weekHtml(input: CalendarInput, on: boolean) {
  const monday = mondayOf(input.anchor);
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const slots = liveSlots(input.slots);
  const list = days
    .map((d) => `<section class="day${d === input.today ? " today" : ""}">${dayHead(d, input.today, "h2")}${dayBody(d, input, slots)}</section>`)
    .join("");
  const label = `${shortDate(days[0])}〜${shortDate(days[6])}`;
  return `<section id="week" class="view${on ? " on" : ""}" data-prev="${navLink(input.baseUrl, "week", addDays(monday, -7))}" data-next="${navLink(input.baseUrl, "week", addDays(monday, 7))}" data-today="${navLink(input.baseUrl, "week", input.today)}">
<p class="range">${esc(label)}</p>
<div class="days">${list}</div>
</section>`;
}

/** 月：升目。1升に題名を最大2つ、超えたら「+n」。送迎の未定は赤い「だれ？」、写真は 📷。升をタップするとその日の予定が下に広がる */
function monthHtml(input: CalendarInput, on: boolean) {
  const first = firstOfMonth(input.anchor);
  const next = addMonths(first, 1);
  const start = mondayOf(first);
  const slots = liveSlots(input.slots);
  const photoDays = new Set(input.photos.map((p) => p.date));
  const todayIn = input.today >= first && input.today < next;
  const cells: string[] = [];
  const details: string[] = [];
  // 月末の日曜まで。最大6週
  for (let d = start; d < next || jstWeekday(d) !== 1; d = addDays(d, 1)) {
    const inMonth = d >= first && d < next;
    const [, , dd] = d.split("-").map(Number);
    const cards = input.cards.filter((c) => c.date === d).sort(byTime);
    const nd = slots.some((s) => s.date === d && undecided(s));
    const shown = cards.slice(0, 2);
    const more = cards.length - shown.length;
    const cls = ["mcell", inMonth ? "" : "out", d === input.today ? "today" : ""].filter(Boolean).join(" ");
    const inner = `<span class="dn"><span class="num">${dd}</span>${photoDays.has(d) ? '<span class="cam" aria-label="写真あり">📷</span>' : ""}</span>${nd ? '<span class="mt nd">だれ？</span>' : ""}${shown.map((c) => `<span class="mt">${esc(cardTitle(c))}</span>`).join("")}${more > 0 ? `<span class="more">+${more}</span>` : ""}`;
    if (!inMonth) {
      cells.push(`<div class="${cls}" aria-hidden="true">${inner}</div>`);
      continue;
    }
    const id = `md-${esc(d)}`;
    const open = d === input.today;
    cells.push(`<button type="button" class="${cls}" data-day="${esc(d)}" aria-controls="${id}" aria-expanded="${open}" aria-label="${esc(shortDate(d))}の予定を見る">${inner}</button>`);
    details.push(`<div class="mday${d === input.today ? " today" : ""}" id="${id}"${open ? "" : " hidden"}>${dayHead(d, input.today, "h3")}${dayBody(d, input, slots)}</div>`);
  }
  return `<section id="month" class="view${on ? " on" : ""}" data-prev="${navLink(input.baseUrl, "month", addMonths(first, -1))}" data-next="${navLink(input.baseUrl, "month", next)}" data-today="${navLink(input.baseUrl, "month", input.today)}">
<p class="range">${esc(monthLabel(first))}</p>
<div class="mgrid">${WEEKDAY.slice(1).concat(WEEKDAY[0]).map((w) => `<div class="mh">${w}</div>`).join("")}${cells.join("")}</div>
<p class="hint">日にちを押すと、その日の予定が下に出ます</p>
<div class="mdetail">${details.join("")}</div>
${todayIn ? "" : `<p class="none">今日はこの月にありません</p>`}
</section>`;
}

/** 日付が読めなかったカード。一番下にまとめる */
function undatedHtml(cards: Card[]) {
  const list = cards.filter((c) => !c.date);
  if (list.length === 0) return "";
  return `<section class="undated"><h2>日付が決まっていない予定</h2>${list.map((c) => cardHtml(c, false)).join("")}</section>`;
}

// 文字の大きさは html の font-size（rem の基準）で決める。16/18/22px
const CSS = `
:root{--ink:#222;--sub:#555;--line:#ccc;--bg2:#f6f6f6;--ev:#1a5fb4;--ev-bg:#e6eefc;--sv:#0f6236;--sv-bg:#e3f3ea;--nd:#b3121d;--nd-bg:#fbe4e6;--today:#fff6d6}
html{font-size:18px;-webkit-text-size-adjust:100%}
html[data-fs=s]{font-size:16px}
html[data-fs=l]{font-size:22px}
*{box-sizing:border-box;min-width:0}
body{margin:0;padding:12px;font:1rem/1.45 -apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;color:var(--ink);background:#fff;overflow-x:hidden}
h1{font-size:1.3rem;margin:0 0 8px}
h2{font-size:1.1rem;margin:16px 0 8px}
h3{font-size:1.05rem;margin:0 0 6px}
p{margin:8px 0}
a{color:var(--ev)}
button{font:inherit;color:inherit}
.ctl{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:8px 0}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;min-width:44px;padding:6px 12px;border:2px solid var(--ev);border-radius:10px;background:#fff;color:var(--ev);font-weight:bold;text-decoration:none;cursor:pointer;line-height:1.2;white-space:nowrap}
.btn[aria-pressed=true]{background:var(--ev);color:#fff}
.grp{display:inline-flex;gap:4px;align-items:center}
.grp .lab{font-weight:bold;color:var(--sub);padding:0 2px}
.grp .fs{min-width:44px;padding:6px 8px}
.range{font-weight:bold;font-size:1.1rem;margin:8px 0}
.view{display:none}
.view.on{display:block}
.today{background:var(--today)}
.num{font-weight:bold}
.dn{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.wd{color:var(--sub);font-weight:normal}
.tdy{font-size:.85em;background:var(--ev);color:#fff;border-radius:999px;padding:1px 10px}
.none{color:var(--sub);margin:4px 0}
.hint{color:var(--sub);font-size:.9rem;margin:6px 0}
/* 週：1日ずつ縦 */
.days{display:flex;flex-direction:column;gap:10px}
.day{border:1px solid var(--line);border-radius:10px;padding:8px 10px;background:#fff}
.day.today{border-color:var(--ev);border-width:2px}
.day h2{margin:0 0 6px}
.day.today .num,.mday.today .num{display:inline-block;min-width:36px;height:36px;line-height:36px;text-align:center;border-radius:50%;background:var(--ev);color:#fff}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 6px}
.chip{display:inline-block;padding:4px 12px;border-radius:999px;background:var(--sv-bg);color:var(--sv);font-weight:bold;border:2px solid transparent}
.chip.nd{background:var(--nd-bg);color:var(--nd);border-color:var(--nd)}
.ev{background:var(--ev-bg);border-left:5px solid var(--ev);border-radius:6px;padding:6px 8px;margin:4px 0;overflow-wrap:anywhere}
.ev .t{color:var(--ev);font-weight:bold}
.ev small{display:block;font-size:1em;color:var(--sub)}
.thumbs{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
.notices{margin-top:20px;padding-top:12px;border-top:2px solid #ddd}
.notices h2{font-size:1.1em;margin:0 0 8px}
.nt{margin:0;width:calc(50% - 3px)}
.nt .ph{width:100%}
.nt img{width:100%;height:auto}
.nt figcaption{font-size:.9em;color:#333}
/* 月：升目 */
.mgrid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));border-top:1px solid var(--line);border-left:1px solid var(--line);background:#fff}
.mgrid>*{border-right:1px solid var(--line);border-bottom:1px solid var(--line);padding:3px 2px}
.mh{text-align:center;background:var(--bg2);color:var(--sub);font-weight:bold}
.mcell{display:flex;flex-direction:column;align-items:stretch;gap:1px;aspect-ratio:1/1;text-align:left;background:#fff;border:0;border-right:1px solid var(--line);border-bottom:1px solid var(--line);cursor:pointer}
.mcell>*{flex-shrink:0}
@supports not (aspect-ratio:1/1){.mcell{min-height:44px}}
.mcell .dn{gap:2px;line-height:1.2}
.mcell[aria-expanded=true]{outline:3px solid var(--ev);outline-offset:-3px}
.mcell.today{background:var(--today)}
.mcell.out{color:#666;background:#fafafa;cursor:default}
.mcell .cam{font-size:.8em}
.mt{display:block;white-space:nowrap;overflow:hidden;text-overflow:clip;font-size:.72em;line-height:1.3;background:var(--ev-bg);color:var(--ev);border-left:3px solid var(--ev);padding:0 2px}
.mt.nd{background:var(--nd-bg);color:var(--nd);border-left-color:var(--nd);font-weight:bold}
.out .mt{opacity:.6}
.more{font-size:.72em;color:var(--sub);line-height:1.3}
.mdetail{margin-top:10px}
.mday{border:2px solid var(--ev);border-radius:10px;padding:8px 10px;background:#fff}
.mday.today{background:var(--today)}
/* 写真 */
.ph{border:0;padding:0;background:none;cursor:pointer;margin:0;min-width:44px;min-height:44px}
.ph img{width:80px;height:80px;object-fit:cover;border-radius:6px;border:1px solid var(--line);display:block}
#lb{position:fixed;inset:0;background:rgba(0,0,0,.88);display:none;align-items:center;justify-content:center;flex-direction:column;gap:8px;padding:12px;cursor:pointer;z-index:9}
#lb.on{display:flex}
#lb img{max-width:100%;max-height:80vh;border-radius:8px}
#lb p{color:#fff;margin:0}
#lb .close{position:absolute;top:8px;right:8px}
.undated .ev{max-width:600px}
.howto{margin:8px 0;padding:8px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg2)}
.howto summary{cursor:pointer;font-weight:bold;min-height:44px;display:flex;align-items:center}
.howto code{display:block;overflow-wrap:anywhere;user-select:all;-webkit-user-select:all;margin-top:4px;background:#fff;padding:6px;border-radius:6px}
.howto ol{margin:4px 0 0;padding-left:24px}
.howto p{margin:8px 0 0}
@media(min-width:768px){
  body{padding:16px 20px;max-width:1200px;margin:0 auto}
  .days{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px}
  .day{padding:8px}
  .mcell{padding:4px}
  .mt,.more{font-size:.9em}
  .mt{text-overflow:ellipsis}
  .mcell .cam{font-size:1em}
}
@media print{.ctl,.howto,.hint{display:none}.view{display:block}body{padding:0}}
`;

// JS は4つだけ：文字の大きさ／週↔月の切り替え（前・次・今日のリンクも差し替え）／月の升を押すとその日の予定／写真の拡大
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

  var vbtns=document.querySelectorAll('.vw');
  function show(v){
    var sec=document.getElementById(v);
    document.querySelectorAll('.view').forEach(function(s){s.classList.toggle('on',s.id===v)});
    vbtns.forEach(function(b){b.setAttribute('aria-pressed',b.dataset.view===v?'true':'false')});
    ['prev','next','today'].forEach(function(k){var a=document.getElementById('nav-'+k);if(a&&sec.dataset[k]){a.href=sec.dataset[k]}});
  }
  vbtns.forEach(function(b){b.addEventListener('click',function(){show(b.dataset.view)})});

  var cells=document.querySelectorAll('.mcell[data-day]');
  cells.forEach(function(c){c.addEventListener('click',function(){
    var id='md-'+c.dataset.day;
    document.querySelectorAll('.mday').forEach(function(d){d.hidden=d.id!==id});
    cells.forEach(function(o){o.setAttribute('aria-expanded',o===c?'true':'false')});
  })});

  var lb=document.getElementById('lb'),img=lb.querySelector('img'),cap=lb.querySelector('p');
  document.querySelectorAll('.ph').forEach(function(p){p.addEventListener('click',function(){
    img.src=p.dataset.src;cap.textContent=p.dataset.label||'';lb.classList.add('on');
  })});
  lb.addEventListener('click',function(){lb.classList.remove('on');img.src=''});
})();
`;

// 最初の描画の前に文字の大きさを戻す（ちらつき防止）。失敗しても何もしない
const HEAD_JS = `try{var f=localStorage.getItem('dandori-fs');if(f==='s'||f==='l'){document.documentElement.setAttribute('data-fs',f)}}catch(e){}`;

/** HTML 1枚（CSS/JS はインライン。外部の読み込みなし）。スマホ優先・大きな字・週は1日ずつ縦、月は升目 */
export function renderCalendar(raw: CalendarInput): string {
  const input = { ...raw, cards: normCards(raw.cards) };
  const family = input.familyName || "わが家";
  const icsUrl = `${input.baseUrl}.ics`;
  const v = input.view;
  // 週も月も1枚に入れておき、切り替えは JS で（読み込み直さない）
  const week = weekHtml(input, v === "week");
  const month = monthHtml(input, v === "month");
  const anchorNav = v === "week" ? mondayOf(input.anchor) : firstOfMonth(input.anchor);
  const prev = v === "week" ? addDays(anchorNav, -7) : addMonths(anchorNav, -1);
  const next = v === "week" ? addDays(anchorNav, 7) : addMonths(anchorNav, 1);
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<title>${esc(family)}の予定</title>
<script>${HEAD_JS}</script>
<style>${CSS}</style>
</head>
<body>
<h1>${esc(family)}の予定</h1>
<nav class="ctl" aria-label="操作">
  <a class="btn" id="nav-today" href="${navLink(input.baseUrl, v, input.today)}">今日</a>
  <a class="btn" id="nav-prev" href="${navLink(input.baseUrl, v, prev)}">＜ 前</a>
  <a class="btn" id="nav-next" href="${navLink(input.baseUrl, v, next)}">次 ＞</a>
  <span class="grp" role="group" aria-label="表示の切り替え">
    <button type="button" class="btn vw" data-view="week" aria-pressed="${v === "week"}">週</button>
    <button type="button" class="btn vw" data-view="month" aria-pressed="${v === "month"}">月</button>
  </span>
  <span class="grp" role="group" aria-label="文字の大きさ">
    <span class="lab" aria-hidden="true">あ</span>
    <button type="button" class="btn fs" data-fs="s" aria-pressed="false" aria-label="文字を小さく">小</button>
    <button type="button" class="btn fs" data-fs="m" aria-pressed="true" aria-label="文字をふつうに">中</button>
    <button type="button" class="btn fs" data-fs="l" aria-pressed="false" aria-label="文字を大きく">大</button>
  </span>
</nav>
<details class="howto">
  <summary>Googleカレンダーに入れる</summary>
  <ol>
    <li>下の URL を長押ししてコピー</li>
    <li>Googleカレンダーの「他のカレンダー」＋ →「URL で追加」に貼る</li>
  </ol>
  <code>${esc(icsUrl)}</code>
  <p>この予定ページの URL は家族だけに。合言葉の代わりなので、ほかの人に送らないでください。</p>
</details>
<details class="howto">
  <summary>だんどりさんの使い方（LINE で）</summary>
  <ul>
    <li>📷 お便りの写真を送る → 予定にして、ここに残る（紙は捨ててOK）</li>
    <li>🚗 「お迎えを頼む」→ 日と時刻を選ぶ → 家族の名前ボタンで決まる</li>
    <li>🤒 「休みの連絡」→ 子と理由を選ぶ → 園・学校・習い事への文を［コピー］</li>
    <li>🙏 引き受けた人に［ありがとう］→ 日曜の夜に今週のカード</li>
    <li>1対1のトークでは、下の「メニュー」から同じことができる</li>
  </ul>
</details>
${week}
${month}
${undatedHtml(input.cards)}
${noticesHtml(input.photos)}
<div id="lb" role="dialog" aria-label="写真"><button type="button" class="btn close" aria-label="閉じる">閉じる</button><img alt=""><p></p></div>
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
