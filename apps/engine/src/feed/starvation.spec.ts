import { describe, expect, it } from "vitest";
import { StarvationMonitor } from "./starvation";

describe("StarvationMonitor (SPEC §12.6.1)", () => {
  it("is not starved while disconnected (idle-with-pings outside hours)", () => {
    const m = new StarvationMonitor(20_000);
    expect(m.isStarved(1_000_000)).toBe(false);
  });

  it("flags starvation when connected >20s with zero data frames", () => {
    const m = new StarvationMonitor(20_000);
    m.onConnected(0);
    expect(m.isStarved(19_000)).toBe(false);
    expect(m.isStarved(21_000)).toBe(true);
  });

  it("data frames keep the connection fed", () => {
    const m = new StarvationMonitor(20_000);
    m.onConnected(0);
    m.onDataFrame(15_000);
    expect(m.isStarved(30_000)).toBe(false);
    expect(m.isStarved(36_000)).toBe(true);
    expect(m.dataSilenceMs(36_000)).toBe(21_000);
  });

  it("resets on disconnect", () => {
    const m = new StarvationMonitor(20_000);
    m.onConnected(0);
    m.onDisconnected();
    expect(m.isStarved(100_000)).toBe(false);
  });
});
