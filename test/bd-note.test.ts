import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z \S+$/;

interface Harness {
  root: string;
  bin: string;
  config: string;
  notesFile: string;
}

function executable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function harness(seededNotes: string, frozenNow?: string): Harness {
  const root = mkdtempSync(join(tmpdir(), "pitwall-bdnote-"));
  const bin = join(root, "bin");
  mkdirSync(bin);

  const config = join(root, ".pitwall.json");
  writeFileSync(config, JSON.stringify({ lockPrefix: `pwbdnote${process.pid}`, repos: {} }));

  const notesFile = join(root, "notes.txt");
  writeFileSync(notesFile, seededNotes);

  executable(
    join(bin, "bd"),
    [
      "#!/bin/sh",
      'case "$1" in',
      "  update)",
      '    [ "${BD_RECORD:-0}" = "1" ] && printf \'%s\\n\' "$4" >> "$BD_NOTES"',
      '    echo "Updated issue: $2"',
      "    ;;",
      "  show)",
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

  return { root, bin, config, notesFile };
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
): Ran {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${box.bin}:${process.env["PATH"] ?? ""}`,
    PITWALL_CONFIG: box.config,
    BEADS_DIR: "",
    BD_NOTES: box.notesFile,
    BD_RECORD: record ? "1" : "0",
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
