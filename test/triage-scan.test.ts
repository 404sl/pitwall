import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GIT_ENV } from "./support/git.js";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");

interface PullRequests {
  openLabelledNumbers?: readonly number[];
  openLabelledRefs?: readonly string[];
  openUnlabelledRefs?: readonly string[];
  mergedRefs?: readonly string[];
}

interface OpenIssue {
  id: string;
  labels?: readonly string[];
  notes?: string;
}

interface Shape {
  idPrefix?: string;
  inProgress: readonly string[];
  liveTranscript: string;
  notes?: Readonly<Record<string, string>>;
  open?: readonly OpenIssue[];
  pullRequests?: Readonly<Record<string, PullRequests>>;
  repos?: Readonly<Record<string, { path: string; slug: string }>>;
}

interface Space {
  root: string;
  skill: string;
  pfx: string;
}

let serial = 0;

function emit(values: readonly (string | number)[] | undefined): string {
  if (values === undefined || values.length === 0) return "true";
  return `printf '%s\\n' ${values.map((v) => JSON.stringify(String(v))).join(" ")}`;
}

function workspace(shape: Shape): Space {
  const root = mkdtempSync(join(tmpdir(), "pitwall-triage-scan-"));
  const skill = join(root, "skill");
  const bin = join(root, "bin");
  const pfx = `pitwalltriagescan${process.pid}x${serial++}`;
  mkdirSync(skill);
  mkdirSync(bin);
  mkdirSync(join(root, ".beads"));
  writeFileSync(join(skill, "triage-scan.sh"), readFileSync(join(SKILL, "triage-scan.sh"), "utf8"));
  const idPrefix = shape.idPrefix === undefined ? "exit 1" : `echo ${JSON.stringify(shape.idPrefix)}`;
  writeFileSync(
    join(skill, "config.sh"),
    [
      "#!/bin/bash",
      'case "${1:-}" in',
      `  root) echo ${JSON.stringify(root)} ;;`,
      `  idPrefix) ${idPrefix} ;;`,
      `  lockPrefix) echo ${pfx} ;;`,
      `  "") printf '%s\\n' '${JSON.stringify({ root, repos: {} })}' ;;`,
      `  --land) printf '%s\\n' '${JSON.stringify({ root, repos: shape.repos ?? {} })}' ;;`,
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  const running = shape.inProgress.map((id) => ({
    id,
    title: `work on ${id}`,
    description: "",
    notes: shape.notes?.[id] ?? "",
    priority: 2,
    status: "in_progress",
    issue_type: "task",
    labels: [],
  }));
  const open = (shape.open ?? []).map((issue) => ({
    id: issue.id,
    title: `work on ${issue.id}`,
    description: "",
    notes: issue.notes ?? "",
    priority: 2,
    status: "open",
    issue_type: "task",
    labels: [...(issue.labels ?? [])],
  }));
  writeFileSync(
    join(bin, "bd"),
    [
      "#!/bin/bash",
      'case " $* " in',
      '  *" closed "*) echo "[]" ;;',
      `  *" open "*) cat <<'JSON'`,
      JSON.stringify(open),
      "JSON",
      "  ;;",
      `  *" in_progress "*) cat <<'JSON'`,
      JSON.stringify(running),
      "JSON",
      "  ;;",
      ...open.flatMap((issue) => [`  *" show ${issue.id} "*) cat <<'JSON'`, JSON.stringify(issue), "JSON", "  ;;"]),
      `  *) cat <<'JSON'`,
      JSON.stringify([...running, ...open]),
      "JSON",
      "  ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "bd"), 0o755);
  if (shape.pullRequests) {
    const arms: string[] = [];
    for (const [dir, prs] of Object.entries(shape.pullRequests)) {
      mkdirSync(join(root, dir), { recursive: true });
      arms.push(`  ${JSON.stringify(`${dir}:number`)}) ${emit(prs.openLabelledNumbers)} ;;`);
      arms.push(`  ${JSON.stringify(`${dir}:merged`)}) ${emit(prs.mergedRefs)} ;;`);
      arms.push(`  ${JSON.stringify(`${dir}:open`)}) ${emit(prs.openLabelledRefs)} ;;`);
      const slug = Object.values(shape.repos ?? {}).find((r) => r.path === dir)?.slug;
      if (slug !== undefined && prs.openUnlabelledRefs !== undefined) {
        const listed = prs.openUnlabelledRefs.map((headRefName, n) => ({ number: 900 + n, headRefName, labels: [] }));
        arms.push(`  ${JSON.stringify(`${slug}:orphans`)}) cat <<'JSON'`, JSON.stringify(listed), "JSON", "  ;;");
      }
    }
    writeFileSync(
      join(bin, "gh"),
      [
        "#!/bin/bash",
        'slug=""; prev=""',
        'for a in "$@"; do [ "$prev" = "--repo" ] && slug="$a"; prev="$a"; done',
        'case " $* " in',
        '  *" --json number,headRefName,labels "*) kind=orphans ;;',
        '  *" merged "*) kind=merged ;;',
        '  *" number "*) kind=number ;;',
        "  *) kind=open ;;",
        "esac",
        'key="${PWD##*/}:$kind"',
        '[ "$kind" = orphans ] && key="$slug:$kind"',
        'case "$key" in',
        ...arms,
        "  *) true ;;",
        "esac",
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "gh"), 0o755);
  }
  const wf = join(root, ".claude", "projects", root.replace(/\//g, "-"), "run-1");
  mkdirSync(wf, { recursive: true });
  writeFileSync(join(wf, "transcript.jsonl"), `${shape.liveTranscript}\n`);
  return { root, skill, pfx };
}

function scan(space: Space): { stdout: string; stderr: string; status: number | null } {
  const ran = spawnSync("bash", [join(space.skill, "triage-scan.sh")], {
    encoding: "utf8",
    cwd: space.root,
    timeout: 60_000,
    env: {
      ...process.env,
      ...GIT_ENV,
      HOME: space.root,
      DEVLOOP_ROOT: space.root,
      TRIAGE_MARK: undefined,
      PATH: `${join(space.root, "bin")}:${process.env["PATH"] ?? ""}`,
    },
  });
  for (const f of ["all", "open", "run", "closed"]) rmSync(`/tmp/${space.pfx}-ts-${f}.json`, { force: true });
  return { stdout: `${ran.stdout ?? ""}`, stderr: `${ran.stderr ?? ""}`, status: ran.status };
}

function staleWorktree(space: Space, id: string): string {
  const wt = join("/private/tmp", `${space.pfx}-worktrees`, id);
  mkdirSync(wt, { recursive: true });
  const old = new Date(Date.now() - 45 * 60_000);
  utimesSync(wt, old, old);
  return join("/private/tmp", `${space.pfx}-worktrees`);
}

const TRANSCRIPT = JSON.stringify({ role: "user", text: "Issue: pitwall-abc - fix the thing. Branch: devloop/pitwall-abc" });

test("an in_progress issue a live run names under the workspace's own id prefix is not a stale claim", () => {
  const space = workspace({ idPrefix: "pitwall", inProgress: ["pitwall-abc", "pitwall-dead"], liveTranscript: TRANSCRIPT });
  const out = scan(space);
  assert.equal(out.status, 1, out.stderr);
  assert.match(out.stdout, /^\[E stale claim\] pitwall-dead P2/m);
  assert.doesNotMatch(out.stdout, /pitwall-abc/);
});

test(
  "an in_progress issue whose worktree is untouched for 30+ min but which a live run names is not reported under G",
  { skip: !existsSync("/private/tmp") },
  () => {
    const space = workspace({ idPrefix: "pitwall", inProgress: ["pitwall-abc", "pitwall-dead"], liveTranscript: TRANSCRIPT });
    const worktrees = staleWorktree(space, "pitwall-abc");
    staleWorktree(space, "pitwall-dead");
    try {
      const out = scan(space);
      assert.equal(out.status, 1, out.stderr);
      assert.match(out.stdout, /^\[G lane died holding its worktree\] pitwall-dead P2/m);
      assert.doesNotMatch(out.stdout, /pitwall-abc/);
    } finally {
      rmSync(worktrees, { recursive: true, force: true });
    }
  },
);

test("triage-scan.sh refuses to scan when idPrefix cannot be resolved", () => {
  const space = workspace({ inProgress: ["pitwall-abc"], liveTranscript: TRANSCRIPT });
  const out = scan(space);
  assert.equal(out.status, 3);
  assert.match(out.stderr, /idPrefix/);
  assert.equal(out.stdout, "");
});

const REPOS = {
  site: { path: "cli", slug: "404sl/pitwall" },
  integration: { path: "schema", slug: "404sl/pitwall-schema" },
  docs: { path: "site", slug: "404sl/pitwall-site" },
};

test("an in_progress issue whose notes quote its own repository's open labelled pull request is not a stale claim", () => {
  const space = workspace({
    idPrefix: "pitwall",
    inProgress: ["pitwall-word", "pitwall-url", "pitwall-dead"],
    liveTranscript: TRANSCRIPT,
    notes: {
      "pitwall-word": "handed off as cli #77, waiting for the lander",
      "pitwall-url": "green at https://github.com/404sl/pitwall/pull/78 awaiting the lander",
    },
    pullRequests: {
      cli: { openLabelledNumbers: [77, 78], openLabelledRefs: ["product-hunt-badge"] },
      schema: {},
    },
    repos: REPOS,
  });
  const out = scan(space);
  assert.equal(out.status, 1, out.stderr);
  assert.match(out.stdout, /^\[E stale claim\] pitwall-dead P2/m);
  assert.doesNotMatch(out.stdout, /pitwall-word/);
  assert.doesNotMatch(out.stdout, /pitwall-url/);
});

test("a queued pull request number open in a different repository's checkout is not a hand-off", () => {
  const space = workspace({
    idPrefix: "pitwall",
    inProgress: ["pitwall-queued"],
    liveTranscript: TRANSCRIPT,
    notes: { "pitwall-queued": "handed off as cli #77, waiting for the lander" },
    pullRequests: {
      cli: {},
      site: { openLabelledNumbers: [77], openLabelledRefs: ["product-hunt-badge"] },
    },
    repos: REPOS,
  });
  const out = scan(space);
  assert.equal(out.status, 1, out.stderr);
  assert.match(out.stdout, /^\[E stale claim\] pitwall-queued P2/m);
});

test("a repository whose configured checkout is missing is skipped rather than failing the scan", () => {
  const space = workspace({
    idPrefix: "pitwall",
    inProgress: ["pitwall-word"],
    liveTranscript: TRANSCRIPT,
    notes: { "pitwall-word": "handed off as cli #77, waiting for the lander" },
    pullRequests: { cli: { openLabelledNumbers: [77] } },
    repos: { ...REPOS, extension: { path: "not-a-checkout", slug: "404sl/pitwall-absent" } },
  });
  const out = scan(space);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^CLEAN/);
  assert.match(out.stderr, /^warning: extension checkout missing at .*\/not-a-checkout - handed-off check did not read it$/m);
});

test("a directory named after a repo key that is nobody's configured path is never consulted", () => {
  const space = workspace({
    idPrefix: "pitwall",
    inProgress: ["pitwall-dead"],
    liveTranscript: TRANSCRIPT,
    pullRequests: { integration: { openLabelledRefs: ["devloop/pitwall-dead"] } },
    repos: REPOS,
  });
  const out = scan(space);
  assert.equal(out.status, 1, out.stderr);
  assert.match(out.stdout, /^\[E stale claim\] pitwall-dead P2/m);
  assert.match(out.stderr, /^warning: integration checkout missing at .*\/schema - handed-off check did not read it$/m);
});

test("a config that names no repositories says the handed-off check read nothing rather than staying silent", () => {
  const space = workspace({ idPrefix: "pitwall", inProgress: ["pitwall-dead"], liveTranscript: TRANSCRIPT });
  const out = scan(space);
  assert.equal(out.status, 1, out.stderr);
  assert.match(out.stdout, /^\[E stale claim\] pitwall-dead P2/m);
  assert.match(out.stderr, /^warning: the workspace config names no repositories - handed-off check read no checkout/m);
});

test("a queued pull request number appearing only inside a longer number is not a hand-off", () => {
  const space = workspace({
    idPrefix: "pitwall",
    inProgress: ["pitwall-queued"],
    liveTranscript: TRANSCRIPT,
    notes: { "pitwall-queued": "see cli #1627 for context" },
    pullRequests: { cli: { openLabelledNumbers: [16], openLabelledRefs: ["product-hunt-badge"] } },
    repos: REPOS,
  });
  const out = scan(space);
  assert.equal(out.status, 1, out.stderr);
  assert.match(out.stdout, /^\[E stale claim\] pitwall-queued P2/m);
});

test("a queued pull request number a note attributes to another repository is not a hand-off", () => {
  const space = workspace({
    idPrefix: "pitwall",
    inProgress: ["pitwall-queued"],
    liveTranscript: TRANSCRIPT,
    notes: { "pitwall-queued": "blocked on schema #77, nothing of ours is open" },
    pullRequests: {
      cli: { openLabelledNumbers: [77], openLabelledRefs: ["product-hunt-badge"] },
      schema: {},
    },
    repos: REPOS,
  });
  const out = scan(space);
  assert.equal(out.status, 1, out.stderr);
  assert.match(out.stdout, /^\[E stale claim\] pitwall-queued P2/m);
});

test("an in_progress issue whose merged pull request sits on an autofix/ branch is not a stale claim", () => {
  const space = workspace({
    idPrefix: "pitwall",
    inProgress: ["pitwall-old", "pitwall-dead"],
    liveTranscript: TRANSCRIPT,
    pullRequests: { cli: { mergedRefs: ["autofix/pitwall-old"] } },
    repos: REPOS,
  });
  const out = scan(space);
  assert.equal(out.status, 1, out.stderr);
  assert.match(out.stdout, /^\[E stale claim\] pitwall-dead P2/m);
  assert.doesNotMatch(out.stdout, /pitwall-old/);
});

test("no branch prefix is matched or stripped by a hardcoded literal", () => {
  const src = readFileSync(join(SKILL, "triage-scan.sh"), "utf8");
  assert.doesNotMatch(src, /startswith\("devloop\/"\)/);
  assert.doesNotMatch(src, /len\("devloop\/"\)/);
});

test("no id prefix literal remains in _live_ids", () => {
  const src = readFileSync(join(SKILL, "triage-scan.sh"), "utf8");
  const start = src.indexOf("def _live_ids():");
  const end = src.indexOf("\n\n#", start);
  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(src.slice(start, end), /sr-/);
});

const CALL_HANDBACK = "handed back for a person: which of three lock-release shapes to take";

test("an open issue parked with needs-call is a park, not an unlabelled hand-back", () => {
  const space = workspace({
    idPrefix: "pitwall",
    inProgress: [],
    liveTranscript: TRANSCRIPT,
    open: [
      { id: "pitwall-call", labels: ["needs-call"], notes: CALL_HANDBACK },
      { id: "pitwall-bare", notes: CALL_HANDBACK },
    ],
  });
  const out = scan(space);
  assert.equal(out.status, 1, out.stderr);
  assert.match(out.stdout, /^\[A unlabelled hand-back\] pitwall-bare P2/m);
  assert.doesNotMatch(
    out.stdout,
    /pitwall-call/,
    "a needs-call park was raised as unlabelled, which sends it to triage to be relabelled needs-decision",
  );
});

test("a needs-call park whose call was recorded afterwards is answered but parked", () => {
  const space = workspace({
    idPrefix: "pitwall",
    inProgress: [],
    liveTranscript: TRANSCRIPT,
    open: [{ id: "pitwall-call", labels: ["needs-call"], notes: `${CALL_HANDBACK}\nDECIDED: take the second shape` }],
  });
  const out = scan(space);
  assert.equal(out.status, 1, out.stderr);
  assert.match(out.stdout, /^\[B answered but parked\] pitwall-call P2/m);
});

test("an open pull request whose issue is parked with needs-call is held on purpose, not stranded", () => {
  const space = workspace({
    idPrefix: "pitwall",
    inProgress: [],
    liveTranscript: TRANSCRIPT,
    open: [{ id: "pitwall-call", labels: ["needs-call"] }, { id: "pitwall-bare" }],
    pullRequests: { cli: { openUnlabelledRefs: ["devloop/pitwall-call", "devloop/pitwall-bare"] } },
    repos: REPOS,
  });
  const out = scan(space);
  assert.match(out.stdout, /^STUCK: an open PR the lander will never see/m);
  assert.match(out.stdout, /pitwall #901 \(devloop\/pitwall-bare\) - open, unlabelled, and no lane holds it/);
  assert.doesNotMatch(
    out.stdout,
    /devloop\/pitwall-call/,
    "a needs-call park with its pull request still open would be reported as stranded on every tick",
  );
});

test("every park set in the skill that names needs-decision names needs-call beside it", () => {
  const missing: string[] = [];
  for (const file of readdirSync(SKILL).filter((f) => f.endsWith(".sh"))) {
    const src = readFileSync(join(SKILL, file), "utf8");
    for (const line of src.split("\n")) {
      if (!/^\s*PARK(ED)?\s*=\s*\{/.test(line)) continue;
      if (line.includes("needs-decision") && !line.includes("needs-call")) missing.push(`${file}: ${line.trim()}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    "a set that parks on needs-decision but not needs-call treats a call nobody has made as ready work",
  );
});
