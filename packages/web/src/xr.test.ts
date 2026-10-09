import { describe, expect, it } from "vitest";
import { deadzone, rotateAbout, type Pad, SNAP_ANGLE, snapTurn, stickOf, walkInput, wrap, yawFacing } from "./xr";
import { wheelSlice } from "./wand";

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);
const pad: Pad = { move: [0, 0], rise: [0, 0], jump: false, sprint: false, flying: false, facing: [0, -1] };

describe("sticks", () => {
  it("reads the thumbstick from axes 2 and 3, or 0 and 1 on a one-stick pad", () => {
    expect(stickOf([0, 0, 0.5, -0.25])).toEqual([0.5, -0.25]);
    expect(stickOf([0.1, 0.2])).toEqual([0.1, 0.2]);
  });

  it("zeroes the deadzone and ramps from its edge to full", () => {
    expect(deadzone(0.1, 0.1)).toEqual([0, 0]);
    expect(deadzone(0.19, 0)).toEqual([0, 0]);
    close(deadzone(1, 0)[0], 1);
    close(deadzone(0.6, 0)[0], 0.5);
    const [x, y] = deadzone(0, -1.4); // past the rim still clamps to 1
    close(x, 0); close(y, -1);
  });

  it("pushing the left stick forward walks forward, right strafes right", () => {
    const f = walkInput({ ...pad, move: [0, -1] });
    close(f.forward, 1); close(f.right, 0);
    const r = walkInput({ ...pad, move: [1, 0] });
    close(r.forward, 0); close(r.right, 1);
    const idle = walkInput({ ...pad, move: [0.1, -0.1] }); // inside the deadzone
    close(idle.forward, 0); close(idle.right, 0);
  });

  it("passes the facing through", () => {
    expect(walkInput({ ...pad, facing: [1, 0] }).facing).toEqual([1, 0]);
  });

  it("jumps and sprints on buttons; the right stick only rises and sinks while flying", () => {
    expect(walkInput({ ...pad, jump: true }).up).toBe(true);
    expect(walkInput({ ...pad, sprint: true }).down).toBe(true);
    expect(walkInput({ ...pad, rise: [0, -1] }).up).toBe(false);
    expect(walkInput({ ...pad, rise: [0, -1], flying: true }).up).toBe(true);
    expect(walkInput({ ...pad, rise: [0, 1], flying: true }).down).toBe(true);
    expect(walkInput({ ...pad, rise: [0, -0.4], flying: true }).up).toBe(false);
  });

  it("the wheel sees the stick as a screen-space flick: up is the first slice, right is the second", () => {
    expect(wheelSlice(0 * 60, -1 * 60)).toBe("copy");
    expect(wheelSlice(1 * 60, 0.2 * 60)).toBe("paste");
    expect(wheelSlice(0.1 * 60, 0.1 * 60)).toBeNull();
  });
});

describe("snap turn", () => {
  it("turns once per flick and re-arms only near centre", () => {
    let s = snapTurn(true, 0);
    expect(s.turn).toBe(0);
    s = snapTurn(s.armed, 0.9);
    expect(s).toEqual({ turn: 1, armed: false });
    s = snapTurn(s.armed, 0.95); // still held over
    expect(s).toEqual({ turn: 0, armed: false });
    s = snapTurn(s.armed, 0.5); // not back to centre yet
    expect(s).toEqual({ turn: 0, armed: false });
    s = snapTurn(s.armed, 0.1);
    expect(s).toEqual({ turn: 0, armed: true });
    expect(snapTurn(true, -0.9)).toEqual({ turn: -1, armed: false });
  });

  it("ignores a gentle push", () => {
    expect(snapTurn(true, 0.6).turn).toBe(0);
  });
});

describe("rig rotation", () => {
  it("keeps the pivot fixed in the world", () => {
    // Rig at (2, 0) with the headset 1 m ahead of it (rig yaw 0, ahead is -z), at (2, -1).
    const r = rotateAbout({ x: 2, z: 0, yaw: 0 }, 2, -1, SNAP_ANGLE);
    // The headset's world position is rig + R(yaw) * (0, -1); it must still be (2, -1).
    const hx = r.x - Math.sin(r.yaw);
    const hz = r.z - Math.cos(r.yaw);
    close(hx, 2); close(hz, -1);
    close(r.yaw, SNAP_ANGLE);
  });

  it("turning back undoes it", () => {
    const a = rotateAbout({ x: 5, z: 3, yaw: 0.2 }, 1, 1, 1.1);
    const b = rotateAbout(a, 1, 1, -1.1);
    close(b.x, 5); close(b.z, 3); close(b.yaw, 0.2);
  });

  it("a quarter turn about the origin sends +x to -z", () => {
    const r = rotateAbout({ x: 1, z: 0, yaw: 0 }, 0, 0, Math.PI / 2);
    close(r.x, 0); close(r.z, -1);
  });

  it("yawFacing points a straight-ahead headset the right way", () => {
    close(yawFacing(0, -1), 0);
    close(yawFacing(-1, 0), Math.PI / 2); // a quarter turn left faces west
    close(yawFacing(1, 0), -Math.PI / 2);
  });
});

describe("wrap", () => {
  it("wraps at spaces and cuts overlong words", () => {
    expect(wrap("aa bb cc dd", 5)).toEqual(["aa bb", "cc dd"]);
    expect(wrap("abcdefgh", 3)).toEqual(["abc", "def", "gh"]);
    expect(wrap("", 5)).toEqual([]);
  });
});
