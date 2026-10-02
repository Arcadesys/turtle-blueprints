import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bounds, newBlueprint, type Blueprint } from "@tb/blueprint";

const EXT = ".blueprint.json";
const NAME = /^[A-Za-z0-9_-]+$/;

export interface FileInfo {
  name: string;
  description?: string;
  blocks: number;
  size: [number, number, number] | null;
  modified: number;
}

/**
 * Blueprint files on disk are the source of truth. Archived files move to
 * `.archive/` (never deleted) so they can be restored.
 */
export class Store {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  get archiveDir(): string {
    return join(this.dir, ".archive");
  }

  path(name: string, dir = this.dir): string {
    if (!NAME.test(name)) throw new Error(`bad blueprint name "${name}" (letters, digits, _ and - only)`);
    return join(dir, `${name}${EXT}`);
  }

  private names(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith(EXT)).map((f) => f.slice(0, -EXT.length)).sort();
  }

  list(): string[] {
    return this.names(this.dir);
  }

  listArchived(): string[] {
    return this.names(this.archiveDir);
  }

  exists(name: string): boolean {
    return existsSync(this.path(name));
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

  info(name: string): FileInfo {
    const bp = this.load(name);
    const bb = bounds(bp);
    return {
      name,
      ...(bp.description ? { description: bp.description } : {}),
      blocks: bp.blocks.length,
      size: bb ? bb.size : null,
      modified: statSync(this.path(name)).mtimeMs,
    };
  }

  private free(name: string): void {
    if (this.exists(name)) throw new Error(`"${name}" already exists`);
  }

  create(name: string, description?: string): Blueprint {
    this.path(name);
    this.free(name);
    const bp = newBlueprint(name, description);
    this.save(bp);
    return bp;
  }

  rename(from: string, to: string): void {
    const bp = this.load(from);
    if (from === to) return;
    this.path(to);
    this.free(to);
    this.save({ ...bp, name: to });
    rmSync(this.path(from));
  }

  duplicate(from: string, to: string): void {
    const bp = this.load(from);
    this.path(to);
    this.free(to);
    this.save({ ...bp, name: to });
  }

  describe(name: string, description: string): void {
    const { description: _, ...bp } = this.load(name);
    this.save(description ? { ...bp, description } : bp);
  }

  /** Move a blueprint into `.archive/`, replacing any older archived copy of the same name. */
  archive(name: string): void {
    const p = this.path(name);
    if (!existsSync(p)) throw new Error(`no blueprint named "${name}"`);
    mkdirSync(this.archiveDir, { recursive: true });
    renameSync(p, this.path(name, this.archiveDir));
  }

  restore(name: string): void {
    const p = this.path(name, this.archiveDir);
    if (!existsSync(p)) throw new Error(`no archived blueprint named "${name}"`);
    this.free(name);
    cpSync(p, this.path(name));
    rmSync(p);
  }
}
