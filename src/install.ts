// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

// =============================================================================
// THE ONLY PLACE navi WRITES TO A USER'S TREE.
//
// The install is a small, recoverable transaction. Two fixed symlinks connect a
// project to one navi installation; a versioned receipt records exactly which
// parent directories this transaction created. Uninstall removes only links
// whose targets match the receipt, then prunes only those recorded directories.
//
// Once the first exclusive receipt exists, an interrupted transaction can resume
// using a scratch path derived from that receipt's transaction UUID. Anything not
// owned by that valid receipt or an exact current-source link is foreign ownership
// and is left unchanged.
// =============================================================================

import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Result, err, ok } from "neverthrow";
import { match, P } from "ts-pattern";
import { z } from "zod";
import { errStr } from "./err.ts";
import { shellQuote } from "./invocation.ts";
import { isContainedIn, resolveExisting } from "./mastra/path-guard.ts";

export const DEFAULT_SKILL_DIR = join(".agents", "skills");
export const DEFAULT_BIN_DIR = join(".agents", "bin");
export const RECEIPT_REL = ".navi-interop-install.json";
const INTEROP = "navi-interop";
const LOCAL_BIN = "navi";
const RECEIPT_SCHEMA = "navi.interop-install.v1" as const;
const OWNED_DIRS = [".agents", DEFAULT_SKILL_DIR, DEFAULT_BIN_DIR] as const;
type OwnedDir = (typeof OWNED_DIRS)[number];
type ReceiptState = "installing" | "installed" | "uninstalling";
type InstallAction = "created" | "already-linked" | "recovered";

const ReceiptSchema = z
  .object({
    schema: z.literal(RECEIPT_SCHEMA),
    state: z.enum(["installing", "installed", "uninstalling"]),
    install_root: z.string().min(1).refine(isAbsolute, "install_root must be absolute"),
    skill_source: z.string().min(1).refine(isAbsolute, "skill_source must be absolute"),
    launcher_source: z.string().min(1).refine(isAbsolute, "launcher_source must be absolute"),
    created_dirs: z
      .array(z.enum(OWNED_DIRS))
      .max(OWNED_DIRS.length)
      .refine((dirs) => new Set(dirs).size === dirs.length, "created_dirs must not contain duplicates"),
    transaction_id: z.string().uuid(),
  })
  .strict();
type Receipt = z.infer<typeof ReceiptSchema>;

type LinkState =
  | { kind: "missing" }
  | { kind: "non-link" }
  | { kind: "link"; target: string };

type InstallLayout = {
  installRoot: string;
  projectRoot: string;
  source: string;
  target: string;
  launcherSource: string;
  launcherTarget: string;
  receiptPath: string;
};

export type InstallPlan = InstallLayout & {
  action: InstallAction;
  createdDirs: OwnedDir[];
  receipt: Receipt | undefined;
  skillState: LinkState;
  launcherState: LinkState;
  transactionId: string;
};

const MISSING = "missing" as const;
type FsReadError = typeof MISSING | string;

function fsReadError(error: unknown): FsReadError {
  return match(error)
    .with({ code: P.union("ENOENT", "ENOTDIR") }, () => MISSING)
    .otherwise(errStr);
}

const lstat = Result.fromThrowable(
  (p: string) => lstatSync(p),
  fsReadError,
);
const readLink = Result.fromThrowable(
  (p: string) => readlinkSync(p),
  errStr,
);
const readText = Result.fromThrowable((p: string) => readFileSync(p, "utf8"), errStr);
const parseJson = Result.fromThrowable((text: string) => JSON.parse(text) as unknown, errStr);
const doMkdir = Result.fromThrowable((p: string) => mkdirSync(p, { mode: 0o755 }), errStr);
const doUnlink = Result.fromThrowable((p: string) => unlinkSync(p), errStr);
const doRename = Result.fromThrowable((from: string, to: string) => renameSync(from, to), errStr);
const doWriteNew = Result.fromThrowable(
  (path: string, text: string) => writeFileSync(path, text, { encoding: "utf8", flag: "wx", mode: 0o600 }),
  errStr,
);
const doSymlink = Result.fromThrowable(
  (source: string, target: string) => symlinkSync(source, target, "file"),
  errStr,
);
const doRmdir = Result.fromThrowable(
  (path: string) => rmdirSync(path),
  (error) => error,
);
const requireWritableDirectory = Result.fromThrowable(
  (path: string) => accessSync(path, constants.W_OK | constants.X_OK),
  errStr,
);

export function interopSource(installRoot: string): string {
  return join(resolveExisting(resolve(installRoot)), "agent", "skills", INTEROP);
}

export function localLauncherSource(installRoot: string): string {
  return join(resolveExisting(resolve(installRoot)), "bin", "navi-local");
}

function layoutOf(
  installRoot: string,
  to: string,
  requireSources: boolean = true,
): Result<InstallLayout, string> {
  const root = resolveExisting(resolve(installRoot));
  const projectRoot = resolveExisting(resolve(to));
  const target = join(projectRoot, DEFAULT_SKILL_DIR, INTEROP);
  const launcherTarget = join(projectRoot, DEFAULT_BIN_DIR, LOCAL_BIN);
  const receiptPath = join(projectRoot, RECEIPT_REL);
  const parents = [dirname(target), dirname(launcherTarget), dirname(receiptPath)];
  const escaped = parents
    .map((p) => resolveExisting(p))
    .find((p) => !isContainedIn(projectRoot, p));

  return match({
    projectExists: existsSync(projectRoot),
    sourceExists: !requireSources || existsSync(interopSource(root)),
    launcherExists: !requireSources || existsSync(localLauncherSource(root)),
    escaped,
  })
    .with({ projectExists: false }, () =>
      err<InstallLayout, string>(`requested project does not exist: ${projectRoot}`),
    )
    .with({ sourceExists: false }, () =>
      err<InstallLayout, string>(
        `cannot find the interop skill at ${interopSource(root)} — is this a complete navi install?`,
      ),
    )
    .with({ launcherExists: false }, () =>
      err<InstallLayout, string>(
        `cannot find the local launcher at ${localLauncherSource(root)} — is this a complete navi install?`,
      ),
    )
    .with({ escaped: P.string }, ({ escaped: outside }) =>
      err<InstallLayout, string>(
        `refusing to use project install paths — ${outside} is outside the requested project ${projectRoot}.`,
      ),
    )
    .otherwise(() =>
      ok<InstallLayout, string>({
        installRoot: root,
        projectRoot,
        source: interopSource(root),
        target,
        launcherSource: localLauncherSource(root),
        launcherTarget,
        receiptPath,
      }),
    );
}

function linkState(path: string): Result<LinkState, string> {
  return lstat(path).match(
    (st) =>
      match(st.isSymbolicLink())
        .with(false, () => ok<LinkState, string>({ kind: "non-link" }))
        .with(true, () =>
          readLink(path)
            .map((value): LinkState => ({ kind: "link", target: resolve(dirname(path), value) }))
            .mapErr(() => `${path} is a symlink navi could not read.`),
        )
        .exhaustive(),
    (error) =>
      match(error)
        .with(MISSING, () => ok<LinkState, string>({ kind: "missing" }))
        .otherwise((message) => err<LinkState, string>(message)),
  );
}

function readReceipt(path: string): Result<Receipt | undefined, string> {
  return lstat(path).match(
    (st) =>
      match(st.isFile())
        .with(false, () =>
          err<Receipt | undefined, string>(
            `${path} exists but is not a regular navi ownership receipt — refusing to replace it.`,
          ),
        )
        .with(true, () =>
          readText(path)
            .andThen(parseJson)
            .andThen((value) => {
              const parsed = ReceiptSchema.safeParse(value);
              return match(parsed.success)
                .with(true, () => ok<Receipt | undefined, string>(parsed.data))
                .with(false, () =>
                  err<Receipt | undefined, string>(
                    `${path} is not a valid ${RECEIPT_SCHEMA} receipt — refusing to use it.`,
                  ),
                )
                .exhaustive();
            }),
        )
        .exhaustive(),
    (error) =>
      match(error)
        .with(MISSING, () => ok<Receipt | undefined, string>(undefined))
        .otherwise((message) => err<Receipt | undefined, string>(message)),
  );
}

function linkIs(state: LinkState, target: string): boolean {
  return match(state)
    .with({ kind: "link", target }, () => true)
    .otherwise(() => false);
}

function linkIsOwned(state: LinkState, targets: string[]): boolean {
  return match(state)
    .with({ kind: "missing" }, () => true)
    .with({ kind: "link" }, ({ target }) => targets.includes(target))
    .otherwise(() => false);
}

function receiptMatches(layout: InstallLayout, receipt: Receipt): boolean {
  return (
    receipt.install_root === layout.installRoot &&
    receipt.skill_source === layout.source &&
    receipt.launcher_source === layout.launcherSource
  );
}

function missingDirs(layout: InstallLayout): OwnedDir[] {
  return OWNED_DIRS.filter((rel) => !existsSync(join(layout.projectRoot, rel)));
}

function planWithReceipt(
  layout: InstallLayout,
  receipt: Receipt,
  skillState: LinkState,
  launcherState: LinkState,
): Result<InstallPlan, string> {
  return match({
    receiptMatches: receiptMatches(layout, receipt),
    uninstalling: receipt.state === "uninstalling",
    skillOwned: linkIsOwned(skillState, [layout.source]),
    launcherOwned: linkIsOwned(launcherState, [layout.launcherSource]),
    complete:
      receipt.state === "installed" &&
      linkIs(skillState, layout.source) &&
      linkIs(launcherState, layout.launcherSource),
  })
    .with({ receiptMatches: false }, () =>
      err<InstallPlan, string>(
        `${layout.receiptPath} belongs to a different navi installation — use that installation to uninstall first.`,
      ),
    )
    .with({ uninstalling: true }, () =>
      err<InstallPlan, string>(
        `${layout.receiptPath} records an interrupted uninstall — run navi uninstall before installing again.`,
      ),
    )
    .with({ skillOwned: false }, () =>
      err<InstallPlan, string>(`${layout.target} no longer matches its navi ownership receipt.`),
    )
    .with({ launcherOwned: false }, () =>
      err<InstallPlan, string>(
        `${layout.launcherTarget} no longer matches its navi ownership receipt.`,
      ),
    )
    .with({ complete: true }, () =>
      ok<InstallPlan, string>({
        ...layout,
        action: "already-linked",
        createdDirs: receipt.created_dirs,
        receipt,
        skillState,
        launcherState,
        transactionId: randomUUID(),
      }),
    )
    .otherwise(() =>
      ok<InstallPlan, string>({
        ...layout,
        action: "recovered",
        createdDirs: receipt.created_dirs,
        receipt,
        skillState,
        launcherState,
        transactionId: randomUUID(),
      }),
    );
}

function planWithoutReceipt(
  layout: InstallLayout,
  skillState: LinkState,
  launcherState: LinkState,
): Result<InstallPlan, string> {
  const skillOwned = linkIsOwned(skillState, [layout.source]);
  const launcherOwned = linkIsOwned(launcherState, [layout.launcherSource]);
  const action = match(
    linkIs(skillState, layout.source) || linkIs(launcherState, layout.launcherSource),
  )
    .with(true, (): InstallAction => "recovered")
    .otherwise((): InstallAction => "created");
  return match({ skillOwned, launcherOwned })
    .with({ skillOwned: false }, () =>
      err<InstallPlan, string>(
        `${layout.target} is not an exact navi-owned link — refusing to replace it.`,
      ),
    )
    .with({ launcherOwned: false }, () =>
      err<InstallPlan, string>(
        `${layout.launcherTarget} is not an exact navi-owned link — refusing to replace it.`,
      ),
    )
    .otherwise(() =>
      ok<InstallPlan, string>({
        ...layout,
        action,
        // A receipt-less recovery link cannot tell us who created its existing
        // parents. Preserve them. Only directories absent now are ours to prune.
        createdDirs: missingDirs(layout),
        receipt: undefined,
        skillState,
        launcherState,
        transactionId: randomUUID(),
      }),
    );
}

export function planInstall(installRoot: string, to: string): Result<InstallPlan, string> {
  return layoutOf(installRoot, to).andThen((layout) =>
    readReceipt(layout.receiptPath).andThen((receipt) =>
      linkState(layout.target).andThen((skillState) =>
        linkState(layout.launcherTarget).andThen((launcherState) =>
          match(receipt)
            .with(P.nullish, () =>
              planWithoutReceipt(layout, skillState, launcherState),
            )
            .otherwise((owned) =>
              planWithReceipt(layout, owned, skillState, launcherState),
            ),
        ),
      ),
    ),
  );
}

function receiptFor(plan: InstallPlan, state: ReceiptState): Receipt {
  return {
    schema: RECEIPT_SCHEMA,
    state,
    install_root: plan.installRoot,
    skill_source: plan.source,
    launcher_source: plan.launcherSource,
    created_dirs: plan.createdDirs,
    transaction_id: plan.transactionId,
  };
}

function receiptText(receipt: Receipt): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

function sameReceiptOwner(a: Receipt, b: Receipt): boolean {
  return (
    a.install_root === b.install_root &&
    a.skill_source === b.skill_source &&
    a.launcher_source === b.launcher_source &&
    JSON.stringify(a.created_dirs) === JSON.stringify(b.created_dirs) &&
    a.transaction_id === b.transaction_id
  );
}

function prepareReceiptTemp(path: string, receipt: Receipt): Result<string, string> {
  const temp = `${path}.${receipt.transaction_id}.tmp`;
  return lstat(temp).match(
    (st) =>
      match(st.isFile())
        .with(false, () =>
          err<string, string>(
            `${temp} exists but is not navi's regular receipt scratch file.`,
          ),
        )
        .with(true, () =>
          readText(temp).andThen((text) =>
            parseJson(text).match(
              (value) => {
                const parsed = ReceiptSchema.safeParse(value);
                return match(parsed)
                  .with({ success: true }, ({ data }) =>
                    match(sameReceiptOwner(data, receipt))
                      .with(true, () => doUnlink(temp).map(() => temp))
                      .with(false, () =>
                        err<string, string>(
                          `${temp} belongs to a different navi transaction.`,
                        ),
                      )
                      .exhaustive(),
                  )
                  // A valid operation has already rechecked the canonical receipt
                  // or the empty target before reaching this helper. An invalid
                  // regular file at the one fixed scratch path is therefore a
                  // partial atomic write, not a second ownership record.
                  .with({ success: false }, () => doUnlink(temp).map(() => temp))
                  .exhaustive();
              },
              () => doUnlink(temp).map(() => temp),
            ),
          ),
        )
        .exhaustive(),
    (error) =>
      match(error)
        .with(MISSING, () => ok<string, string>(temp))
        .otherwise((message) => err<string, string>(message)),
  );
}

function replaceReceipt(
  path: string,
  expected: Receipt,
  next: Receipt,
): Result<void, string> {
  return prepareReceiptTemp(path, expected).andThen((temp) =>
    doWriteNew(temp, receiptText(next))
      .andThen(() => doRename(temp, path))
      .map(() => undefined)
      .orElse((e) => {
        Result.fromThrowable(() => unlinkSync(temp), () => undefined)();
        return err<void, string>(e);
      }),
  );
}

function createReceipt(path: string, receipt: Receipt): Result<void, string> {
  // The first receipt is written directly and exclusively before `.agents` or
  // either link exists. Later state changes use transaction-addressed scratch
  // files because the valid receipt then supplies ownership proof for recovery.
  return doWriteNew(path, receiptText(receipt)).map(() => undefined);
}

function replaceReceiptIfSame(
  path: string,
  expected: Receipt,
  next: Receipt,
): Result<void, string> {
  return readReceipt(path).andThen((current) =>
    match(current !== undefined && receiptText(current) === receiptText(expected))
      .with(true, () => replaceReceipt(path, expected, next))
      .with(false, () =>
        err<void, string>(`${path} changed after validation — refusing to replace it.`),
      )
      .exhaustive(),
  );
}

function removeReceiptIfSame(path: string, expected: Receipt): Result<void, string> {
  return readReceipt(path).andThen((current) =>
    match(current !== undefined && receiptText(current) === receiptText(expected))
      .with(true, () => doUnlink(path))
      .with(false, () =>
        err<void, string>(`${path} changed after validation — refusing to remove it.`),
      )
      .exhaustive(),
  );
}

function writeReceipt(plan: InstallPlan, state: ReceiptState): Result<void, string> {
  const receipt = receiptFor(plan, state);
  return readReceipt(plan.receiptPath).andThen((current) => {
    const sameAsPrior =
      current !== undefined &&
      plan.receipt !== undefined &&
      receiptText(current) === receiptText(plan.receipt);
    const sameTransaction =
      current !== undefined &&
      current.transaction_id === plan.transactionId &&
      receiptText(current) === receiptText(receiptFor(plan, current.state));
    return match({
      current,
      prior: plan.receipt,
      sameAsPrior,
      sameTransaction,
    })
      .with({ current: P.nullish, prior: P.nullish }, () =>
        createReceipt(plan.receiptPath, receipt),
      )
      .with({ current: P.nonNullable, sameAsPrior: true }, ({ current: expected }) =>
        replaceReceipt(plan.receiptPath, expected, receipt),
      )
      .with({ current: P.nonNullable, sameTransaction: true }, ({ current: expected }) =>
        replaceReceipt(plan.receiptPath, expected, receipt),
      )
      .otherwise(() =>
        err<void, string>(
          `${plan.receiptPath} changed after planning — refusing to replace it.`,
        ),
      );
  });
}

function revalidate(plan: InstallPlan): Result<InstallPlan, string> {
  return planInstall(plan.installRoot, plan.projectRoot).andThen((fresh) =>
    match(
      fresh.target === plan.target &&
        fresh.launcherTarget === plan.launcherTarget &&
        fresh.receiptPath === plan.receiptPath,
    )
      .with(true, () => ok<InstallPlan, string>(fresh))
      .with(false, () =>
        err<InstallPlan, string>("project install paths changed after planning — refusing to write."),
      )
      .exhaustive(),
  );
}

function sameLinkState(a: LinkState, b: LinkState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameOptionalReceipt(a: Receipt | undefined, b: Receipt | undefined): boolean {
  return match([a, b])
    .with([P.nullish, P.nullish], () => true)
    .with([P.nonNullable, P.nonNullable], ([left, right]) =>
      receiptText(left) === receiptText(right),
    )
    .otherwise(() => false);
}

// Both fixed targets and the receipt are checked together before the first
// write. A launcher conflict therefore cannot leave behind the skill link,
// receipt, or parent directories. preflightFixedDirs separately validates the
// directory hierarchy before the exclusive receipt is created.
function preflightTargets(plan: InstallPlan): Result<void, string> {
  return readReceipt(plan.receiptPath).andThen((receipt) =>
    linkState(plan.target).andThen((skill) =>
      linkState(plan.launcherTarget).andThen((launcher) =>
        match(
          sameOptionalReceipt(receipt, plan.receipt) &&
            sameLinkState(skill, plan.skillState) &&
            sameLinkState(launcher, plan.launcherState),
        )
          .with(true, () => ok<void, string>(undefined))
          .with(false, () =>
            err<void, string>(
              "project install targets changed after planning — refusing to write.",
            ),
          )
          .exhaustive(),
      ),
    ),
  );
}

type FixedDirState = "missing" | "directory";

function fixedDirState(plan: InstallPlan, rel: OwnedDir): Result<FixedDirState, string> {
  const path = join(plan.projectRoot, rel);
  const parent = dirname(path);
  return lstat(parent)
    .mapErr((error) =>
      match(error)
        .with(MISSING, () => `cannot use ${path} — its parent directory does not exist.`)
        .otherwise((message) => `cannot inspect ${parent}: ${message}`),
    )
    .andThen((parentStat) =>
      match({
        directory: parentStat.isDirectory(),
        symlink: parentStat.isSymbolicLink(),
        contained: isContainedIn(plan.projectRoot, resolveExisting(parent)),
      })
        .with({ directory: true, symlink: false, contained: true }, () =>
          ok<void, string>(undefined),
        )
        .otherwise(() =>
          err<void, string>(
            `refusing to create ${path} through a non-directory, symlink, or escaped parent.`,
          ),
        ),
    )
    .andThen(() =>
      lstat(path).match(
        (st) =>
          match({
            directory: st.isDirectory(),
            symlink: st.isSymbolicLink(),
            contained: isContainedIn(plan.projectRoot, resolveExisting(path)),
          })
            .with({ directory: true, symlink: false, contained: true }, () =>
              ok<FixedDirState, string>("directory"),
            )
            .otherwise(() =>
              err<FixedDirState, string>(
                `${path} exists but is not a real directory inside the requested project.`,
              ),
            ),
        (error) =>
          match(error)
            .with(MISSING, () => ok<FixedDirState, string>("missing"))
            .otherwise((message) => err<FixedDirState, string>(message)),
      ),
    );
}

function ensureFixedDir(plan: InstallPlan, rel: OwnedDir): Result<void, string> {
  const path = join(plan.projectRoot, rel);
  return fixedDirState(plan, rel).andThen((state) =>
    match(state)
      .with("directory", () => ok<void, string>(undefined))
      .with("missing", () =>
        doMkdir(path).andThen(() =>
          fixedDirState(plan, rel).andThen((after) =>
            match(after)
              .with("directory", () => ok<void, string>(undefined))
              .with("missing", () =>
                err<void, string>(`${path} disappeared immediately after navi created it.`),
              )
              .exhaustive(),
          ),
        ),
      )
      .exhaustive(),
  );
}

function preflightFixedDirs(plan: InstallPlan): Result<void, string> {
  return fixedDirState(plan, ".agents").andThen((agents) =>
    match(agents)
      // When .agents is absent, neither nested path can exist. The receipt is
      // written first, then ensureFixedDir creates this exact fixed hierarchy.
      .with("missing", () => ok<void, string>(undefined))
      .with("directory", () =>
        fixedDirState(plan, DEFAULT_SKILL_DIR)
          .andThen(() => fixedDirState(plan, DEFAULT_BIN_DIR))
          .map(() => undefined),
      )
      .exhaustive(),
  );
}

function transitionLink(path: string, expected: string): Result<void, string> {
  return linkState(path).andThen((state) =>
    match(state)
      .with({ kind: "missing" }, () => doSymlink(expected, path))
      .with({ kind: "link", target: expected }, () => ok<void, string>(undefined))
      .with({ kind: "link", target: P.string }, () =>
        err<void, string>(`${path} changed after planning — refusing to replace it.`),
      )
      .with({ kind: "non-link" }, () =>
        err<void, string>(`${path} changed after planning — refusing to replace it.`),
      )
      .exhaustive(),
  );
}

function removeExactLink(path: string, allowedTargets: string[]): Result<void, string> {
  return linkState(path).andThen((state) =>
    match(state)
      .with({ kind: "missing" }, () => ok<void, string>(undefined))
      .with({ kind: "link" }, ({ target }) =>
        match(allowedTargets.includes(target))
          .with(true, () => doUnlink(path))
          .with(false, () =>
            err<void, string>(`${path} changed ownership — refusing to remove it.`),
          )
          .exhaustive(),
      )
      .with({ kind: "non-link" }, () =>
        err<void, string>(`${path} is not a symlink navi owns — refusing to remove it.`),
      )
      .exhaustive(),
  );
}

function removeOwnedDir(projectRoot: string, path: string): Result<void, string> {
  return lstat(path).match(
    (st) =>
      match({
        directory: st.isDirectory(),
        symlink: st.isSymbolicLink(),
        contained: isContainedIn(projectRoot, resolveExisting(path)),
      })
        .with({ directory: true, symlink: false, contained: true }, () =>
          doRmdir(path).orElse((error) =>
            match(error)
              .with({ code: P.union("ENOENT", "ENOTEMPTY", "EEXIST") }, () =>
                ok<void, string>(undefined),
              )
              .otherwise((cause) => err<void, string>(errStr(cause))),
          ),
        )
        .otherwise(() =>
          err<void, string>(
            `${path} is no longer a real navi-created directory inside the project.`,
          ),
        ),
    (error) =>
      match(error)
        .with(MISSING, () => ok<void, string>(undefined))
        .otherwise((message) => err<void, string>(message)),
  );
}

function pruneRecorded(
  plan: Pick<InstallPlan, "projectRoot" | "createdDirs">,
): Result<void, string> {
  return [...plan.createdDirs]
    .sort((a, b) => b.split("/").length - a.split("/").length)
    .reduce<Result<void, string>>(
      (result, rel) =>
        result.andThen(() =>
          removeOwnedDir(plan.projectRoot, join(plan.projectRoot, rel)),
        ),
      ok<void, string>(undefined),
    );
}

function restoreInitialLink(
  path: string,
  initial: LinkState,
  transactionTargets: string[],
): Result<void, string> {
  return linkState(path).andThen((current) =>
    match(initial)
      .with({ kind: "missing" }, () =>
        match(current)
          .with({ kind: "missing" }, () => ok<void, string>(undefined))
          .with({ kind: "link", target: P.string }, ({ target }) =>
            match(transactionTargets.includes(target))
              .with(true, () => doUnlink(path))
              .with(false, () =>
                err<void, string>(`${path} changed ownership during rollback.`),
              )
              .exhaustive(),
          )
          .with({ kind: "non-link" }, () =>
            err<void, string>(`${path} became a non-link during rollback.`),
          )
          .exhaustive(),
      )
      .with({ kind: "link", target: P.string }, (before) =>
        match(current)
          .with({ kind: "missing" }, () => doSymlink(before.target, path))
          .with({ kind: "link", target: before.target }, () =>
            ok<void, string>(undefined),
          )
          .with({ kind: "link", target: P.string }, ({ target }) =>
            match(transactionTargets.includes(target))
              .with(true, () =>
                doUnlink(path).andThen(() => doSymlink(before.target, path)),
              )
              .with(false, () =>
                err<void, string>(`${path} changed ownership during rollback.`),
              )
              .exhaustive(),
          )
          .with({ kind: "non-link" }, () =>
            err<void, string>(`${path} became a non-link during rollback.`),
          )
          .exhaustive(),
      )
      .with({ kind: "non-link" }, () =>
        err<void, string>(`${path} was not a link before this transaction.`),
      )
      .exhaustive(),
  );
}

function rollbackReceipt(plan: InstallPlan): Result<void, string> {
  const installing = receiptFor(plan, "installing");
  return match(plan.receipt)
    .with(P.nullish, () => removeReceiptIfSame(plan.receiptPath, installing))
    .otherwise((prior) =>
      replaceReceiptIfSame(plan.receiptPath, installing, prior),
    );
}

function rollbackFresh(plan: InstallPlan): Result<void, string> {
  return restoreInitialLink(
    plan.launcherTarget,
    plan.launcherState,
    [plan.launcherSource],
  )
    .andThen(() =>
      restoreInitialLink(
        plan.target,
        plan.skillState,
        [plan.source],
      ),
    )
    .andThen(() => pruneRecorded(plan))
    .andThen(() => rollbackReceipt(plan));
}

function performInstall(plan: InstallPlan): Result<InstallPlan, string> {
  return match(plan.action)
    .with("already-linked", () => ok<InstallPlan, string>(plan))
    .otherwise(() =>
      preflightTargets(plan)
        .andThen(() => preflightFixedDirs(plan))
        .andThen(() =>
          writeReceipt(plan, "installing").andThen(() => {
            const transaction = ensureFixedDir(plan, ".agents")
              .andThen(() => ensureFixedDir(plan, DEFAULT_SKILL_DIR))
              .andThen(() => ensureFixedDir(plan, DEFAULT_BIN_DIR))
              .andThen(() =>
                layoutOf(plan.installRoot, plan.projectRoot).andThen(() =>
                  transitionLink(plan.target, plan.source),
                ),
              )
              .andThen(() =>
                layoutOf(plan.installRoot, plan.projectRoot).andThen(() =>
                  transitionLink(plan.launcherTarget, plan.launcherSource),
                ),
              )
              .andThen(() => writeReceipt(plan, "installed"))
              .map(() => plan);

            return transaction.orElse((e) =>
              rollbackFresh(plan)
                .andThen(() => err<InstallPlan, string>(e))
                .orElse((rollbackError) =>
                  err<InstallPlan, string>(
                    `${e}; rollback was incomplete: ${rollbackError}`,
                  ),
                ),
            );
          }),
        ),
    );
}

export function applyInstall(plan: InstallPlan): Result<InstallPlan, string> {
  // Re-plan at the mutation boundary. A caller can hold a plan while the project
  // changes; the stale plan never grants authority to the later write.
  return revalidate(plan).andThen(performInstall);
}

export function renderInstall(plan: InstallPlan, to: string): string {
  const verb = match(plan.action)
    .with("created", () => "linked")
    .with("recovered", () => "recovered the interrupted install")
    .with("already-linked", () => "already linked")
    .exhaustive();
  const removal = match(to === process.cwd())
    .with(true, () => `${shellQuote(plan.launcherTarget)} uninstall`)
    .with(false, () => `${shellQuote(plan.launcherTarget)} uninstall -w ${shellQuote(plan.projectRoot)}`)
    .exhaustive();
  const workspace = match(to === process.cwd())
    .with(true, () => "")
    .with(false, () => ` -w ${shellQuote(plan.projectRoot)}`)
    .exhaustive();
  const launcher = shellQuote(plan.launcherTarget);
  return [
    `navi: ${verb}`,
    `  ${plan.target}`,
    `  ${plan.launcherTarget}`,
    `  ownership receipt: ${plan.receiptPath}`,
    ``,
    `Run Navi in this project with: ${launcher}${workspace}`,
    `Discover the available flows with: ${launcher} catalog${workspace}`,
    `Learn the Brainstorm contract with: ${launcher} help brainstorm${workspace}`,
    `Remove both links with: ${removal}`,
  ].join("\n");
}

function validateReceiptForUninstall(
  layout: InstallLayout,
  receipt: Receipt,
  skillState: LinkState,
  launcherState: LinkState,
): Result<Receipt, string> {
  const receiptSource = interopSource(receipt.install_root);
  const receiptLauncher = localLauncherSource(receipt.install_root);
  return match({
    receiptCanonical:
      receipt.skill_source === receiptSource &&
      receipt.launcher_source === receiptLauncher,
    skillOwned: linkIsOwned(skillState, [receipt.skill_source]),
    launcherOwned: linkIsOwned(launcherState, [receipt.launcher_source]),
  })
    .with({ receiptCanonical: false }, () =>
      err<Receipt, string>(
        `${layout.receiptPath} does not describe canonical navi sources — refusing to use it.`,
      ),
    )
    .with({ skillOwned: false }, () =>
      err<Receipt, string>(`${layout.target} no longer matches its navi ownership receipt.`),
    )
    .with({ launcherOwned: false }, () =>
      err<Receipt, string>(
        `${layout.launcherTarget} no longer matches its navi ownership receipt.`,
      ),
    )
    .otherwise(() => ok<Receipt, string>(receipt));
}

function writableLinkParent(state: LinkState, path: string): string[] {
  return match(state)
    .with({ kind: "missing" }, (): string[] => [])
    .otherwise(() => [dirname(path)]);
}

function requireWritableIfPresent(path: string): Result<void, string> {
  return lstat(path).match(
    (st) =>
      match({ directory: st.isDirectory(), symlink: st.isSymbolicLink() })
        .with({ directory: true, symlink: false }, () =>
          requireWritableDirectory(path),
        )
        .otherwise(() =>
          err<void, string>(`${path} is not a writable project directory.`),
        ),
    (error) =>
      match(error)
        .with(MISSING, () => ok<void, string>(undefined))
        .otherwise((message) => err<void, string>(message)),
  );
}

function preflightUninstall(
  layout: InstallLayout,
  createdDirs: readonly OwnedDir[],
  skillState: LinkState,
  launcherState: LinkState,
): Result<void, string> {
  const parents = [
    layout.projectRoot,
    ...writableLinkParent(skillState, layout.target),
    ...writableLinkParent(launcherState, layout.launcherTarget),
    ...createdDirs.map((rel) => dirname(join(layout.projectRoot, rel))),
  ].filter((path, index, all) => all.indexOf(path) === index);
  return parents.reduce<Result<void, string>>(
    (result, path) => result.andThen(() => requireWritableIfPresent(path)),
    ok<void, string>(undefined),
  );
}

function rollbackUninstall(
  layout: InstallLayout,
  owned: Receipt,
  uninstalling: Receipt,
  skillState: LinkState,
  launcherState: LinkState,
  skillTargets: string[],
): Result<void, string> {
  return restoreInitialLink(layout.target, skillState, skillTargets)
    .andThen(() =>
      restoreInitialLink(
        layout.launcherTarget,
        launcherState,
        [owned.launcher_source],
      ),
    )
    .andThen(() =>
      replaceReceiptIfSame(layout.receiptPath, uninstalling, owned),
    );
}

function removeOwnedLinks(
  layout: InstallLayout,
  owned: Receipt,
  uninstalling: Receipt,
  skillState: LinkState,
  launcherState: LinkState,
  skillTargets: string[],
): Result<void, string> {
  return removeExactLink(layout.target, skillTargets)
    .andThen(() =>
      removeExactLink(layout.launcherTarget, [owned.launcher_source]),
    )
    .orElse((error) =>
      rollbackUninstall(
        layout,
        owned,
        uninstalling,
        skillState,
        launcherState,
        skillTargets,
      )
        .andThen(() => err<void, string>(error))
        .orElse((rollbackError) =>
          err<void, string>(
            `${error}; uninstall rollback was incomplete: ${rollbackError}`,
          ),
        ),
    );
}

function uninstallWithReceipt(layout: InstallLayout, receipt: Receipt): Result<string, string> {
  return linkState(layout.target).andThen((skillState) =>
    linkState(layout.launcherTarget).andThen((launcherState) =>
      validateReceiptForUninstall(layout, receipt, skillState, launcherState).andThen((owned) => {
        const uninstalling = { ...owned, state: "uninstalling" as const };
        const skillTargets = [owned.skill_source];
        return preflightUninstall(
          layout,
          owned.created_dirs,
          skillState,
          launcherState,
        )
          .andThen(() =>
            replaceReceiptIfSame(layout.receiptPath, owned, uninstalling),
          )
          .andThen(() =>
            removeOwnedLinks(
              layout,
              owned,
              uninstalling,
              skillState,
              launcherState,
              skillTargets,
            ),
          )
          .andThen(() =>
            pruneRecorded({
              projectRoot: layout.projectRoot,
              createdDirs: owned.created_dirs,
            }),
          )
          .andThen(() =>
            removeReceiptIfSame(layout.receiptPath, uninstalling),
          )
          .map(() => `navi: removed ${layout.target} and ${layout.launcherTarget}`);
      }),
    ),
  );
}

function rollbackReceiptlessLinks(
  layout: InstallLayout,
  skillState: LinkState,
  launcherState: LinkState,
): Result<void, string> {
  return restoreInitialLink(
    layout.target,
    skillState,
    [layout.source],
  ).andThen(() =>
    restoreInitialLink(
      layout.launcherTarget,
      launcherState,
      [layout.launcherSource],
    ),
  );
}

function uninstallWithoutReceipt(layout: InstallLayout): Result<string, string> {
  return linkState(layout.target).andThen((skillState) =>
    linkState(layout.launcherTarget).andThen((launcherState) => {
      const skillOwned = linkIsOwned(skillState, [layout.source]);
      const launcherOwned = linkIsOwned(launcherState, [layout.launcherSource]);
      const absent = match([skillState.kind, launcherState.kind])
        .with(["missing", "missing"], () => true)
        .otherwise(() => false);
      return match({ skillOwned, launcherOwned, absent })
        .with({ skillOwned: false }, () =>
          err<string, string>(`${layout.target} is not an exact navi-owned link.`),
        )
        .with({ launcherOwned: false }, () =>
          err<string, string>(`${layout.launcherTarget} is not an exact navi-owned link.`),
        )
        .with({ absent: true }, () =>
          ok<string, string>(`navi: nothing to remove at ${layout.target}`),
        )
        .otherwise(() =>
          preflightUninstall(layout, [], skillState, launcherState)
            .andThen(() =>
              removeExactLink(layout.target, [layout.source]),
            )
            .andThen(() =>
              removeExactLink(layout.launcherTarget, [layout.launcherSource]),
            )
            .orElse((error) =>
              rollbackReceiptlessLinks(layout, skillState, launcherState)
                .andThen(() => err<string, string>(error))
                .orElse((rollbackError) =>
                  err<string, string>(
                    `${error}; uninstall rollback was incomplete: ${rollbackError}`,
                  ),
                ),
            )
            // Receipt-less ancestry is unknowable. Preserve its parent dirs.
            .map(() => `navi: removed owned receipt-less links; parent directories were preserved`),
        );
    }),
  );
}

export function uninstall(installRoot: string, to: string): Result<string, string> {
  return layoutOf(installRoot, to, false).andThen((layout) =>
    readReceipt(layout.receiptPath).andThen((receipt) =>
      match(receipt)
        .with(P.nullish, () => uninstallWithoutReceipt(layout))
        .otherwise((owned) => uninstallWithReceipt(layout, owned)),
    ),
  );
}

export function resolveTarget(to: string | undefined): Result<string, string> {
  return match(to)
    .with(undefined, () => ok<string, string>(process.cwd()))
    .otherwise((d) => {
      const abs = match(isAbsolute(d))
        .with(true, () => d)
        .with(false, () => resolve(process.cwd(), d))
        .exhaustive();
      return match(existsSync(abs))
        .with(true, () => ok<string, string>(abs))
        .with(false, () => err<string, string>(`-w: no such directory "${d}"`))
        .exhaustive();
    });
}
