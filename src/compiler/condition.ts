// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

import { match, P } from "ts-pattern";
import { Result, ok, err } from "neverthrow";

// A step `condition:` string → a pure predicate over the run context. This is
// the DSL's `condition` field compiling toward native `.branch()`. The grammar
// is intentionally a closed
// set — equality/inequality of dotted paths and literals, joined by && / || —
// sized to exactly its known consumer, edge-walk's continuation-skip (fresh,
// missing/foreign map, or changed revision means run). It is not a
// general expression language; unrecognized syntax is a compile error, and the
// evaluator is unit-tested. Everything returns a Result: a bad condition fails
// compilation rather than throwing mid-run.

export type Ctx = Record<string, unknown>;
export type Predicate = (ctx: Ctx) => boolean;

type Tok =
  | { k: "op"; v: "||" | "&&" | "==" | "!=" }
  | { k: "lit"; v: unknown }
  | { k: "path"; v: string[] };

const TOKEN = /\s*(\|\||&&|==|!=|"[^"]*"|'[^']*'|[A-Za-z0-9_.+-]+)/y;

// The lexer remains lazy and branch-free. Whitespace is skipped by advancing the
// cursor in a boolean-conditioned while (a trailing run of spaces must end the
// scan, not fail it — TOKEN's own leading `\s*` only absorbs whitespace that
// PRECEDES a token). One scan step then either consumes a token or fails, and the
// walk itself stops on the first Err.
const WS = /\s/;
const skipWs = (src: string, from: number): number => {
  let pos = from;
  while (pos < src.length && WS.test(src[pos] ?? "")) pos++;
  return pos;
};

type Scan = { pos: number; out: Tok[] };

// TOKEN is sticky, so a hit must start at lastIndex; keep the index check as a
// defensive parser invariant.
const scanStep = (src: string, s: Scan): Result<Scan, string> => {
  TOKEN.lastIndex = s.pos;
  const m = TOKEN.exec(src);
  return match(m)
    .with(
      P.when((hit): hit is RegExpExecArray => hit !== null && hit.index === s.pos),
      (hit) => ok<Scan, string>({ pos: skipWs(src, TOKEN.lastIndex), out: [...s.out, classify(hit[1]!)] }),
    )
    .otherwise(() => err<Scan, string>(`unexpected token at "${src.slice(s.pos)}"`));
};

function tokenize(src: string): Result<Tok[], string> {
  TOKEN.lastIndex = 0;
  let state: Result<Scan, string> = ok({ pos: skipWs(src, 0), out: [] });
  while (state.isOk() && state.value.pos < src.length) state = scanStep(src, state.value);
  return state.map((s) => s.out);
}

// The cascade is ORDERED: operators, then the three bare keywords, then a quoted
// string (which beats every later arm — `"null"`/`"3"` stay text), then a numeric
// literal, then "anything else is a dotted path". One match, arms in that order.
const QUOTED = /^["']/;
const NUMERIC = /^[+-]?\d+(\.\d+)?$/;

function classify(raw: string): Tok {
  return match(raw)
    .with("||", "&&", "==", "!=", (v): Tok => ({ k: "op", v }))
    .with("null", (): Tok => ({ k: "lit", v: null }))
    .with("true", (): Tok => ({ k: "lit", v: true }))
    .with("false", (): Tok => ({ k: "lit", v: false }))
    .when((r) => QUOTED.test(r), (r): Tok => ({ k: "lit", v: r.slice(1, -1) }))
    .when((r) => NUMERIC.test(r), (r): Tok => ({ k: "lit", v: Number(r) }))
    .otherwise((r): Tok => ({ k: "path", v: r.split(".") }));
}

// A primitive is never walked into (a string's `.length` is not a path step), and
// neither is null/undefined — every such step yields undefined, i.e. "absent".
const isIndexable = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object";

function resolve(ctx: Ctx, path: string[]): unknown {
  return path.reduce<unknown>(
    (acc, key) =>
      match(acc)
        .with(P.when(isIndexable), (o) => o[key])
        .otherwise(() => undefined),
    ctx,
  );
}

// The Predicate half is a placeholder (`() => false`); `read` is the real payload —
// callers only ever consult it. Kept as one object so compileCmp can Result.combine.
type Operand = Predicate & { read: (ctx: Ctx) => unknown };
const operandOf = (read: (ctx: Ctx) => unknown): Operand => Object.assign(() => false, { read });

function operand(tok: Tok | undefined): Result<Operand, string> {
  return match(tok)
    .with(undefined, () => err<Operand, string>("expected a value"))
    .with({ k: "op" }, () => err<Operand, string>("expected a value"))
    .with({ k: "lit" }, (t) => ok<Operand, string>(operandOf(() => t.v)))
    .with({ k: "path" }, (t) => ok<Operand, string>(operandOf((ctx) => resolve(ctx, t.v))))
    .exhaustive();
}

// Precedence: `||` (loosest) over `&&` over comparison. Split on the operators
// rather than build a parse tree — the closed grammar has no parentheses.
function compileOr(toks: Tok[]): Result<Predicate, string> {
  return splitOn(toks, "||").andThen((parts) =>
    combine(parts.map(compileAnd), (preds) => (ctx) => preds.some((p) => p(ctx))),
  );
}

function compileAnd(toks: Tok[]): Result<Predicate, string> {
  return splitOn(toks, "&&").andThen((parts) =>
    combine(parts.map(compileCmp), (preds) => (ctx) => preds.every((p) => p(ctx))),
  );
}

// Loose null: a missing path (undefined) equals a `null` literal, so
// `prior == null` and `prior.surface_map == null` both read as "absent".
// `?? null` IS that normalization (null ?? null is null) — a coalesce, not dispatch.
const norm = (v: unknown): unknown => v ?? null;

function compileCmp(toks: Tok[]): Result<Predicate, string> {
  return match(toks)
    .with([P._, { k: "op", v: P.union("==", "!=") }, P._], ([l, op, r]) => {
      const eq = op.v === "==";
      return Result.combine([operand(l), operand(r)]).map(
        ([a, b]): Predicate =>
          (ctx) =>
            (norm(a.read(ctx)) === norm(b.read(ctx))) === eq,
      );
    })
    .otherwise(() => err<Predicate, string>(`expected "<a> == <b>" or "<a> != <b>", got ${toks.length} tokens`));
}

function splitOn(toks: Tok[], op: "||" | "&&"): Result<Tok[][], string> {
  const parts: Tok[][] = [[]];
  for (const t of toks)
    match(t)
      .with({ k: "op", v: op }, () => parts.push([]))
      // parts is seeded [[]] and only ever grown, so the last group is always present;
      // narrowing .at(-1) EARNS that instead of asserting it with `!`.
      .otherwise(() =>
        match(parts.at(-1))
          .with(P.nonNullable, (last) => last.push(t))
          .otherwise(() => 0),
      );
  return match(parts.every((p) => p.length > 0))
    .with(true, () => ok<Tok[][], string>(parts))
    .with(false, () => err<Tok[][], string>(`empty operand around "${op}"`))
    .exhaustive();
}

function combine(
  results: Result<Predicate, string>[],
  fold: (preds: Predicate[]) => Predicate,
): Result<Predicate, string> {
  return Result.combine(results).map((preds) =>
    match(preds)
      .with([P._], ([only]) => only)
      .otherwise(() => fold(preds)),
  );
}

export function compileCondition(expr: string): Result<Predicate, string> {
  return tokenize(expr).andThen((toks) =>
    match(toks)
      .with([], () => err<Predicate, string>("empty condition"))
      .otherwise(compileOr),
  );
}
