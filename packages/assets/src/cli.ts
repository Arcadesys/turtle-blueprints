/** `npm run assets`: build the block catalog and textures into .assets/ (or TB_ASSETS). */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildAssets, defaultPaths } from "./extract";

function main() {
  const d = defaultPaths();
  const pick = (env: string | undefined, list: string[]) => resolve(env ?? list.find((p) => existsSync(p)) ?? list[0]!);
  const instance = pick(process.env.ATM10_INSTANCE, d.instance);
  const clientJar = pick(process.env.MC_CLIENT_JAR, d.clientJar);
  const out = resolve(process.env.TB_ASSETS ?? ".assets");
  for (const p of [instance, clientJar]) if (!existsSync(p)) throw new Error(`not found: ${p} (set ATM10_INSTANCE / MC_CLIENT_JAR)`);
  let bar = false;
  const r = buildAssets({
    instance, clientJar, out,
    progress: (msg, done, total) => {
      if (total) process.stdout.write(`\r[${done}/${total}] ${msg.slice(0, 60).padEnd(60)}`);
      else console.log(bar ? `\n${msg}` : msg);
      bar = !!total;
    },
  });
  console.log(`wrote ${r.blocks} blocks and ${r.textures} textures to ${out}`);
}

main();
