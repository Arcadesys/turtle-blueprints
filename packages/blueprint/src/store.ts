import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Blueprint } from "./index";

/** Blueprint files on disk are the source of truth; the MCP server and the web editor both read and write them here. Node only. */
export class Store {
  constructor(readonly dir: string) {}

  path(name: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`bad blueprint name "${name}" (letters, digits, _ and - only)`);
    return join(this.dir, `${name}.blueprint.json`);
  }

  list(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((f) => f.endsWith(".blueprint.json")).map((f) => f.replace(/\.blueprint\.json$/, "")).sort();
  }

  load(name: string): Blueprint {
    const p = this.path(name);
    if (!existsSync(p)) throw new Error(`no blueprint named "${name}" (have: ${this.list().join(", ") || "none"})`);
    return JSON.parse(readFileSync(p, "utf8")) as Blueprint;
  }

  save(bp: Blueprint): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.path(bp.name), JSON.stringify(bp).replace(/\],\[/g, "],\n[") + "\n");
  }
}
