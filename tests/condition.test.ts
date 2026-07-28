import { describe, it, expect } from "vitest";
import { compileCondition } from "../src/compiler/condition.ts";

// The condition evaluator is a pure parser → its unit tests are the coverage
// and edge-walk exercises the same behavior in integration.
//
// The blocks below cover every token class, resolution step, and grammar error.
// These exact semantics are the compiler contract.

function evalOn(expr: string, ctx: Record<string, unknown>): boolean {
  const p = compileCondition(expr);
  expect(p.isOk(), `${expr} should compile`).toBe(true);
  return p._unsafeUnwrap()(ctx);
}

function errOf(expr: string): string {
  const r = compileCondition(expr);
  expect(r.isErr(), `${expr} should not compile`).toBe(true);
  return r._unsafeUnwrapErr();
}

describe("compileCondition — the closed grammar", () => {
  it("evaluates the edge-walk continuation-skip condition", () => {
    const expr =
      "prior == null || prior.surface_map == null || prior_workflow != 'edge-walk' || prior.surface_map.revision_hash != revision";
    // No prior yet → run (true).
    expect(evalOn(expr, { prior: null, prior_workflow: null, revision: "abc" })).toBe(true);
    // A prior without a surface map still runs.
    expect(
      evalOn(expr, { prior: { surface_map: null }, prior_workflow: "founder", revision: "abc" }),
    ).toBe(true);
    // A same-revision map from another workflow still runs.
    expect(
      evalOn(expr, {
        prior: { surface_map: { revision_hash: "abc" } },
        prior_workflow: "code-review",
        revision: "abc",
      }),
    ).toBe(true);
    // Edge-walk's own map at the same hash skips.
    expect(
      evalOn(expr, {
        prior: { surface_map: { revision_hash: "abc" } },
        prior_workflow: "edge-walk",
        revision: "abc",
      }),
    ).toBe(false);
    // Prior exists but hash drifted → re-run (true).
    expect(
      evalOn(expr, {
        prior: { surface_map: { revision_hash: "old" } },
        prior_workflow: "edge-walk",
        revision: "new",
      }),
    ).toBe(true);
  });

  it("compares literals: null, booleans, numbers, quoted strings", () => {
    expect(evalOn("input.n == 3", { input: { n: 3 } })).toBe(true);
    expect(evalOn("input.n != 3", { input: { n: 3 } })).toBe(false);
    expect(evalOn("input.flag == true", { input: { flag: true } })).toBe(true);
    expect(evalOn('input.name == "ada"', { input: { name: "ada" } })).toBe(true);
    expect(evalOn("missing.path == null", {})).toBe(true);
  });

  it("binds && tighter than ||", () => {
    // false || (true && true) → true
    expect(evalOn("a == 1 || b == 2 && c == 3", { a: 0, b: 2, c: 3 })).toBe(true);
    // false || (true && false) → false
    expect(evalOn("a == 1 || b == 2 && c == 3", { a: 0, b: 2, c: 9 })).toBe(false);
  });

  it("rejects malformed expressions without throwing", () => {
    for (const bad of ["", "a ==", "== b", "a == b ==", "a && && b", "a =< b"]) {
      const r = compileCondition(bad);
      expect(r.isErr(), bad).toBe(true);
    }
  });
});

// --- the token cascade, arm by arm (classify) --------------------------------
// Order matters: operators, then the three bare keywords, then quoted strings,
// then numerics, then "anything else is a dotted path". Each `it` pins one arm
// AND the arm it must beat, so a reordering of the cascade fails loudly.

describe("classify — operator tokens", () => {
  it("recognizes ==, !=, && and || as operators, not paths", () => {
    expect(evalOn("a == 1", { a: 1 })).toBe(true);
    expect(evalOn("a != 1", { a: 1 })).toBe(false);
    expect(evalOn("a == 1 && b == 2", { a: 1, b: 2 })).toBe(true);
    expect(evalOn("a == 1 || b == 2", { a: 0, b: 2 })).toBe(true);
  });

  it("needs no surrounding whitespace (the lexer is not whitespace-delimited)", () => {
    expect(evalOn("a==1", { a: 1 })).toBe(true);
    expect(evalOn("a==1&&b==2", { a: 1, b: 2 })).toBe(true);
    expect(evalOn("a==1||b==2", { a: 0, b: 2 })).toBe(true);
  });

  it("skips arbitrary whitespace between tokens", () => {
    expect(evalOn("   a    ==\t1   ", { a: 1 })).toBe(true);
    expect(evalOn("a\n==\n1", { a: 1 })).toBe(true);
  });
});

describe("classify — keyword literals", () => {
  it("reads bare null / true / false as literals, never as paths", () => {
    expect(evalOn("a == null", { a: null })).toBe(true);
    expect(evalOn("a == true", { a: true })).toBe(true);
    expect(evalOn("a == false", { a: false })).toBe(true);
    // A ctx key of the same name cannot shadow the literal: `null` never reads ctx.
    expect(evalOn("null == 1", { null: 1 })).toBe(false);
    expect(evalOn("true == 1", { true: 1 })).toBe(false);
    expect(evalOn("false == 1", { false: 1 })).toBe(false);
    // Literal-to-literal comparison is legal and constant.
    expect(evalOn("null == null", {})).toBe(true);
    expect(evalOn("true != false", {})).toBe(true);
  });

  it("does not confuse a longer identifier with a keyword prefix", () => {
    expect(evalOn("nullish == 1", { nullish: 1 })).toBe(true);
    expect(evalOn("truest == 1", { truest: 1 })).toBe(true);
    expect(evalOn("falsey == 1", { falsey: 1 })).toBe(true);
  });

  it("keeps boolean literals type-strict against strings", () => {
    expect(evalOn("a == true", { a: "true" })).toBe(false);
    expect(evalOn("a == false", { a: 0 })).toBe(false);
  });
});

describe("classify — quoted string literals", () => {
  it("accepts double and single quotes and strips exactly one pair", () => {
    expect(evalOn('a == "ada"', { a: "ada" })).toBe(true);
    expect(evalOn("a == 'ada'", { a: "ada" })).toBe(true);
    expect(evalOn('a == ""', { a: "" })).toBe(true);
    expect(evalOn("a == ''", { a: "" })).toBe(true);
  });

  it("quoting beats every later arm — keywords, numbers and dots stay text", () => {
    expect(evalOn('a == "null"', { a: "null" })).toBe(true);
    expect(evalOn('a == "null"', { a: null })).toBe(false);
    expect(evalOn('a == "3"', { a: "3" })).toBe(true);
    expect(evalOn('a == "3"', { a: 3 })).toBe(false);
    expect(evalOn('a == "x.y"', { a: "x.y" })).toBe(true);
  });

  it("carries whitespace and operators inside the quotes", () => {
    expect(evalOn('a == "hello world"', { a: "hello world" })).toBe(true);
    expect(evalOn("a == 'a && b'", { a: "a && b" })).toBe(true);
  });
});

describe("classify — numeric literals", () => {
  it("reads integers, signs and decimals as numbers", () => {
    expect(evalOn("a == 3", { a: 3 })).toBe(true);
    expect(evalOn("a == 0", { a: 0 })).toBe(true);
    expect(evalOn("a == +3", { a: 3 })).toBe(true);
    expect(evalOn("a == -3", { a: -3 })).toBe(true);
    expect(evalOn("a == 1.5", { a: 1.5 })).toBe(true);
    expect(evalOn("a == -1.5", { a: -1.5 })).toBe(true);
  });

  it("compares numbers strictly — no string coercion", () => {
    expect(evalOn("a == 3", { a: "3" })).toBe(false);
    expect(evalOn("a != 3", { a: "3" })).toBe(true);
  });

  it("falls through to a path when the numeric shape does not match exactly", () => {
    // "1.2.3" is not a number token → it is a dotted PATH, resolved on ctx.
    expect(evalOn("1.2.3 == 7", { 1: { 2: { 3: 7 } } })).toBe(true);
    expect(evalOn("1.2.3 == null", {})).toBe(true);
    // A trailing dot likewise falls through to the path arm.
    expect(evalOn("3. == null", {})).toBe(true);
  });
});

describe("classify — the path fallthrough", () => {
  it("treats any remaining identifier as a dotted path", () => {
    expect(evalOn("a == 1", { a: 1 })).toBe(true);
    expect(evalOn("a.b.c == 1", { a: { b: { c: 1 } } })).toBe(true);
  });

  it("admits underscores, digits, plus and minus inside a path segment", () => {
    expect(evalOn("a_1 == 1", { a_1: 1 })).toBe(true);
    expect(evalOn("a-b == 1", { "a-b": 1 })).toBe(true);
    expect(evalOn("a+b == 1", { "a+b": 1 })).toBe(true);
    expect(evalOn("A1_b-c == 1", { "A1_b-c": 1 })).toBe(true);
  });
});

// --- resolve: walking a dotted path over the run context ---------------------

describe("resolve — path lookup over the context", () => {
  it("walks nested objects", () => {
    expect(evalOn("a.b.c == 1", { a: { b: { c: 1 } } })).toBe(true);
    expect(evalOn("a.b.c != 1", { a: { b: { c: 2 } } })).toBe(true);
  });

  it("indexes arrays by numeric segment and reads array properties", () => {
    expect(evalOn("a.1 == 'y'", { a: ["x", "y"] })).toBe(true);
    expect(evalOn("a.length == 2", { a: ["x", "y"] })).toBe(true);
  });

  it("yields undefined (⇒ absent) through null, missing keys and non-objects", () => {
    expect(evalOn("a.b == null", { a: null })).toBe(true);
    expect(evalOn("a.b == null", {})).toBe(true);
    expect(evalOn("a.b.c.d == null", { a: { b: null } })).toBe(true);
    // A primitive is not walked into — even where JS would have a property.
    expect(evalOn("a.length == null", { a: "str" })).toBe(true);
    expect(evalOn("a.x == null", { a: 5 })).toBe(true);
    expect(evalOn("a.x == null", { a: true })).toBe(true);
  });

  it("compares whole objects by identity, not structurally", () => {
    const shared = { k: 1 };
    expect(evalOn("a == b", { a: shared, b: shared })).toBe(true);
    expect(evalOn("a == b", { a: { k: 1 }, b: { k: 1 } })).toBe(false);
  });
});

// --- loose null: undefined and null are the same "absent" ---------------------

describe("loose null normalization", () => {
  it("treats a missing path as equal to the null literal, in both directions", () => {
    expect(evalOn("missing == null", {})).toBe(true);
    expect(evalOn("null == missing", {})).toBe(true);
    expect(evalOn("missing != null", {})).toBe(false);
    expect(evalOn("missing == other", {})).toBe(true); // both absent
  });

  it("normalizes an explicit undefined value the same way", () => {
    expect(evalOn("a == null", { a: undefined })).toBe(true);
    expect(evalOn("a == b", { a: undefined, b: null })).toBe(true);
  });

  it("normalizes ONLY undefined — falsy values stay themselves", () => {
    expect(evalOn("a == null", { a: false })).toBe(false);
    expect(evalOn("a == null", { a: 0 })).toBe(false);
    expect(evalOn("a == null", { a: "" })).toBe(false);
  });
});

// --- precedence and folding ---------------------------------------------------

describe("precedence and folding", () => {
  it("passes a single comparison through unwrapped", () => {
    expect(evalOn("a == 1", { a: 1 })).toBe(true);
    expect(evalOn("a == 1", { a: 2 })).toBe(false);
  });

  it("folds an || chain with `some` and an && chain with `every`", () => {
    expect(evalOn("a == 1 || b == 1 || c == 1", { a: 0, b: 0, c: 1 })).toBe(true);
    expect(evalOn("a == 1 || b == 1 || c == 1", { a: 0, b: 0, c: 0 })).toBe(false);
    expect(evalOn("a == 1 && b == 1 && c == 1", { a: 1, b: 1, c: 1 })).toBe(true);
    expect(evalOn("a == 1 && b == 1 && c == 1", { a: 1, b: 1, c: 0 })).toBe(false);
  });

  it("keeps && tighter than || on both sides of the ||", () => {
    // (true && false) || false → false
    expect(evalOn("a == 1 && b == 1 || c == 1", { a: 1, b: 0, c: 0 })).toBe(false);
    // (true && false) || true → true
    expect(evalOn("a == 1 && b == 1 || c == 1", { a: 1, b: 0, c: 1 })).toBe(true);
    // false || (false && false) || true → true
    expect(evalOn("a == 1 || b == 1 && c == 1 || d == 1", { a: 0, b: 0, c: 0, d: 1 })).toBe(true);
  });

  it("returns a reusable pure predicate", () => {
    const p = compileCondition("a == 1")._unsafeUnwrap();
    expect(p({ a: 1 })).toBe(true);
    expect(p({ a: 2 })).toBe(false);
    expect(p({ a: 1 })).toBe(true);
  });
});

// --- error surface: every failure is an Err, with a message that names the site

describe("error surface — compilation failures are Results, never throws", () => {
  it("rejects an empty or whitespace-only condition", () => {
    expect(errOf("")).toBe("empty condition");
    expect(errOf("   ")).toBe("empty condition");
    expect(errOf("\t\n ")).toBe("empty condition");
  });

  it("rejects an unlexable character, quoting the remaining source", () => {
    expect(errOf("a =< b")).toBe('unexpected token at "=< b"');
    expect(errOf("a == $b")).toBe('unexpected token at "$b"');
    expect(errOf("(a == 1)")).toBe('unexpected token at "(a == 1)"');
    expect(errOf('a == "unterminated')).toBe('unexpected token at ""unterminated"');
  });

  it("rejects a comparison that is not exactly <a> <op> <b>", () => {
    expect(errOf("a")).toBe('expected "<a> == <b>" or "<a> != <b>", got 1 tokens');
    expect(errOf("a == b == c")).toBe('expected "<a> == <b>" or "<a> != <b>", got 5 tokens');
    expect(errOf("a b c")).toBe('expected "<a> == <b>" or "<a> != <b>", got 3 tokens');
    expect(errOf("a == b c")).toBe('expected "<a> == <b>" or "<a> != <b>", got 4 tokens');
    expect(errOf("a ==")).toBe('expected "<a> == <b>" or "<a> != <b>", got 2 tokens');
    expect(errOf("== b")).toBe('expected "<a> == <b>" or "<a> != <b>", got 2 tokens');
  });

  it("rejects an operator where a value belongs", () => {
    expect(errOf("== == 1")).toBe("expected a value");
    expect(errOf("1 == ==")).toBe("expected a value");
  });

  it("rejects an empty operand around || and &&", () => {
    expect(errOf("|| a == 1")).toBe('empty operand around "||"');
    expect(errOf("a == 1 ||")).toBe('empty operand around "||"');
    expect(errOf("a == 1 || || b == 2")).toBe('empty operand around "||"');
    expect(errOf("&& a == 1")).toBe('empty operand around "&&"');
    expect(errOf("a == 1 &&")).toBe('empty operand around "&&"');
    expect(errOf("a == 1 && && b == 2")).toBe('empty operand around "&&"');
  });

  it("reports the FIRST failing part of a compound condition", () => {
    expect(errOf("a == || b == 2")).toBe('expected "<a> == <b>" or "<a> != <b>", got 2 tokens');
  });
});
