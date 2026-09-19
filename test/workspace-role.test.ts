import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GIT_ENV, spawnGit } from "./support/git.js";
import { runScript, type Call } from "./support/workflow.js";

const SKILL = join(import.meta.dirname, "..", "plugins", "devloop", "skills", "devloop");
const CONFIG_SH = join(SKILL, "config.sh");

const CHECKOUTS = {
  site: { path: "cli", slug: "acme/thing", test: "npm test", role: "node" },
  integration: { path: "schema", slug: "acme/thing-schema", test: "npm test", role: "node" },
};

const TASK_ARGS = {
  id: "zz-aaa1",
  slot: 3,
  root: "/root",
  skillDir: "/skill",
  lockPrefix: "pw",
  repos: { ...CHECKOUTS, workspace: { path: ".", role: "workspace" } },
};

const TRIAGE_WORKSPACE = {
  eligible: true,
  repo: "workspace",
  title: "Split the tracker hygiene ticket and record the decision",
  priority: 2,
  ui: false,
  reason: "",
  ticket: "Repo: none - this is tracker hygiene plus one paragraph of documentation",
};

const CLOSED = "○ zz-aaa1 · Split the tracker hygiene ticket   [● P2 · CLOSED]\nOwner: pw-devloop";
const RELEASED = { lane: "released", slot: "released" };

function labels(calls: Call[]): string[] {
  return calls.map((c) => c.label);
}

function stepNamed(calls: Call[], prefix: string): Call {
  const found = calls.find((c) => c.label.startsWith(prefix));
  assert.ok(found, `no ${prefix} step ran. Steps seen: ${labels(calls).join(", ")}`);
  return found;
}

test("triage is told the workspace key is the root itself and what routes there", async () => {
  const { calls, done } = runScript("task.js", TASK_ARGS, (call, n) => {
    if (n === 1) return TRIAGE_WORKSPACE;
    if (call.label.startsWith("apply:")) {
      return { status: "applied", summary: "split into two children", changed: [], verification: CLOSED };
    }
    return RELEASED;
  });
  await done;

  const step = stepNamed(calls, "triage:");
  const triage = step.prompt;
  assert.match(triage, /workspace {2}-> {2}\/root {2}the workspace root itself/, "the table does not show the key as the root");
  assert.doesNotMatch(triage, /workspace {2}-> {2}\/root.*lands on origin/, "the root is described as landing on a branch");
  assert.match(triage, /WORK THAT LIVES IN NO CHECKOUT ROUTES TO 'workspace'/, "triage is not told what the key is for");
  assert.match(triage, /'Repo:' line\n\s+says none/, "a Repo: none ticket is not named as what routes there");
  assert.match(triage, /pipeline's own scripts are ordinary\n\s+files in the repository that holds them/);
  assert.equal(step.schema?.properties?.repo?.enum?.includes("workspace"), true, "the schema does not admit the key");
});

test("a ticket routed to the workspace key is applied in the root, with no worktree, branch, pull request or review", async () => {
  const { calls, logs, done } = runScript("task.js", TASK_ARGS, (call, n) => {
    if (n === 1) return TRIAGE_WORKSPACE;
    if (call.label.startsWith("apply:")) {
      return {
        status: "applied",
        summary: "split into two children and recorded the decision",
        changed: ["/root/CLAUDE.md"],
        verification: CLOSED,
      };
    }
    return RELEASED;
  });
  const result = await done;

  const seen = labels(calls);
  assert.deepEqual(
    seen.filter((l) => /^(fix|review|handoff|design):/.test(l)),
    [],
    `a checkout step ran for the workspace key: ${seen.join(", ")}`,
  );
  const brief = stepNamed(calls, "apply:zz-aaa1").prompt;
  for (const forbidden of ["git worktree add", "gh pr create", "origin/master", "--pre-push", "lane-verified", "`"]) {
    assert.ok(!brief.includes(forbidden), `the workspace brief still hands out '${forbidden}'`);
  }
  assert.deepEqual(
    brief.split("\n").filter((line) => line.includes("2>&1") && !/never/i.test(line)),
    [],
    "the workspace brief hands out a merged stderr",
  );
  assert.match(brief, /Repo: workspace - the workspace root itself, \/root\./);
  assert.match(brief, /run no git command that writes there/);
  assert.match(brief, /site {2}-> {2}\/root\/cli/, "the brief does not name the checkouts it must not edit");
  assert.match(brief, /integration {2}-> {2}\/root\/schema/);
  assert.doesNotMatch(brief, /workspace {2}-> {2}\/root/, "the root is listed among the checkouts to keep out of");
  assert.match(brief, /bd close zz-aaa1 --reason/, "the brief does not tell the run to close the issue itself");
  assert.match(brief, /bash \/skill\/bd-note\.sh/, "notes are not routed through bd-note.sh");
  assert.match(brief, /Repo: none - this is tracker hygiene/, "the ticket text was not carried into the brief");

  assert.equal(result["outcome"], "closed");
  assert.deepEqual(result["changed"], ["/root/CLAUDE.md"]);
  assert.ok(logs.some((l) => /^CLOSED zz-aaa1 P2 workspace/.test(l)), `no CLOSED line was printed:\n${logs.join("\n")}`);
  assert.ok(logs.some((l) => l.includes("edited in place, uncommitted: /root/CLAUDE.md")), "the edited files are not on the result line");
  assert.ok(seen.some((l) => l.startsWith("release:")), "the lane was not given back");
});

test("an applied result whose tracker read-back does not say closed is blocked, not closed", async () => {
  const { logs, done } = runScript("task.js", TASK_ARGS, (call, n) => {
    if (n === 1) return TRIAGE_WORKSPACE;
    if (call.label.startsWith("apply:")) {
      return { status: "applied", summary: "done", changed: [], verification: "○ zz-aaa1 · title   [● P2 · IN_PROGRESS]" };
    }
    return RELEASED;
  });
  const result = await done;

  assert.equal(result["outcome"], "blocked");
  assert.match(String(result["summary"]), /applied but not closed/);
  assert.ok(logs.some((l) => l.startsWith("CLOSE FAILED zz-aaa1")), `no warning was printed:\n${logs.join("\n")}`);
});

test("a workspace step that reports a push is refused rather than reviewed", async () => {
  const { calls, done } = runScript("task.js", TASK_ARGS, (call, n) => {
    if (n === 1) return TRIAGE_WORKSPACE;
    if (call.label.startsWith("apply:")) return { status: "pushed", summary: "opened a pull request", prNumber: 9 };
    return RELEASED;
  });
  const result = await done;

  assert.equal(result["outcome"], "blocked");
  assert.match(String(result["summary"]), /'pushed', which is not an outcome for the workspace key/);
  assert.deepEqual(labels(calls).filter((l) => /^(review|handoff):/.test(l)), []);
});

test("a workspace step that needs a person hands back like any other", async () => {
  const { done } = runScript("task.js", TASK_ARGS, (call, n) => {
    if (n === 1) return TRIAGE_WORKSPACE;
    if (call.label.startsWith("apply:")) {
      return { status: "needs_feedback", summary: "", question: "the paragraph belongs in cli/README.md, which is a checkout" };
    }
    return RELEASED;
  });
  const result = await done;

  assert.equal(result["outcome"], "needs_feedback");
  assert.match(String(result["question"]), /cli\/README\.md/);
});

test("a workspace whose config has no such key tells triage the route does not exist", async () => {
  const { calls, done } = runScript("task.js", { ...TASK_ARGS, repos: CHECKOUTS }, (call, n) => {
    if (n === 1) return { ...TRIAGE_WORKSPACE, eligible: false, repo: "unknown", reason: "no checkout holds this" };
    if (call.label.startsWith("handover:")) return { verification: "zz-aaa1 open needs-decision" };
    return RELEASED;
  });
  await done;

  const triage = stepNamed(calls, "triage:").prompt;
  assert.match(triage, /configures no key with\n\s+role 'workspace'/, "triage is not told the key is missing");
  assert.doesNotMatch(triage, /ROUTES TO '/);
});

test("the workspace key is taken from the role, not the key name", async () => {
  const args = {
    ...TASK_ARGS,
    repos: { ...CHECKOUTS, root: { path: ".", role: "workspace" }, workspace: { path: "ws", slug: "acme/ws", test: "make test" } },
  };
  const { calls, done } = runScript("task.js", args, (call, n) => {
    if (n === 1) return { ...TRIAGE_WORKSPACE, repo: "root" };
    if (call.label.startsWith("apply:")) return { status: "applied", summary: "done", changed: [], verification: CLOSED };
    return RELEASED;
  });
  const result = await done;

  const triage = stepNamed(calls, "triage:").prompt;
  assert.match(triage, /root {2}-> {2}\/root {2}the workspace root itself/);
  assert.match(triage, /workspace {2}-> {2}\/root\/ws {2}\(acme\/ws\) {2}lands on origin\/master/);
  assert.match(triage, /ROUTES TO 'root'/);
  assert.equal(result["outcome"], "closed");
});

interface Box {
  root: string;
  bin: string;
  config: string;
}

function git(cwd: string, ...args: string[]): string {
  const ran = spawnGit(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd });
  assert.equal(ran.status, 0, `git ${args.join(" ")} in ${cwd}:\n${ran.stderr}`);
  return ran.stdout.trim();
}

function workspace(repos: Record<string, unknown>): Box {
  const root = mkdtempSync(join(tmpdir(), "pitwall-workspace-role-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, ".beads"));
  const origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "master", origin);
  const checkout = join(root, "repo");
  git(root, "clone", "-q", origin, checkout);
  writeFileSync(join(checkout, "a.txt"), "one\n");
  git(checkout, "add", "a.txt");
  git(checkout, "commit", "-q", "-m", "first");
  git(checkout, "push", "-q", "origin", "master");
  const config = join(root, ".pitwall.json");
  writeFileSync(config, JSON.stringify({ root, idPrefix: "zz", lockPrefix: `pwws${process.pid}`, lanes: 2, repos }));
  writeFileSync(join(bin, "bd"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "bd"), 0o755);
  writeFileSync(join(bin, "gh"), '#!/bin/bash\ncase "$1 $2" in\n  "repo view") echo \'{"defaultBranchRef":{"name":"master"}}\' ;;\n  *) exit 0 ;;\nesac\n');
  chmodSync(join(bin, "gh"), 0o755);
  return { root, bin, config };
}

function config(box: Box, ...argv: string[]) {
  const ran = spawnSync("bash", [CONFIG_SH, ...argv], {
    encoding: "utf8",
    cwd: box.root,
    env: { ...process.env, ...GIT_ENV, PATH: `${box.bin}:${process.env["PATH"] ?? ""}`, PITWALL_CONFIG: box.config, BEADS_DIR: "" },
  });
  return { status: ran.status ?? -1, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
}

const SITE = { path: "repo", test: "npm test", slug: "acme/site" };

test("config.sh --check accepts the workspace key without a test command, a slug or a remote", () => {
  const box = workspace({ site: SITE, workspace: { path: ".", role: "workspace" } });
  try {
    const ran = config(box, "--check");
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
    assert.doesNotMatch(ran.stdout, /repo workspace/, ran.stdout);
    assert.match(ran.stdout, /config OK: 2 repos/);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("config.sh --check refuses a workspace entry that carries a slug or points elsewhere", () => {
  const box = workspace({
    site: SITE,
    workspace: { path: ".", role: "workspace", slug: "acme/root" },
    elsewhere: { path: "repo", role: "workspace" },
  });
  try {
    const ran = config(box, "--check");
    assert.notEqual(ran.status, 0);
    assert.match(ran.stdout, /repo workspace: role workspace carries a slug/);
    assert.match(ran.stdout, /repo elsewhere: role workspace but path resolves to .*\/repo, not the workspace root/);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("a dispatch does not fetch the workspace root, so a root with no remote is not reported as uncomparable", () => {
  const box = workspace({ site: SITE, workspace: { path: ".", role: "workspace" } });
  try {
    const ran = config(box, "--args", "zz-aaa1");
    assert.equal(ran.status, 0, ran.stderr);
    assert.doesNotMatch(ran.stderr, /could not be compared|workspace/, ran.stderr);
    const args = JSON.parse(ran.stdout) as { repos: Record<string, { role?: string; path?: string }> };
    assert.equal(args.repos["workspace"]?.role, "workspace", "the role did not reach the dispatch");
    assert.equal(args.repos["workspace"]?.path, ".");
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("a rework or a train aimed at the workspace key is refused, because it has no pull requests", () => {
  const box = workspace({ site: SITE, workspace: { path: ".", role: "workspace" } });
  try {
    const rework = config(box, "--rework", "zz-aaa1", "7", "workspace");
    assert.equal(rework.status, 2, rework.stdout + rework.stderr);
    assert.match(rework.stderr, /workspace is the workspace root, which has no pull requests to rework/);
    const train = config(box, "--train", "workspace");
    assert.equal(train.status, 2, train.stdout + train.stderr);
    assert.match(train.stderr, /workspace is the workspace root, which has no pull requests to land/);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("a train's accounting of what is left in other repositories leaves the workspace key out", async () => {
  const { calls, done } = runScript(
    "land-train.js",
    {
      skillDir: "/skill",
      root: "/root",
      repo: "site",
      lockToken: "land-train-1788964650-29574",
      repos: { site: { path: "cli", slug: "acme/thing" }, workspace: { path: ".", role: "workspace" } },
    },
    (call, n) => {
      if (n === 1) return { status: "taken", holder: "land-train-1788964650-29574" };
      if (call.label.startsWith("build:")) return { status: "empty" };
      if (call.label === "left-behind") return { repos: [{ repo: "site", status: "read", labelled: [] }] };
      return { status: "released" };
    },
  );
  const result = await done;

  const survey = calls.find((c) => c.label === "left-behind");
  assert.ok(survey, `no survey step ran. Steps seen: ${calls.map((c) => c.label).join(", ")}`);
  assert.match(survey.prompt, /site {2}acme\/thing/);
  assert.doesNotMatch(survey.prompt, /workspace {2}/, "the root was handed to the survey as a repository");
  const repos = (result["repos"] ?? {}) as Record<string, unknown>;
  assert.ok("site" in repos, `no accounting at all: ${JSON.stringify(result)}`);
  assert.ok(!("workspace" in repos), `the workspace key was accounted for as a repository: ${JSON.stringify(repos)}`);
});

test("the lander does not refuse to start over a workspace key with no slug", async () => {
  const { calls, done } = runScript(
    "land.js",
    {
      skillDir: "/skill",
      root: "/root",
      lockToken: "lander-1788964650-29574",
      repos: { site: { path: "cli", slug: "acme/thing" }, workspace: { path: ".", role: "workspace" } },
    },
    (call, n) => {
      if (n === 1) return { status: "taken", token: "lander-1788964650-29574", holder: "lander-1788964650-29574" };
      if (call.label.startsWith("survey")) return { prs: [] };
      return { status: "released" };
    },
  );
  const result = await done;

  assert.equal(result["error"], undefined, `the lander refused: ${String(result["error"])}`);
  const survey = stepNamed(calls, "survey").prompt;
  assert.match(survey, /acme\/thing/);
  assert.doesNotMatch(survey, / {2}\/root\n/, "the root was offered to the survey as a repository");
});
