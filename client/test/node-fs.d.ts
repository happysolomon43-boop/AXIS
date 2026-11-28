// The client runtime has no Node dependency. Vitest's filesystem checks run in Node.
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}
