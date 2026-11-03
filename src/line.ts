// LINE Messaging API の薄い窓口。メッセージの中身はログに出さない

const API = "https://api.line.me/v2/bot/message";
const DATA_API = "https://api-data.line.me/v2/bot/message";
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

export type ImageType = (typeof IMAGE_TYPES)[number];

export interface LineEvent {
  type: string;
  webhookEventId: string;
  replyToken?: string;
  source: { type: "user" | "group" | "room"; userId?: string; groupId?: string; roomId?: string };
  message?: {
    id: string;
    type: string;
    text?: string;
    /** 本文の @名指し。isSelf はだんどりさん自身 */
    mention?: { mentionees: { index: number; length: number; type?: string; userId?: string; isSelf?: boolean }[] };
  };
  unsend?: { messageId: string };
  /** memberJoined：グループに入った人たち */
  joined?: { members: { type: string; userId?: string }[] };
}

export type OutMessage = TextMessage | TextV2Message | FlexMessage | ImageMessage;

/** @で名指しする文。本文の {u1} {u2} … が相手の名前に置き換わる */
export interface TextV2Message {
  type: "textV2";
  text: string;
  substitution: Record<string, { type: "mention"; mentionee: { type: "user"; userId: string } }>;
  quickReply?: { items: QuickReplyItem[] };
}

/** 「@ばあば さん、…」。名指しする人が複数なら「@A さん @B さん、…」 */
export function mentionText(userIds: string[], rest: string, buttons: QuickButton[] = []): TextV2Message {
  const substitution: TextV2Message["substitution"] = {};
  const heads = userIds.map((userId, i) => {
    substitution[`u${i + 1}`] = { type: "mention", mentionee: { type: "user", userId } };
    return `{u${i + 1}} さん`;
  });
  const message: TextV2Message = { type: "textV2", text: `${heads.join(" ")}、${rest}`, substitution };
  if (buttons.length > 0) message.quickReply = withButtons("", buttons).quickReply;
  return message;
}

/** 残してある写真を再送するとき。URL は https で、LINE 側が取りに来る */
export interface ImageMessage {
  type: "image";
  originalContentUrl: string;
  previewImageUrl: string;
}

export interface TextMessage {
  type: "text";
  text: string;
  quickReply?: { items: QuickReplyItem[] };
}

/** Flex の中身は LINE の仕様どおりの JSON（src/flex.ts が組み立てる） */
export interface FlexMessage {
  type: "flex";
  altText: string;
  contents: Record<string, unknown>;
  quickReply?: { items: QuickReplyItem[] };
}

interface QuickReplyItem {
  type: "action";
  action: QuickAction;
}

/** 小さなボタン。文を送る／カメラを開く／写真を選ぶ／ページを開く */
export type QuickAction =
  | { type: "message"; label: string; text: string }
  | { type: "camera"; label: string }
  | { type: "cameraRoll"; label: string }
  | { type: "uri"; label: string; uri: string };

export type QuickButton = { label: string; text: string } | QuickAction;

/** 前のやり取りを隠さない小さなボタン（クイックリプライ）。13個まで、label は20字まで */
export function withButtons(text: string, buttons: QuickButton[]): TextMessage {
  return {
    type: "text",
    text,
    quickReply: {
      items: buttons.slice(0, 13).map((b) => ({
        type: "action",
        action: "type" in b ? b : { type: "message", label: b.label, text: b.text },
      })),
    },
  };
}

/** 生の本文とヘッダの署名を照合する。crypto.subtle.verify は比較の時間で漏らさない */
export async function verifySignature(body: string, signature: string | null, secret: string) {
  if (!signature) return false;
  let expected: Uint8Array;
  try {
    expected = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, expected, encoder.encode(body));
}

async function post(path: string, token: string, payload: unknown) {
  return fetch(`${API}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

/** 返信（無料）。返信トークンが切れていたら false を返す */
export async function reply(token: string, replyToken: string, messages: OutMessage[]) {
  const res = await post("reply", token, { replyToken, messages });
  // 失敗の理由は LINE の返事に出る（本文は含まれない）
  if (!res.ok) console.error("line reply failed", res.status, (await res.text()).slice(0, 300));
  return res.ok;
}

/** グループ（またはトークルーム）の中での表示名。「さくらに頼んで」の「さくら」がだれかを知るためだけに使う */
export async function memberName(token: string, chatId: string, userId: string): Promise<string | null> {
  const kind = chatId.startsWith("R") ? "room" : "group";
  const res = await fetch(`https://api.line.me/v2/bot/${kind}/${chatId}/member/${userId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { displayName?: string };
  return body.displayName ?? null;
}

/**
 * 今月のプッシュの残り。無料プランは月200通で、グループへのプッシュは「人数ぶん」数える。
 * 上限なし（有料の従量）なら null。取れなければ null（止めない）
 */
export async function pushRemaining(token: string): Promise<number | null> {
  const headers = { Authorization: `Bearer ${token}` };
  const [q, c] = await Promise.all([
    fetch("https://api.line.me/v2/bot/message/quota", { headers }),
    fetch("https://api.line.me/v2/bot/message/quota/consumption", { headers }),
  ]);
  if (!q.ok || !c.ok) return null;
  const quota = (await q.json()) as { type?: string; value?: number };
  const used = (await c.json()) as { totalUsage?: number };
  if (quota.type !== "limited" || typeof quota.value !== "number") return null;
  return quota.value - (used.totalUsage ?? 0);
}

/** グループ（トークルーム）の人数（だんどりさんは数えない）。取れなければ null */
export async function chatMemberCount(token: string, chatId: string): Promise<number | null> {
  const kind = chatId.startsWith("R") ? "room" : "group";
  const res = await fetch(`https://api.line.me/v2/bot/${kind}/${chatId}/members/count`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { count?: number };
  return typeof body.count === "number" ? body.count : null;
}

/** プッシュ（通数を使う）。返信できなかったときと定時のお知らせだけ */
export async function push(token: string, to: string, messages: OutMessage[]) {
  const res = await post("push", token, { to, messages });
  if (!res.ok) throw new Error(`line push failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
}

// ── リッチメニュー（1対1のトークの下に出る4つの入口。家族ごとに1つ作り、名簿の人に結びつける） ──

const RICHMENU_API = "https://api.line.me/v2/bot/richmenu";

export interface RichMenuArea {
  bounds: { x: number; y: number; width: number; height: number };
  action: { type: "uri"; label: string; uri: string } | { type: "message"; label: string; text: string };
}

/** 作って ID を返す。画像はこのあと uploadRichMenuImage で入れる */
export async function createRichMenu(token: string, name: string, areas: RichMenuArea[]) {
  const res = await fetch(RICHMENU_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ size: { width: 2500, height: 843 }, selected: true, name, chatBarText: "メニュー", areas }),
  });
  if (!res.ok) throw new Error(`richmenu create failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return ((await res.json()) as { richMenuId: string }).richMenuId;
}

export async function uploadRichMenuImage(token: string, richMenuId: string, png: ArrayBuffer) {
  const res = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
    method: "POST",
    headers: { "Content-Type": "image/png", Authorization: `Bearer ${token}` },
    body: png,
  });
  if (!res.ok) throw new Error(`richmenu image failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
}

/** 名簿の人たちに結びつける（1対1のトークにだけ出る） */
export async function linkRichMenu(token: string, richMenuId: string, userIds: string[]) {
  if (userIds.length === 0) return;
  const res = await fetch(`${RICHMENU_API}/bulk/link`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ richMenuId, userIds: userIds.slice(0, 500) }),
  });
  if (!res.ok) throw new Error(`richmenu link failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
}

export async function deleteRichMenu(token: string, richMenuId: string) {
  await fetch(`${RICHMENU_API}/${richMenuId}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
}

/** 画像を保存せずメモリにだけ取り出す。送信取消などで取れないときは null */
export async function fetchImage(token: string, messageId: string) {
  const res = await fetch(`${DATA_API}/${messageId}/content`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw new Error(`line content failed: ${res.status}`);
  const mediaType = (res.headers.get("Content-Type") ?? "").split(";")[0] as ImageType;
  if (!IMAGE_TYPES.includes(mediaType)) throw new Error(`unsupported image: ${mediaType}`);
  return { mediaType, data: toBase64(new Uint8Array(await res.arrayBuffer())) };
}

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
