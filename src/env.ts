import type { Directory } from "./directory";
import type { Family } from "./family";

export interface Env {
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  FAMILY_PROFILE?: string;
  /** 手元の試験だけ：LINE の窓口を偽物に向ける。本番では設定しない */
  LINE_API_BASE?: string;
  FAMILY: DurableObjectNamespace<Family>;
  DIRECTORY: DurableObjectNamespace<Directory>;
  PHOTOS: R2Bucket;
}
