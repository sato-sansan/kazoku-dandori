// 祝日と、保育所が休みの日。祝日に「保育所のお迎え、行ける人？」を聞かない（11/18：聞いても意味がなく、LINE の送信数も減る）

/** 春分・秋分の日（1980〜2099 年に使える近似式） */
function equinox(year: number, base: number) {
  return Math.floor(base + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

/** その月の第 n 月曜日 */
function nthMonday(year: number, month: number, n: number) {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((8 - first) % 7) + 7 * (n - 1);
}

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

const cache = new Map<number, Map<string, string>>();

/** その年の祝日（振替休日・国民の休日を含む）。2020 年以降の決まりで計算する */
function holidaysOf(year: number): Map<string, string> {
  const hit = cache.get(year);
  if (hit) return hit;
  const base: [number, number, string][] = [
    [1, 1, "元日"],
    [1, nthMonday(year, 1, 2), "成人の日"],
    [2, 11, "建国記念の日"],
    [2, 23, "天皇誕生日"],
    [3, equinox(year, 20.8431), "春分の日"],
    [4, 29, "昭和の日"],
    [5, 3, "憲法記念日"],
    [5, 4, "みどりの日"],
    [5, 5, "こどもの日"],
    [7, nthMonday(year, 7, 3), "海の日"],
    [8, 11, "山の日"],
    [9, nthMonday(year, 9, 3), "敬老の日"],
    [9, equinox(year, 23.2488), "秋分の日"],
    [10, nthMonday(year, 10, 2), "スポーツの日"],
    [11, 3, "文化の日"],
    [11, 23, "勤労感謝の日"],
  ];
  const days = new Map<string, string>(base.map(([m, d, name]) => [iso(year, m, d), name]));
  const next = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  // 国民の休日：祝日にはさまれた日（9月の敬老の日と秋分の日の間など）
  for (const date of [...days.keys()]) {
    const mid = next(date);
    if (!days.has(mid) && days.has(next(mid))) days.set(mid, "国民の休日");
  }
  // 振替休日：日曜の祝日のあと、最初の祝日でない日
  for (const date of [...days.keys()].sort()) {
    if (new Date(`${date}T00:00:00Z`).getUTCDay() !== 0) continue;
    let d = next(date);
    while (days.has(d)) d = next(d);
    if (d.startsWith(String(year))) days.set(d, "振替休日");
  }
  cache.set(year, days);
  return days;
}

/** 祝日の名前。祝日でなければ null */
export function holidayName(date: string): string | null {
  return holidaysOf(Number(date.slice(0, 4))).get(date) ?? null;
}

/** 年末年始（12/29〜1/3）。多くの保育所が休み［推測：園によって違う］ */
export function isYearEnd(date: string) {
  const md = date.slice(5);
  return md >= "12-29" || md <= "01-03";
}

/** 保育所の毎日の送り迎えが無い日：土日・祝日・年末年始 */
export function isDayOff(date: string) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6 || holidayName(date) !== null || isYearEnd(date);
}

/** だんどり帳・返事に出す短い名前（祝日の名前か「年末年始」）。平日・土日は null */
export function dayOffName(date: string): string | null {
  return holidayName(date) ?? (isYearEnd(date) ? "年末年始" : null);
}
