import type { Directory } from "./directory";
import type { Family } from "./family";

export interface Env {
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  FAMILY_PROFILE?: string;
  FAMILY: DurableObjectNamespace<Family>;
  DIRECTORY: DurableObjectNamespace<Directory>;
}
