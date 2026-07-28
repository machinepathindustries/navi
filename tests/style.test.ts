import { describe, expect, it } from "vitest";
import { rule, bold, dim, accent, paintCode, statusCode, relTime, shortClause } from "../src/style.ts";

describe("style — rule", () => {
  it("pads a labeled rule to 62 chars", () => {
    const line = rule("next");
    expect(line.startsWith("── next ──")).toBe(true);
    expect(line.length).toBe(62);
    expect(line).toMatch(/^── next ─+$/);
  });

  it("empty label is a plain full-width dash line", () => {
    const line = rule("");
    expect(line).toBe("─".repeat(62));
    expect(line.length).toBe(62);
  });
});

describe("style — paint / statusCode", () => {
  it("colorizers are plain off-TTY and wrap on TTY", () => {
    expect(bold("x", false)).toBe("x");
    expect(dim("x", false)).toBe("x");
    expect(accent("x", false)).toBe("x");
    expect(paintCode("32", "ok", false)).toBe("ok");
    expect(bold("x", true)).toBe("\x1b[1mx\x1b[0m");
    expect(accent("x", true)).toBe("\x1b[36mx\x1b[0m");
    expect(paintCode("32", "ok", true)).toBe("\x1b[32mok\x1b[0m");
  });

  it("statusCode maps healthy / in-progress / bad / unknown", () => {
    expect(statusCode("CLEAR")).toBe("32");
    expect(statusCode("DIRECT")).toBe("32");
    expect(statusCode("awaiting_parent")).toBe("33");
    expect(statusCode("REPAIR")).toBe("33");
    expect(statusCode("ESCALATE")).toBe("31");
    expect(statusCode("blocked")).toBe("31");
    expect(statusCode("—")).toBe("2");
  });
});

describe("style — relTime", () => {
  const now = Date.parse("2026-07-24T12:00:00.000Z");

  it("buckets: just now / Nm / Nh / Nd / date", () => {
    expect(relTime("2026-07-24T11:59:30.000Z", now)).toBe("just now");
    expect(relTime("2026-07-24T11:30:00.000Z", now)).toBe("30m ago");
    expect(relTime("2026-07-24T07:00:00.000Z", now)).toBe("5h ago");
    expect(relTime("2026-07-22T12:00:00.000Z", now)).toBe("2d ago");
    expect(relTime("2026-07-10T12:00:00.000Z", now)).toBe("Jul 10");
  });
});

describe("style — shortClause", () => {
  it("returns short text unchanged; empty stays empty", () => {
    expect(shortClause("short ask", 64)).toBe("short ask");
    expect(shortClause("", 64)).toBe("");
    expect(shortClause("  spaced  \n  out  ", 64)).toBe("spaced out");
  });

  it("cuts at a clause boundary without ellipsis when one sits at/before the cap", () => {
    // Colon clause inside the cap → finished-looking cut, no ….
    const s =
      "Founder judgment for a scoped decision: whether to ship the gate restyle now, or wait.";
    const out = shortClause(s, 64);
    expect(out.length).toBeLessThanOrEqual(64);
    expect(out).not.toContain("…");
    expect(out).toMatch(/Founder judgment for a scoped decision$/);
  });

  it("falls back to a word-boundary cut + ellipsis — never mid-word", () => {
    // No clause punct; long run of words past the cap.
    const words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo";
    expect(words.length).toBeGreaterThan(40);
    const out = shortClause(words, 40);
    expect(out.endsWith("…")).toBe(true);
    const body = out.slice(0, -1);
    expect(body.length).toBeLessThanOrEqual(40);
    // Last character of the body is not mid-word: either end of a full word or empty.
    expect(body).toMatch(/(^| )[a-z]+$/);
    // No partial word from the source appears after a space cut.
    expect(words.startsWith(body)).toBe(true);
  });
});
