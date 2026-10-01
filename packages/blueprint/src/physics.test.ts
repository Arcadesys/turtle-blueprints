import { describe, expect, it } from "vitest";
import { stepBody, collides, type Body, type SolidAt } from "./physics";

const world = (cells: Record<string, [number, number]>): SolidAt => (x, y, z) => cells[`${x},${y},${z}`] ?? null;
const full = (y: number): [number, number] => [y - 0.5, y + 0.5];
const body = (x: number, y: number, z: number): Body => ({ x, y, z, vy: 0, onGround: false });
const run = (b: Body, solid: SolidAt, seconds: number, input = { vx: 0, vz: 0, jump: false }) => {
  for (let t = 0; t < seconds; t += 1 / 60) stepBody(b, input, 1 / 60, solid);
  return b;
};

describe("walking physics", () => {
  it("falls and lands on the grid floor", () => {
    const b = run(body(0, 5, 0), world({}), 2);
    expect(b.y).toBeCloseTo(-0.5, 3);
    expect(b.onGround).toBe(true);
  });
  it("lands on top of a block", () => {
    const b = run(body(0, 4, 0), world({ "0,0,0": full(0) }), 2);
    expect(b.y).toBeCloseTo(0.5, 3);
  });
  it("is stopped by a wall two blocks high", () => {
    const solid = world({ "2,0,0": full(0), "2,1,0": full(1) });
    const b = run(body(0, -0.5, 0), solid, 2, { vx: 4, vz: 0, jump: false });
    expect(b.x).toBeLessThan(2 - 0.5 - 0.3 + 0.01);
    expect(b.x).toBeGreaterThan(1.1);
  });
  it("does not walk through a block diagonally or tunnel at speed", () => {
    const solid = world({ "2,0,0": full(0), "2,1,0": full(1) });
    const b = body(0, -0.5, 0);
    for (let i = 0; i < 20; i++) stepBody(b, { vx: 300, vz: 0, jump: false }, 1 / 60, solid);
    expect(b.x).toBeLessThan(1.3);
  });
  it("steps up onto a half slab without jumping, but not a full block", () => {
    const slab = world({ "1,0,0": [-0.5, 0] });
    expect(run(body(0, -0.5, 0), slab, 1, { vx: 3, vz: 0, jump: false }).x).toBeGreaterThan(1.5);
    const block = world({ "1,0,0": full(0) });
    expect(run(body(0, -0.5, 0), block, 1, { vx: 3, vz: 0, jump: false }).x).toBeLessThan(0.3);
  });
  it("jumps onto one block but not two", () => {
    const one = world({ "1,0,0": full(0) });
    const b = body(0, -0.5, 0);
    run(b, one, 0.5, { vx: 0, vz: 0, jump: false });
    for (let t = 0; t < 2; t += 1 / 60) stepBody(b, { vx: t < 0.4 ? 4.3 : 0, vz: 0, jump: t < 0.05 }, 1 / 60, one);
    expect(b.y).toBeCloseTo(0.5, 2);
    const two = world({ "1,0,0": full(0), "1,1,0": full(1) });
    const c = body(0, -0.5, 0);
    for (let t = 0; t < 2; t += 1 / 60) stepBody(c, { vx: t < 0.4 ? 4.3 : 0, vz: 0, jump: t < 0.05 }, 1 / 60, two);
    expect(c.x).toBeLessThan(0.3);
    expect(c.y).toBeCloseTo(-0.5, 1);
  });
  it("bonks its head on a ceiling", () => {
    const solid = world({ "0,2,0": full(2) });
    const b = body(0, -0.5, 0);
    let peak = -1;
    for (let t = 0; t < 1; t += 1 / 60) { stepBody(b, { vx: 0, vz: 0, jump: true }, 1 / 60, solid); peak = Math.max(peak, b.y); }
    expect(peak + 1.8).toBeLessThanOrEqual(1.5 + 1e-3);
  });
  it("reports overlap", () => {
    expect(collides(0, 0, 0, world({ "0,0,0": full(0) }))).toBe(true);
    expect(collides(0, 0.5, 0, world({ "0,0,0": full(0) }))).toBe(false);
  });
});
