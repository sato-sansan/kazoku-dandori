import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

/**
 * だれがどの家族か（userId → グループ）。1対1のトークにはグループIDが付いてこないので、
 * グループで登録した人だけをここで引ける。1つだけ存在する
 */
export class Directory extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS members (user_id TEXT PRIMARY KEY, family_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tokens (token TEXT PRIMARY KEY, family_id TEXT NOT NULL);
    `);
  }

  /** カレンダーの合言葉 → 家族。合言葉は家族の箱が作る */
  async registerToken(token: string, familyId: string) {
    this.sql.exec("INSERT OR REPLACE INTO tokens (token, family_id) VALUES (?, ?)", token, familyId);
  }

  async familyOfToken(token: string): Promise<string | null> {
    const row = this.sql.exec("SELECT family_id FROM tokens WHERE token = ?", token).toArray()[0];
    return row ? (row.family_id as string) : null;
  }

  async register(userId: string, familyId: string) {
    this.sql.exec("INSERT OR REPLACE INTO members (user_id, family_id) VALUES (?, ?)", userId, familyId);
  }

  async familyOf(userId: string): Promise<string | null> {
    const row = this.sql.exec("SELECT family_id FROM members WHERE user_id = ?", userId).toArray()[0];
    return row ? (row.family_id as string) : null;
  }
}
