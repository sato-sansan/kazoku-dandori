// wrangler の Data ルール（wrangler.jsonc の rules）で、PNG をそのままバイト列として取り込む
declare module "*.png" {
  const data: ArrayBuffer;
  export default data;
}
