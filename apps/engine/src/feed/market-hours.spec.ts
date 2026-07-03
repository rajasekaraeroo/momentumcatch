import { describe, expect, it } from "vitest";
import { isWithinFeedWindow, toIst } from "./market-hours";

const sched = {
  connectIst: "09:00",
  disconnectIst: "15:35",
  holidays: new Set(["2026-08-15"]),
};

// 2026-07-01 is a Wednesday
const wednesday = (h: number, m: number) => Date.UTC(2026, 6, 1, h - 5, m - 30);

describe("toIst", () => {
  it("converts UTC to IST date and minutes (+05:30, no DST)", () => {
    const ist = toIst(Date.UTC(2026, 6, 1, 3, 45)); // 09:15 IST
    expect(ist.dateIst).toBe("2026-07-01");
    expect(ist.minutesIst).toBe(9 * 60 + 15);
    expect(ist.dayOfWeekIst).toBe(3);
  });

  it("rolls the IST date past midnight", () => {
    const ist = toIst(Date.UTC(2026, 6, 1, 20, 0)); // 01:30 IST next day
    expect(ist.dateIst).toBe("2026-07-02");
  });
});

describe("hotKeyTtlSec", () => {
  it("expires 1 hour past market close", async () => {
    const { hotKeyTtlSec } = await import("./market-hours");
    // 11:00 IST, close 15:35 → 4h35m to close + 1h = 20100s
    expect(hotKeyTtlSec(wednesday(11, 0), "15:35")).toBe(20_100);
    // after close → residual floor
    expect(hotKeyTtlSec(wednesday(17, 0), "15:35")).toBe(60);
    // 16:00 IST is 25 min past close → 35 min of the +1h remain
    expect(hotKeyTtlSec(wednesday(16, 0), "15:35")).toBe(35 * 60);
  });
});

describe("isWithinFeedWindow", () => {
  it("is open mid-session on a weekday", () => {
    expect(isWithinFeedWindow(wednesday(11, 0), sched)).toBe(true);
  });

  it("opens exactly at connect time and closes at disconnect time", () => {
    expect(isWithinFeedWindow(wednesday(9, 0), sched)).toBe(true);
    expect(isWithinFeedWindow(wednesday(8, 59), sched)).toBe(false);
    expect(isWithinFeedWindow(wednesday(15, 35), sched)).toBe(false);
    expect(isWithinFeedWindow(wednesday(15, 34), sched)).toBe(true);
  });

  it("is closed on weekends", () => {
    const saturday = Date.UTC(2026, 6, 4, 5, 30); // 11:00 IST Saturday
    expect(isWithinFeedWindow(saturday, sched)).toBe(false);
  });

  it("is closed on NSE holidays", () => {
    const holiday = Date.UTC(2026, 7, 15, 5, 30); // 2026-08-15, a Saturday anyway — use a weekday holiday
    expect(isWithinFeedWindow(holiday, sched)).toBe(false);
    const holidaySched = { ...sched, holidays: new Set(["2026-07-01"]) };
    expect(isWithinFeedWindow(wednesday(11, 0), holidaySched)).toBe(false);
  });
});
