// 家族の情報。ここにあるのは架空の家族だけ。本物の呼び名は secret の FAMILY_PROFILE に入れる

export interface FamilyProfile {
  adults: string[];
  /** aliases：前の呼び名。家族が「子どもの名前」で呼び名を変えたあとも、前の呼び名で書かれた文を読めるように */
  children: { name: string; grade: string; attends: string; aliases?: string[] }[];
  /** 通い先の電話。休みの連絡を電話で伝える家のため。by は「何時までに」（例 "9:00"）。本物の番号は secret にだけ入れる */
  contacts?: Partial<Record<"保育所" | "小学校", { phone: string; by?: string }>>;
}

const SAMPLE_FAMILY: FamilyProfile = {
  adults: ["パパ", "ママ", "じいじ", "ばあば"],
  children: [
    { name: "はると", grade: "小学2年", attends: "小学校" },
    { name: "ゆい", grade: "5歳", attends: "保育所" },
    { name: "そうた", grade: "4歳", attends: "保育所" },
    { name: "めい", grade: "2歳", attends: "保育所" },
  ],
  // つながらない架空の番号。撮影でも本物の園には掛からない
  contacts: { 保育所: { phone: "00-0000-0000", by: "9:00" } },
};

export function loadProfile(raw?: string): FamilyProfile {
  return raw ? (JSON.parse(raw) as FamilyProfile) : SAMPLE_FAMILY;
}

/**
 * 家族が LINE やだんどり帳で変えた呼び名（前 → 今）を当てる。secret は書き換えずに、家族ごとの箱の設定で上書きする。
 * 前の呼び名は aliases に残す（前の呼び名で書いた文・前に読んだお便りも同じ子として扱う）
 */
export function applyChildNames(profile: FamilyProfile, names: Record<string, string>, history: Record<string, string[]> = {}): FamilyProfile {
  if (Object.keys(names).length === 0) return profile;
  return {
    ...profile,
    children: profile.children.map((c) => {
      const next = names[c.name];
      if (!next || next === c.name) return c;
      // 前の呼び名は全部残す（2回変えても、最初の呼び名・途中の呼び名のどれで書いても同じ子）
      return { ...c, name: next, aliases: [...new Set([...(c.aliases ?? []), c.name, ...(history[c.name] ?? [])])].filter((a) => a !== next) };
    }),
  };
}

/** 呼び名か前の呼び名なら、今の呼び名。どの子でもなければ null */
export function childByWord(profile: FamilyProfile, word: string): string | null {
  const w = word.trim();
  if (!w) return null;
  return profile.children.find((c) => c.name === w || (c.aliases ?? []).includes(w))?.name ?? null;
}

/** 呼び名を変えた家だけ、Claude に渡す文に足す1行（見本の家族・評価の文は変えない） */
export function aliasNote(profile: FamilyProfile): string | null {
  return profile.children.some((c) => (c.aliases ?? []).length > 0)
    ? "呼び名の決まり：aliases は前の呼び名。家族が前の呼び名で書いても、予定と文には name（今の呼び名）を使う。"
    : null;
}

/** 前の呼び名を今の呼び名に直す（連絡文に前の呼び名が残らないように）。前の呼び名のすぐあとが助詞・区切り・「ちゃん」などのときだけ */
export function withCurrentName(text: string, child: FamilyProfile["children"][number]): string {
  let out = text;
  for (const alias of child.aliases ?? []) {
    const a = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`${a}(?=[はがのをにもへとや、。！!？?\\s　」]|ちゃん|くん|さん|$)`, "g"), child.name);
  }
  return out;
}

/** 文に出てくる子（今の呼び名か前の呼び名）。profile の並び順で、今の呼び名を返す */
export function childrenInText(profile: FamilyProfile, text: string): FamilyProfile["children"] {
  return profile.children.filter((c) => [c.name, ...(c.aliases ?? [])].some((n) => n && text.includes(n)));
}
