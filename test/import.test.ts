import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CollectionError } from "@404sl/pitwall-schema";
import { WORKSPACE_FILE } from "../src/autofix.ts";
import { createArgs } from "../src/beads.ts";
import { parseImportArgs, run as runCli } from "../src/cli.ts";
import {
  ACTOR_FIELD,
  IMPORT_LABEL,
  PROMOTION_QUESTION,
  TRUSTED_FIELD,
  UNVERIFIED,
  importCandidates,
  isOutside,
  renderImport,
  workspaceRootOf,
  type ImportResult,
} from "../src/importer.ts";
import { hard } from "../src/errors.ts";
import { GIT_ENV, nullGlobalGitConfig, spawnGit } from "./support/git.js";

nullGlobalGitConfig();

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");
const DISPATCHABLE_SH = join(SKILL, "dispatchable.sh");
const REMOTE = "https://github.com/acme/site.git";
const SLUG = "acme/site";

interface GhIssue {
  number: number;
  title: string;
  author: string | null;
  body: string;
  createdAt?: string;
}

interface TrackerRow {
  id: string;
  status: string;
  external_ref?: string;
  labels?: string[];
  assignee?: string | null;
}

interface Place {
  root: string;
  bin: string;
  ghLog: string;
  bdLog: string;
  created: string;
  env: Record<string, string>;
}

const OPEN_ISSUES: GhIssue[] = [
  {
    number: 8,
    title: "Console shows a stale board after the tracker moves",
    author: "stranger",
    body: "Steps:\n\n1. open the console\n2. close a bead\n\nThe board still shows it. Is that expected?",
    createdAt: "2026-09-05T17:40:00Z",
  },
  {
    number: 7,
    title: "Snapshot reports zero lanes when the slot registry is missing",
    author: "elik-ru",
    body: "",
    createdAt: "2026-09-01T08:15:00Z",
  },
];

function git(dir: string, ...args: string[]): void {
  const ran = spawnGit(args, { cwd: dir });
  assert.equal(ran.status, 0, ran.stderr);
}

function ghStub(bin: string, issues: readonly GhIssue[], options: { listFails?: boolean; viewFails?: number } = {}): void {
  const listing = JSON.stringify(
    issues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      url: `https://github.com/${SLUG}/issues/${String(issue.number)}`,
      author: issue.author === null ? null : { login: issue.author },
      createdAt: issue.createdAt,
    })),
  );
  const views = issues
    .map((issue) => {
      const url = `https://github.com/${SLUG}/issues/${String(issue.number)}`;
      if (options.viewFails === issue.number) {
        return `  "issue view ${url} --json body") echo "HTTP 404: Not Found" >&2; exit 1 ;;`;
      }
      return `  "issue view ${url} --json body") cat <<'JSON'\n${JSON.stringify({ body: issue.body })}\nJSON\n  ;;`;
    })
    .join("\n");
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      'printf \'%s\\n\' "$*" >> "$GH_LOG"',
      'case "$*" in',
      options.listFails === true
        ? '  "issue list "*) echo "gh: not logged in" >&2; exit 4 ;;'
        : `  "issue list "*) cat <<'JSON'\n${listing}\nJSON\n  ;;`,
      views,
      '  *) echo "unknown command: gh $*" >&2; exit 1 ;;',
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "gh"), 0o755);
}

function bdStub(bin: string, rows: readonly TrackerRow[], options: { listFails?: boolean } = {}): void {
  const listing = JSON.stringify(
    rows.map((row) => ({
      id: row.id,
      title: `tracker item ${row.id}`,
      status: row.status,
      issue_type: "task",
      priority: 2,
      labels: row.labels ?? [],
      assignee: row.assignee ?? null,
      ...(row.external_ref === undefined ? {} : { external_ref: row.external_ref }),
    })),
  );
  writeFileSync(
    join(bin, "bd"),
    [
      "#!/bin/sh",
      'printf \'%s\\n\' "$*" >> "$BD_LOG"',
      'case "$*" in',
      '  "statuses --json") echo \'{"built_in_statuses":[{"category":"active","name":"open"},{"category":"done","name":"closed"}],"custom_statuses":[]}\' ;;',
      options.listFails === true
        ? '  "list --all --limit 0 --json") echo "Error: no beads database" >&2; exit 1 ;;'
        : `  "list --all --limit 0 --json") cat <<'JSON'\n${listing}\nJSON\n  ;;`,
      '  "blocked --json") echo "[]" ;;',
      '  *" create "*)',
      '    n=$(cat "$BD_CREATED.count" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$BD_CREATED.count"',
      '    body=""; meta=""',
      '    while [ $# -gt 0 ]; do case "$1" in --body-file) body="$2"; shift ;; --metadata) meta="${2#@}"; shift ;; esac; shift; done',
      '    cp "$body" "$BD_CREATED.$n.description"; cp "$meta" "$BD_CREATED.$n.metadata"',
      '    echo "mw-new$n" ;;',
      '  *) echo "unknown command: bd $*" >&2; exit 1 ;;',
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "bd"), 0o755);
}

function place(
  config: Record<string, unknown>,
  issues: readonly GhIssue[] = OPEN_ISSUES,
  rows: readonly TrackerRow[] = [],
  stubs: { listFails?: boolean; viewFails?: number; trackerFails?: boolean } = {},
): Place {
  const root = mkdtempSync(join(tmpdir(), "pitwall-import-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, ".beads"));
  const site = join(root, "site");
  mkdirSync(site);
  git(site, "init", "--quiet");
  git(site, "remote", "add", "origin", REMOTE);
  writeFileSync(join(root, WORKSPACE_FILE), JSON.stringify({ idPrefix: "mw", repos: { site: { path: "site" } }, ...config }));
  const logs = join(root, "logs");
  mkdirSync(logs);
  ghStub(bin, issues, stubs);
  bdStub(bin, rows, { listFails: stubs.trackerFails });
  const ghLog = join(logs, "gh.log");
  const bdLog = join(logs, "bd.log");
  const created = join(logs, "created");
  writeFileSync(ghLog, "");
  writeFileSync(bdLog, "");
  return {
    root,
    bin,
    ghLog,
    bdLog,
    created,
    env: { ...GIT_ENV, PATH: `${bin}:/usr/bin:/bin`, GH_LOG: ghLog, BD_LOG: bdLog, BD_CREATED: created },
  };
}

function hardErrors(result: ImportResult): CollectionError[] {
  return result.errors.filter(hard);
}

function lines(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").filter((line) => line !== "");
}

function creates(where: Place): string[] {
  return lines(where.bdLog).filter((line) => line.includes(" create "));
}

function description(where: Place, nth: number): string {
  return readFileSync(`${where.created}.${String(nth)}.description`, "utf8");
}

function metadata(where: Place, nth: number): Record<string, unknown> {
  return JSON.parse(readFileSync(`${where.created}.${String(nth)}.metadata`, "utf8")) as Record<string, unknown>;
}

async function imported(where: Place, extra: { actor?: string; cwd?: string } = {}): Promise<ImportResult> {
  return importCandidates({ env: where.env, cwd: extra.cwd ?? where.root, actor: extra.actor, now: new Date("2026-09-20T12:00:00Z") });
}

function dispatchable(root: string, bin: string, rows: readonly TrackerRow[]): string {
  const stub = mkdtempSync(join(tmpdir(), "pitwall-import-dispatch-"));
  writeFileSync(
    join(stub, "bd"),
    `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(
      rows.map((row) => ({
        id: row.id,
        title: `tracker item ${row.id}`,
        description: "",
        priority: 2,
        status: row.status,
        issue_type: "task",
        labels: row.labels ?? [],
        assignee: row.assignee ?? null,
      })),
    )}\nJSON\n`,
  );
  chmodSync(join(stub, "bd"), 0o755);
  const ran = spawnSync("bash", [DISPATCHABLE_SH], {
    encoding: "utf8",
    cwd: root,
    env: {
      ...process.env,
      ...GIT_ENV,
      DEVLOOP_ROOT: root,
      PITWALL_CONFIG: undefined,
      DEVLOOP_CONFIG: undefined,
      LOCK_PREFIX: `pitwallimport${String(process.pid)}`,
      PATH: `${stub}:${bin}:${process.env["PATH"] ?? ""}`,
    },
    timeout: 10_000,
  });
  assert.equal(ran.status, 0, `${ran.stdout}${ran.stderr}`);
  return ran.stdout;
}

function createdRow(where: Place, nth: number, id: string): TrackerRow {
  const create = creates(where)[nth - 1] ?? "";
  const labels = [...create.matchAll(/--labels (\S+)/g)].map((found) => found[1] ?? "");
  const assignee = /--assignee (\S+)/.exec(create)?.[1] ?? null;
  return { id, status: "open", labels, assignee };
}

test("an imported issue is parked for the planning session with its external reference and the reporter's words", async () => {
  const where = place({ [ACTOR_FIELD]: "mw-devloop", [TRUSTED_FIELD]: ["elik-ru"] });
  const result = await imported(where);
  assert.deepEqual(hardErrors(result), []);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(
    result.imported.map((entry) => [entry.candidate.ref, entry.id]),
    [
      [`https://github.com/${SLUG}/issues/7`, "mw-new1"],
      [`https://github.com/${SLUG}/issues/8`, "mw-new2"],
    ],
    "issues are filed oldest first, by number",
  );
  const written = creates(where);
  assert.equal(written.length, 2);
  for (const create of written) {
    assert.match(create, /^--actor mw-devloop create /, "a tracker write without --actor is stamped with whoever ran it");
    assert.match(create, new RegExp(`--assignee ${result.assignee ?? ""}(?: |$)`));
    assert.match(create, new RegExp(`--labels ${IMPORT_LABEL}(?: |$)`));
    assert.match(create, /--type task /);
    assert.doesNotMatch(create, /--assignee \S*devloop/, "an imported issue must never sit in the devloop's queue");
  }
  assert.equal(result.assignee, `${where.root.split("/").at(-1) ?? ""}-planning-session`);
  assert.match(written[1] ?? "", new RegExp(`--external-ref https://github.com/${SLUG}/issues/8 `));
  assert.match(written[1] ?? "", /create --title=Console shows a stale board after the tracker moves --type/);

  const stranger = description(where, 2);
  assert.match(stranger, new RegExp(`^Imported from https://github.com/${SLUG}/issues/8\n`));
  assert.match(stranger, /Reported by @stranger, an outside contributor: not one of this workspace's trustedIssueAuthors\./);
  assert.match(stranger, /Filed 2026-09-05T17:40:00Z\./);
  assert.ok(stranger.includes(UNVERIFIED), "the description does not say that nothing has been verified");
  assert.match(stranger, /\n> Steps:\n>\n> 1\. open the console\n> 2\. close a bead\n>\n> The board still shows it\. Is that expected\?\n/);
  assert.ok(stranger.trimEnd().endsWith(PROMOTION_QUESTION), "the promotion question is not the last line, so the console would show the reporter's question instead");
  assert.match(stranger, new RegExp(`Parked with ${IMPORT_LABEL} and assigned to ${result.assignee ?? ""}\\.`));
  assert.deepEqual(metadata(where, 2), {
    import: {
      source: "github",
      url: `https://github.com/${SLUG}/issues/8`,
      author: "stranger",
      outside: true,
      filedAt: "2026-09-05T17:40:00Z",
      importedAt: "2026-09-20T12:00:00.000Z",
    },
  });

  const ours = description(where, 1);
  assert.match(ours, /Reported by @elik-ru, one of this workspace's trustedIssueAuthors\./);
  assert.match(ours, /> \(the issue was filed with no body\)/);
  assert.equal((metadata(where, 1)["import"] as { outside: boolean }).outside, false);
  assert.match(written[0] ?? "", new RegExp(`--labels ${IMPORT_LABEL} `), "a trusted author's issue is parked all the same");

  assert.ok(!lines(where.ghLog).some((line) => /^issue (close|edit|comment)/.test(line)), "import wrote to GitHub");

  const rendered = renderImport(result);
  assert.equal(rendered.code, 0);
  assert.equal(
    rendered.out,
    [
      `2 issues imported, parked with ${IMPORT_LABEL} for ${result.assignee ?? ""}.`,
      `  ${SLUG}#7 -> mw-new1  @elik-ru`,
      `  ${SLUG}#8 -> mw-new2  @stranger (outside contributor)`,
      "",
    ].join("\n"),
  );
});

test("a checkout whose default branch could not be read is reported on stderr and does not fail the import", async () => {
  const where = place({ [ACTOR_FIELD]: "mw-devloop" });
  const result = await imported(where);
  assert.deepEqual(
    result.errors.map((error) => [error.source, error.scope]),
    [[join(where.root, "site"), "field"]],
  );
  assert.equal(result.imported.length, 2);
  const rendered = renderImport(result);
  assert.equal(rendered.code, 0, "a field-scope error is not a failed import");
  assert.equal(
    rendered.err,
    `pitwall import: ${join(where.root, "site")}: no origin/HEAD, so the default branch could not be read - set defaultBranch in ${WORKSPACE_FILE} or run git remote set-head origin -a\n`,
  );
  assert.match(rendered.out, /^2 issues imported/);

  const nothing = place({ [ACTOR_FIELD]: "mw-devloop" }, OPEN_ISSUES, [
    { id: "mw-1", status: "open", external_ref: `https://github.com/${SLUG}/issues/7`, labels: [IMPORT_LABEL] },
    { id: "mw-2", status: "open", external_ref: `https://github.com/${SLUG}/issues/8`, labels: [IMPORT_LABEL] },
  ]);
  const idle = renderImport(await imported(nothing));
  assert.equal(idle.code, 0);
  assert.equal(idle.out, "0 issues imported: every open issue is already linked to a tracker item.\n");

  const read = place({ [ACTOR_FIELD]: "mw-devloop" });
  git(join(read.root, "site"), "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master");
  const clean = renderImport(await imported(read));
  assert.equal(clean.code, 0);
  assert.equal(clean.err, "");
});

test("an imported issue cannot reach the dispatcher until a person removes the park label", async () => {
  const where = place({});
  const result = await imported(where, { actor: "mw-devloop" });
  assert.equal(result.imported.length, 2);
  const parked = createdRow(where, 2, "mw-new2");
  assert.deepEqual(parked.labels, [IMPORT_LABEL]);

  const gateOff = dispatchable(where.root, where.bin, [parked, { id: "mw-free", status: "open", assignee: null }]);
  assert.match(gateOff, /mw-free/);
  assert.doesNotMatch(gateOff, /mw-new2/, "an imported issue was offered for dispatch with no assignee gate declared");

  const promoted = { ...parked, labels: [] };
  const stillTheirs = dispatchable(where.root, where.bin, [promoted]);
  assert.match(stillTheirs, /mw-new2/, "with the label gone and no actor declared, the label was the only gate and it is lifted");

  writeFileSync(
    join(where.root, WORKSPACE_FILE),
    JSON.stringify({ idPrefix: "mw", repos: { site: { path: "site" } }, [ACTOR_FIELD]: "mw-devloop" }),
  );
  const gateOn = dispatchable(where.root, where.bin, [promoted]);
  assert.doesNotMatch(gateOn, /mw-new2/, "the planning session's queue was offered to the devloop");
  const reassigned = dispatchable(where.root, where.bin, [{ ...promoted, assignee: "mw-devloop" }]);
  assert.match(reassigned, /mw-new2/, "a promoted issue - label removed, assignee moved - is not dispatchable");
});

test("a title that looks like a flag is still a title, because anybody can file one on a public repository", async () => {
  const where = place({ [ACTOR_FIELD]: "mw-devloop" }, [
    { number: 9, title: "--db=/nowhere --help", author: "stranger", body: "", createdAt: "2026-09-06T09:00:00Z" },
  ]);
  const result = await imported(where);
  assert.deepEqual(hardErrors(result), []);
  assert.deepEqual(
    result.imported.map((entry) => [entry.candidate.title, entry.id]),
    [["--db=/nowhere --help", "mw-new1"]],
  );
  assert.equal(creates(where).length, 1);
  assert.match(
    creates(where)[0] ?? "",
    new RegExp(
      `^--actor mw-devloop create --title=--db=/nowhere --help --type task --assignee \\S+-planning-session --labels ${IMPORT_LABEL} --external-ref https://github.com/${SLUG}/issues/9 --body-file \\S+ --metadata @\\S+ --silent$`,
    ),
  );
});

test("running the import again files nothing: an issue is deduplicated on its external reference, not its title", async () => {
  const linked: TrackerRow[] = [
    { id: "mw-1", status: "open", external_ref: `https://github.com/${SLUG}/issues/8`, labels: [IMPORT_LABEL] },
    { id: "mw-2", status: "closed", external_ref: `https://github.com/${SLUG}/issues/7` },
  ];
  const where = place({ [ACTOR_FIELD]: "mw-devloop" }, OPEN_ISSUES, linked);
  const result = await imported(where);
  assert.deepEqual(hardErrors(result), []);
  assert.deepEqual(result.imported, []);
  assert.deepEqual(creates(where), [], "a re-run created a duplicate of an issue already imported");
  assert.equal(renderImport(result).out, "0 issues imported: every open issue is already linked to a tracker item.\n");

  const byTitle = place({ [ACTOR_FIELD]: "mw-devloop" }, OPEN_ISSUES, [
    { id: "mw-3", status: "open", external_ref: `https://github.com/${SLUG}/issues/99` },
  ]);
  const again = await imported(byTitle);
  assert.equal(again.imported.length, 2, "a tracker item with the same words but another reference is not this issue");
});

test("nothing is imported without an actor to write as", async () => {
  const where = place({});
  const result = await imported(where);
  assert.deepEqual(creates(where), []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]?.message ?? "", /declares no "actor"/);
  assert.match(result.errors[0]?.message ?? "", /--actor <name>/);
  assert.equal(result.errors[0]?.source, join(where.root, WORKSPACE_FILE));
  assert.deepEqual(lines(where.ghLog), [], "GitHub was read before the run knew it could write");
  const rendered = renderImport(result);
  assert.equal(rendered.code, 1);
  assert.match(rendered.err, /^pitwall import: .*declares no "actor"/);

  const flagged = await imported(where, { actor: "mw-devloop" });
  assert.equal(flagged.imported.length, 2);
  assert.match(creates(where)[0] ?? "", /^--actor mw-devloop create /);
});

test("a tracker that cannot be read imports nothing, because nothing could be deduplicated against", async () => {
  const where = place({ [ACTOR_FIELD]: "mw-devloop" }, OPEN_ISSUES, [], { trackerFails: true });
  const result = await imported(where);
  assert.deepEqual(creates(where), []);
  assert.ok(result.errors.some((error) => /no beads database/.test(error.message)));
  assert.ok(result.errors.some((error) => /tracker could not be/.test(error.message)));
  assert.equal(renderImport(result).code, 1);
});

test("a listing that fails or an issue whose body cannot be read is reported, and the rest still import", async () => {
  const unlisted = place({ [ACTOR_FIELD]: "mw-devloop" }, OPEN_ISSUES, [], { listFails: true });
  const none = await imported(unlisted);
  assert.deepEqual(creates(unlisted), []);
  assert.equal(hardErrors(none).length, 1);
  assert.match(hardErrors(none)[0]?.message ?? "", /gh: not logged in/);

  const unread = place({ [ACTOR_FIELD]: "mw-devloop" }, OPEN_ISSUES, [], { viewFails: 8 });
  const some = await imported(unread);
  assert.deepEqual(hardErrors(some), []);
  assert.equal(some.imported.length, 1);
  assert.equal(some.failed.length, 1);
  assert.match(some.failed[0]?.reason ?? "", /gh issue view https:\/\/github\.com\/acme\/site\/issues\/8 --json body: HTTP 404/);
  const rendered = renderImport(some);
  assert.equal(rendered.code, 1);
  assert.match(rendered.err, /^pitwall import: acme\/site#8 was not imported: gh issue view/m);
  assert.match(rendered.out, /^1 issue imported/);
});

test("the workspace is the nearest directory above the cwd carrying a workspace file", async () => {
  const where = place({ [ACTOR_FIELD]: "mw-devloop" });
  const deep = join(where.root, "site", "src");
  mkdirSync(deep);
  assert.equal(workspaceRootOf(deep), where.root);
  const result = await imported(where, { cwd: deep });
  assert.equal(result.root, where.root);
  assert.equal(result.imported.length, 2);

  const nowhere = mkdtempSync(join(tmpdir(), "pitwall-import-nowhere-"));
  assert.ok(!existsSync(join(nowhere, WORKSPACE_FILE)));
  const lost = await importCandidates({ env: where.env, cwd: nowhere });
  assert.equal(lost.root, undefined);
  assert.match(lost.errors[0]?.message ?? "", /no \.pitwall\.json or \.autofix\.json in .* or any directory above it/);
});

test("the create arguments carry the reference and the actor only when given", () => {
  const base = {
    title: "t",
    bodyFile: "/b",
    metadataFile: "/m",
    assignee: "mw-planning-session",
    labels: [IMPORT_LABEL],
    issueType: "task",
  };
  assert.deepEqual(createArgs(base).slice(0, 2), ["create", "--title=t"]);
  assert.equal(createArgs({ ...base, title: "--db=/nowhere --help" })[1], "--title=--db=/nowhere --help");
  assert.ok(!createArgs(base).includes("--external-ref"));
  const full = createArgs({ ...base, externalRef: "https://github.com/acme/site/issues/8", actor: "mw-devloop" });
  assert.deepEqual(full.slice(0, 3), ["--actor", "mw-devloop", "create"]);
  assert.deepEqual(full.slice(full.indexOf("--external-ref"), full.indexOf("--external-ref") + 2), [
    "--external-ref",
    "https://github.com/acme/site/issues/8",
  ]);
});

test("an author outside the configured list is an outside contributor, and so is no author at all", () => {
  assert.equal(isOutside("stranger", ["elik-ru"]), true);
  assert.equal(isOutside("Elik-RU", ["elik-ru"]), false);
  assert.equal(isOutside(undefined, ["elik-ru"]), true);
  assert.equal(isOutside("elik-ru", []), true);
});

test("pitwall import takes --actor and nothing else", () => {
  assert.deepEqual(parseImportArgs([]), {});
  assert.deepEqual(parseImportArgs(["--actor", "mw-devloop"]), { actor: "mw-devloop" });
  assert.deepEqual(parseImportArgs(["--actor"]), { error: "--actor needs a name" });
  assert.deepEqual(parseImportArgs(["--peek"]), { error: "unknown argument --peek" });
  assert.deepEqual(runCli(["import", "--actor", "mw-devloop"]), { code: 0, out: "", import: { actor: "mw-devloop" } });
  const refused = runCli(["import", "--now"]);
  assert.equal(refused.code, 2);
  assert.match(refused.out, /^pitwall import: unknown argument --now/);
  assert.match(runCli(["--help"]).out, /pitwall import/);
});
