import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_ENV } from "./support/git.js";
import { noteVerdict, stampNote, storedNotes, writerOf } from "../src/beads.ts";

const SCRIPT = join(
  import.meta.dirname,
  "..",
  "plugins",
  "devloop",
  "skills",
  "devloop",
  "bd-note.sh",
);

const NOTE = "Kept both sides of the merge.";
const HOLED =
  "The retry loop is satisfied by the first 24 characters. " +
  "Line 221 is `quiet = argv[1]` and the block unpacks quiet=argv[1] from the same slot.";
const HOLE = "`quiet = argv[1]`";
const HOLED_EARLY = "Line 221 is the argv slot and the block unpacks it twice.";
const HOLE_EARLY = "221 is the argv";
const TAGGED = "Lane 3 failed <typecheck> on the second pass.";
const TAGGED_HOLE = "<typecheck>";
const SHORT_TAGGED = "Fixed by <land.js> now.";
const SHORT_TAGGED_HOLE = "<land.js>";
const SHARED_RUN_SEED =
  "\n2026-09-16T09:00:00Z lane-acme-9\n" +
  "PARKED pending review - see https://github.com/404sl/pitwall/pull/195 for the earlier attempt.\n";
const SHARES_RUN =
  "FIXED - pull request https://github.com/404sl/pitwall/pull/196, CI green on Node 20 and 22.";
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z \S+$/;

interface Harness {
  root: string;
  bin: string;
  config: string;
  notesFile: string;
  updatesLog: string;
}

function executable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function harness(seededNotes: string, frozenNow?: string, onlyReadAfterWrite = false): Harness {
  const root = mkdtempSync(join(tmpdir(), "pitwall-bdnote-"));
  const bin = join(root, "bin");
  mkdirSync(bin);

  const config = join(root, ".pitwall.json");
  writeFileSync(config, JSON.stringify({ lockPrefix: `pwbdnote${process.pid}`, repos: {} }));

  const notesFile = join(root, "notes.txt");
  writeFileSync(notesFile, seededNotes);

  const updatesLog = join(root, "updates.log");

  const wrote = join(root, "wrote.flag");
  executable(
    join(bin, "bd"),
    [
      "#!/bin/sh",
      'case "$1" in',
      "  update)",
      `    echo attempt >> "${updatesLog}"`,
      '    [ "${BD_RECORD:-0}" = "1" ] && python3 -c \'import sys; sys.stdout.write(sys.argv[1].replace(sys.argv[2], "") + "\\n")\' "$4" "${BD_DROP:-}" >> "$BD_NOTES"',
      ...(onlyReadAfterWrite ? [`    : > "${wrote}"`] : []),
      '    echo "Updated issue: $2"',
      "    ;;",
      "  show)",
      ...(onlyReadAfterWrite ? [`    [ -f "${wrote}" ] || exit 1`, `    rm -f "${wrote}"`] : []),
      "    python3 -c 'import io,json,sys; print(json.dumps({\"id\": sys.argv[1], \"status\": \"open\", \"notes\": io.open(sys.argv[2]).read()}))' \"$2\" \"$BD_NOTES\"",
      "    ;;",
      '  *) echo "bd stub: unhandled $*" >&2; exit 2 ;;',
      "esac",
      "",
    ].join("\n"),
  );

  if (frozenNow !== undefined) {
    executable(join(bin, "date"), ["#!/bin/sh", `printf '%s\\n' "${frozenNow}"`, ""].join("\n"));
  }

  return { root, bin, config, notesFile, updatesLog };
}

interface Ran {
  status: number;
  stdout: string;
  stderr: string;
}

function append(
  box: Harness,
  args: string[],
  writer: string | undefined,
  record = true,
  drop = "",
): Ran {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...GIT_ENV,
    PATH: `${box.bin}:${process.env["PATH"] ?? ""}`,
    PITWALL_CONFIG: box.config,
    BEADS_DIR: "",
    BD_NOTES: box.notesFile,
    BD_RECORD: record ? "1" : "0",
    BD_DROP: drop,
  };
  if (writer === undefined) {
    delete env["PITWALL_SESSION"];
    env["USER"] = "";
  } else {
    env["PITWALL_SESSION"] = writer;
  }
  const ran = spawnSync("bash", [SCRIPT, ...args], { cwd: box.root, encoding: "utf8", env });
  return { status: ran.status ?? -1, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
}

function stampLines(notes: string): string[] {
  return notes.split("\n").filter((line) => STAMP.test(line));
}

test("a note carries the date it was written and the session that wrote it", () => {
  const seeded = "An older note, written before any of this.\n";
  const box = harness(seeded);
  const ran = append(box, ["acme-1", NOTE], "lane-acme-1");

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  const notes = readFileSync(box.notesFile, "utf8");
  const added = notes.slice(seeded.length).split("\n");
  assert.equal(added[0], "", "a stamped note starts its own block, so a reader can split on it");
  assert.match(added[1] ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z lane-acme-1$/);
  assert.equal(added[2], NOTE);

  const written = Date.parse((added[1] ?? "").split(" ")[0] ?? "");
  assert.ok(!Number.isNaN(written), "the stamp does not parse as a date");
  assert.ok(Math.abs(Date.now() - written) < 60_000, "the stamp is not the time of writing");
});

test("notes already in the field keep their bytes and stay unstamped", () => {
  const seeded = [
    "NEEDS THE ADMIN PANEL, NOT A LANE - flagged so the dispatch selector stops offering it.",
    "",
    "The display half is fixed and live; the delivery half is untouched.",
    "",
  ].join("\n");
  const box = harness(seeded);
  const ran = append(box, ["acme-1", NOTE], "lane-acme-1");

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  const notes = readFileSync(box.notesFile, "utf8");
  assert.equal(notes.slice(0, seeded.length), seeded, "the notes that were there were rewritten");
  assert.equal(stampLines(notes).length, 1, "a date was invented for a note that has none");
});

test("a note written with no session name still records a writer", () => {
  const box = harness("");
  const ran = append(box, ["acme-1", NOTE], undefined);

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  const stamp = stampLines(readFileSync(box.notesFile, "utf8"))[0];
  assert.match(stamp ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z unknown$/);
});

test("a session name with whitespace in it still stamps as one word", () => {
  const box = harness("");
  const ran = append(box, ["acme-1", NOTE], " lane\tacme 1\n");

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  const notes = readFileSync(box.notesFile, "utf8");
  const stamp = notes.split("\n").find((line) => line.includes("Z "));
  assert.match(stamp ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z lane-acme-1$/);
  assert.equal(stampLines(notes).length, 1, "a stamp that is not one word is not read back as a stamp");
});

test("a note file is stamped the same way as note text", () => {
  const box = harness("");
  const notePath = join(box.root, "note.txt");
  writeFileSync(notePath, `${NOTE}\n`);
  const ran = append(box, ["acme-1", "--note-file", notePath], "lane-acme-1");

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  const notes = readFileSync(box.notesFile, "utf8");
  assert.match(notes, /^\n\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z lane-acme-1\nKept both sides/);
});

test("a lost note is not passed off as landed by an earlier note carrying the same stamp", () => {
  const frozen = "2026-09-10T14:22:31Z";
  const box = harness(`${frozen} lane-acme-1\nAn earlier note from the same session.\n`, frozen);
  const ran = append(box, ["acme-1", NOTE], "lane-acme-1", false);

  assert.equal(ran.status, 1, ran.stdout + ran.stderr);
  assert.match(ran.stderr, /did NOT land/);
  assert.match(ran.stderr, /Kept both sides of the merge/);
});

test("a long note that never lands is retried and reported lost, not called a divergence", () => {
  const frozen = "2026-09-10T14:22:31Z";
  const box = harness(`${frozen} lane-acme-1\nAn earlier note from the same session.\n`, frozen);
  const ran = append(box, ["acme-1", HOLED], "lane-acme-1", false);

  assert.equal(ran.status, 1, ran.stdout + ran.stderr);
  assert.match(ran.stderr, /did NOT land/);
  assert.doesNotMatch(ran.stderr, /differs/, "a note with no trace in the field was read as transformed");
});

test("the script and the CLI's own writer stamp a note byte for byte the same", () => {
  const frozen = "2026-09-10T14:22:31Z";
  const session = " lane\tacme 1\n";
  const box = harness("", frozen);
  const ran = append(box, ["acme-1", NOTE], session);

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  const byScript = readFileSync(box.notesFile, "utf8");
  const byCli = stampNote(NOTE, writerOf({ PITWALL_SESSION: session }), new Date(frozen));
  assert.equal(byScript, `${byCli}\n`);
  assert.equal(writerOf({}), "unknown");
});

test("a note that lands whole is appended without a word about it", () => {
  const box = harness("");
  const ran = append(box, ["acme-1", HOLED], "lane-acme-1");

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.equal(ran.stdout.trim(), "bd-note: appended to acme-1");
  assert.doesNotMatch(ran.stderr, /differs/, "a clean append reported a divergence it does not have");
  assert.ok(readFileSync(box.notesFile, "utf8").includes(HOLED), "the note did not round-trip");
});

test("a note stored with its middle missing is reported, with the hole quoted", () => {
  const box = harness("");
  const ran = append(box, ["acme-1", HOLED], "lane-acme-1", true, HOLE);

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stderr, /stored note differs from what was sent/);
  assert.match(ran.stderr, /diverges at character \d+ of \d+/);
  assert.ok(
    ran.stderr.includes("quiet = argv[1]"),
    `the warning does not quote what is missing: ${ran.stderr}`,
  );
  assert.match(ran.stdout, /stored text differs/);
  assert.equal(
    stampLines(readFileSync(box.notesFile, "utf8")).length,
    1,
    "a divergence was retried, which is how duplicate notes get made",
  );
});

test("a note stored with its opening transformed is reported once, not appended three times", () => {
  const box = harness("");
  const ran = append(box, ["acme-1", HOLED_EARLY], "lane-acme-1", true, HOLE_EARLY);

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stderr, /stored note differs from what was sent/);
  assert.match(ran.stderr, /diverges at character \d+ of \d+/);
  assert.match(ran.stdout, /stored text differs/);
  assert.ok(
    ran.stderr.includes(HOLED_EARLY),
    `a divergence was reported without echoing the note, so it is unrecoverable: ${ran.stderr}`,
  );
  assert.equal(
    stampLines(readFileSync(box.notesFile, "utf8")).length,
    1,
    "a divergence inside the opening characters was retried, which is how duplicate notes get made",
  );
});

test("a note that never lands is reported lost even when an earlier note shares a long run with it", () => {
  const box = harness(SHARED_RUN_SEED);
  const ran = append(box, ["acme-1", SHARES_RUN], "lane-acme-1", false);

  assert.equal(ran.status, 1, ran.stdout + ran.stderr);
  assert.match(ran.stderr, /did NOT land/);
  assert.doesNotMatch(
    ran.stderr,
    /differs/,
    "an earlier note sharing a long run was read as a transformed copy of this one",
  );
  assert.doesNotMatch(ran.stdout, /appended/);
  const notes = readFileSync(box.notesFile, "utf8");
  assert.equal(notes, SHARED_RUN_SEED, "a note that recorded nothing left the field changed");
  assert.equal(stampLines(notes).length, 1, "a lost note was counted into the field");
});

test("a note whose surviving fragments are all short is reported once, not appended three times", () => {
  const box = harness("");
  const ran = append(box, ["acme-1", TAGGED], "lane-acme-1", true, TAGGED_HOLE);

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stderr, /stored note differs from what was sent/);
  assert.match(ran.stdout, /stored text differs/);
  assert.equal(
    stampLines(readFileSync(box.notesFile, "utf8")).length,
    1,
    "a note damaged into short fragments was retried, which is how duplicate notes get made",
  );
});

test("a short note damaged in its opening is reported once, not appended three times", () => {
  const box = harness("");
  const ran = append(box, ["acme-1", SHORT_TAGGED], "lane-acme-1", true, SHORT_TAGGED_HOLE);

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stderr, /stored note differs from what was sent/);
  assert.match(ran.stdout, /stored text differs/);
  assert.equal(
    stampLines(readFileSync(box.notesFile, "utf8")).length,
    1,
    "a note shorter than the old token window was retried, which is how duplicate notes get made",
  );
});

test("the script and the CLI's own writer reach the same verdict on the same case", () => {
  const frozen = "2026-09-10T14:22:31Z";
  const stamp = `${frozen} lane-acme-1`;
  const shownOf = (notes: string) => [{ id: "acme-1", status: "open", notes }];
  const divergedAt = (stderr: string) =>
    Number(/diverges at character (\d+) of/.exec(stderr)?.[1] ?? NaN) - 1;

  const whole = harness("", frozen);
  const ranWhole = append(whole, ["acme-1", HOLED], "lane-acme-1");
  assert.equal(ranWhole.status, 0, ranWhole.stdout + ranWhole.stderr);
  assert.deepEqual(noteVerdict(shownOf(readFileSync(whole.notesFile, "utf8")), HOLED, stamp, ""), {
    verdict: "landed",
  });

  const holed = harness("", frozen);
  const ranHoled = append(holed, ["acme-1", HOLED], "lane-acme-1", true, HOLE);
  assert.match(ranHoled.stderr, /diverges at character \d+ of \d+/);
  assert.deepEqual(noteVerdict(shownOf(readFileSync(holed.notesFile, "utf8")), HOLED, stamp, ""), {
    verdict: "diverged",
    at: divergedAt(ranHoled.stderr),
  });

  const early = harness("", frozen);
  const ranEarly = append(early, ["acme-1", HOLED_EARLY], "lane-acme-1", true, HOLE_EARLY);
  assert.match(ranEarly.stderr, /diverges at character \d+ of \d+/);
  assert.deepEqual(
    noteVerdict(shownOf(readFileSync(early.notesFile, "utf8")), HOLED_EARLY, stamp, ""),
    { verdict: "diverged", at: divergedAt(ranEarly.stderr) },
    "the script and the CLI disagree about where a transformed opening diverges",
  );

  const shared = harness(SHARED_RUN_SEED, frozen);
  const ranShared = append(shared, ["acme-1", SHARES_RUN], "lane-acme-1", false);
  assert.equal(ranShared.status, 1, ranShared.stdout + ranShared.stderr);
  assert.deepEqual(
    noteVerdict(
      shownOf(readFileSync(shared.notesFile, "utf8")),
      SHARES_RUN,
      stamp,
      storedNotes(shownOf(SHARED_RUN_SEED)),
    ),
    { verdict: "absent" },
    "an earlier note sharing a long run was read as this write landing, or as transformed",
  );
});

test("a transformed note is reported once even when the read before the write fails", () => {
  const box = harness("", undefined, true);
  const ran = append(box, ["acme-1", HOLED], "lane-acme-1", true, HOLE);

  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stderr, /stored note differs from what was sent/);
  assert.equal(
    stampLines(readFileSync(box.notesFile, "utf8")).length,
    1,
    "a failed read before the write turned a transformed note into three appends",
  );
});

test("the lost-note message names the number of attempts the loop actually made", () => {
  const box = harness(SHARED_RUN_SEED);
  const ran = append(box, ["acme-1", SHARES_RUN], "lane-acme-1", false);

  assert.equal(ran.status, 1, ran.stdout + ran.stderr);
  const reported = /did NOT land on acme-1 after (\d+) attempts/.exec(ran.stderr);
  assert.ok(reported, `the lost-note message names no attempt count: ${ran.stderr}`);
  const made = readFileSync(box.updatesLog, "utf8")
    .split("\n")
    .filter((line) => line !== "").length;
  assert.equal(made, 3, "the retry loop no longer makes three attempts");
  assert.equal(
    Number(reported[1] ?? ""),
    made,
    `the message claims ${reported[1]} attempts where the loop made ${made}`,
  );
});
