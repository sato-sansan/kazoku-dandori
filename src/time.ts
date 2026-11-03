// 日本時間の計算。Workers の時計は UTC なので、ここでだけ +9 時間を扱う

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** epoch ms → "YYYY-MM-DD"（JST） */
export function jstDate(ms = Date.now()) {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** epoch ms → "HH:MM"（JST） */
export function jstTime(ms = Date.now()) {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(11, 16);
}

/** "YYYY-MM-DD" と "HH:MM"（JST）→ epoch ms */
export function jstToMs(date: string, time: string) {
  return Date.parse(`${date}T${time}:00+09:00`);
}

/** "YYYY-MM-DD" に日数を足す */
export function addDays(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00+09:00`) + days * 86_400_000 + JST_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
}

/** 0=日 … 6=土（JST） */
export function jstWeekday(date: string) {
  return new Date(Date.parse(`${date}T12:00:00+09:00`)).getUTCDay();
}

/** 次の日曜20:00（JST）。今が日曜20:00前ならその日 */
export function nextSundayEvening(now = Date.now()) {
  const today = jstDate(now);
  const daysToSunday = (7 - jstWeekday(today)) % 7;
  const candidate = jstToMs(addDays(today, daysToSunday), "20:00");
  return candidate > now ? candidate : candidate + 7 * 86_400_000;
}

/** 今週（月曜0:00〜日曜24:00 JST）の範囲 */
export function weekRange(now = Date.now()) {
  const today = jstDate(now);
  const daysSinceMonday = (jstWeekday(today) + 6) % 7;
  const start = jstToMs(addDays(today, -daysSinceMonday), "00:00");
  return { start, end: start + 7 * 86_400_000 };
}
