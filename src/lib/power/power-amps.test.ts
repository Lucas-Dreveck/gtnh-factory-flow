import { describe, expect, it } from "vitest";
import {
  euToAmps,
  formatAmps,
  generatorsToCoverDeficit,
  highestTier,
  powerAmpsReadout,
  tierVoltage,
} from "./power-amps";

describe("power amps", () => {
  it("uses 8 * 4^index voltages", () => {
    expect(tierVoltage("LV")).toBe(32);
    expect(tierVoltage("MV")).toBe(128);
    expect(tierVoltage("HV")).toBe(512);
    expect(tierVoltage("EV")).toBe(2048);
  });
  it("converts and rounds", () => {
    expect(euToAmps(96, "LV")).toBe(3);
    expect(formatAmps(euToAmps(100, "LV"))).toBe("3.13");
    expect(formatAmps(-0.001)).toBe("0");
  });
  it("picks the highest tier", () => {
    expect(highestTier([undefined, "MV", "EV", "LV"])).toBe("EV");
    expect(highestTier([])).toBe("LV");
  });
  it("reads surplus and deficit", () => {
    const up = powerAmpsReadout(35000, 10000, "EV");
    expect(up.deficit).toBe(false);
    expect(up.wholeAmps).toBe(12);
    expect(up.summary).toBe("≈ 12 full amps spare");
    const down = powerAmpsReadout(1000, 4096, "EV");
    expect(down.deficit).toBe(true);
    expect(down.netAmps).toBeCloseTo(-1.5117, 3);
    expect(down.summary).toBe("short by 1.51 A");
  });
  it("counts generators to cover a deficit", () => {
    expect(generatorsToCoverDeficit(-100, 32)).toBe(4);
    expect(generatorsToCoverDeficit(50, 32)).toBe(0);
  });
});
