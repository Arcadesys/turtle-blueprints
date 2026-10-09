import { describe, expect, it } from "vitest";
import {
  FLY_SPEED, FLY_SPRINT_SPEED, FLY_VERTICAL, HALF_WIDTH, HEIGHT, SPRINT_SPEED, WALK_SPEED,
  moveBody, stepPlayer, type Input, type Player, type Solid,
} from "./walk";

const cells = (...cs: Array<[number, number, number]>): Solid => {
  const s = new Set(cs.map((c) => c.join(",")));
  return (x, y, z) => s.has(`${x},${y},${z}`);
};
const none: Solid = () => false;
const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 3);

describe("walk body", () => {
  it("lands on the ground plane", () => {
    const r = moveBody([0, 3, 0], [0, -5, 0], none, -0.5);
    close(r.feet[1], -0.5);
    expect(r.onGround).toBe(true);
  });

  it("lands on top of a block instead of falling through it", () => {
    const r = moveBody([0, 5, 0], [0, -20, 0], cells([0, 0, 0]), -10);
    close(r.feet[1], 0.5);
    expect(r.onGround).toBe(true);
  });

  it("bumps its head on a ceiling", () => {
    const r = moveBody([0, 0, 0], [0, 2, 0], cells([0, 3, 0]), -0.5);
    close(r.feet[1], 2.5 - HEIGHT);
    expect(r.hitY).toBe(true);
    expect(r.onGround).toBe(false);
  });

  it("stops at a wall and slides along it", () => {
    const wall = cells([2, 0, 0], [2, 1, 0], [2, 0, 1], [2, 1, 1]);
    const r = moveBody([0, -0.5, 0], [3, 0, 1], wall, -0.5);
    close(r.feet[0], 1.5 - HALF_WIDTH);
    close(r.feet[2], 1);
    expect(r.hitX).toBe(true);
    expect(r.hitZ).toBe(false);
  });

  it("walks freely past a block it only touches", () => {
    const r = moveBody([0, -0.5, 0.2], [0, 0, 0], cells([0, -1, 0]), -0.5);
    expect(r.hitX || r.hitZ).toBe(false);
  });

  it("lets a body that starts inside blocks move out", () => {
    const r = moveBody([0, 0, 0], [3, 0, 0], cells([0, 0, 0], [1, 0, 0]), -0.5);
    close(r.feet[0], 3);
  });
});

describe("player step", () => {
  const still: Input = { facing: [0, -1], forward: 0, right: 0, up: false, down: false, sprint: false };
  const run = (pl: Player, inp: Partial<Input>, seconds: number, solid: Solid = none, floorY = -0.5) => {
    for (let t = 0; t < seconds; t += 1 / 60) pl = stepPlayer(pl, { ...still, ...inp }, 1 / 60, solid, floorY);
    return pl;
  };
  const air = (y: number, flying: boolean): Player => ({ feet: [0, y, 0], vy: 0, flying, onGround: false });

  it("hovers while flying and falls to the ground after unflying", () => {
    const hover = run(air(10, true), {}, 2);
    close(hover.feet[1], 10);
    const fell = run({ ...hover, flying: false }, {}, 2);
    close(fell.feet[1], -0.5);
    expect(fell.onGround).toBe(true);
  });

  it("rises and sinks while flying, and landing ends the flight", () => {
    const up = run(air(0, true), { up: true }, 1);
    close(up.feet[1], FLY_VERTICAL);
    expect(up.flying).toBe(true);
    const landed = run(up, { down: true }, 3);
    close(landed.feet[1], -0.5);
    expect(landed.flying).toBe(false);
  });

  it("jumps about a block and a quarter, and only from the ground", () => {
    let pl: Player = { feet: [0, -0.5, 0], vy: 0, flying: false, onGround: true };
    let top = pl.feet[1];
    for (let i = 0; i < 60; i++) {
      pl = stepPlayer(pl, { ...still, up: i === 0 }, 1 / 60, none, -0.5);
      top = Math.max(top, pl.feet[1]);
    }
    expect(top + 0.5).toBeGreaterThan(1.1);
    expect(top + 0.5).toBeLessThan(1.4);
    expect(pl.onGround).toBe(true);
    const midair = stepPlayer(air(5, false), { ...still, up: true }, 1 / 60, none, -0.5);
    expect(midair.vy).toBeLessThan(0); // no jumping off thin air
  });

  it("walks, sprints at double speed and flies", () => {
    const ground: Player = { feet: [0, -0.5, 0], vy: 0, flying: false, onGround: true };
    close(-run(ground, { forward: 1 }, 1).feet[2], WALK_SPEED);
    close(-run(ground, { forward: 1, down: true }, 1).feet[2], SPRINT_SPEED);
    close(-run(air(5, true), { forward: 1 }, 1).feet[2], FLY_SPEED);
    close(-run(air(5, true), { forward: 1, sprint: true }, 1).feet[2], FLY_SPRINT_SPEED);
    // D strafes right: facing north, that is +x.
    expect(run(ground, { right: 1 }, 1).feet[0]).toBeCloseTo(WALK_SPEED, 3);
  });

  it("walks into a wall and stops, then stands on a block it falls onto", () => {
    const wall = cells([0, 0, -3], [0, 1, -3]);
    const ground: Player = { feet: [0, -0.5, 0], vy: 0, flying: false, onGround: true };
    close(run(ground, { forward: 1 }, 2, wall).feet[2], -2.5 + HALF_WIDTH);
    const onTop = run(air(6, false), {}, 2, cells([0, 2, 0]));
    close(onTop.feet[1], 2.5);
    expect(onTop.onGround).toBe(true);
  });
});
