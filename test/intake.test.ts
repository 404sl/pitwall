import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { SCHEMA_VERSION } from "@404sl/pitwall-schema";
import { createConsoleServer, listen, HOST } from "../src/serve.ts";
import { createdId, createArgs, setMetadataArgs } from "../src/beads.ts";
import {
  INTAKE_DIR,
  INTAKE_ROUTE,
  INTAKE_TYPE,
  MAX_BODY_BYTES,
  MAX_FILES,
  MAX_FILE_BYTES,
  fileSize,
  planningSession,
  safeName,
  sift,
  titleOf,
  uniqueNames,
} from "../src/intake.ts";
import { boundaryOf, parseMultipart } from "../src/multipart.ts";
import { filesNote, intakePath } from "../src/recording.ts";
import { VERSION } from "../src/version.ts";
import { spawnGit } from "./support/git.ts";

const TRACKER = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "bd", "tracker");
const BD_OK = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "bd", "ok");
const BOUNDARY = "----pitwallTestBoundary";
const CREATED = "mw-new";

test("a cap refusal names the file, its size and the real cap", () => {
  assert.equal(fileSize(12_998_493), "12.4 MB");
  assert.equal(fileSize(MAX_FILE_BYTES), "10 MB");
  assert.equal(fileSize(860_160), "840 KB");
  assert.equal(fileSize(4_096), "4 KB");
  assert.equal(fileSize(200), "200 B");
  assert.equal(fileSize(1_048_575), "1 MB");

  const sifted = sift([
    { name: "shot.png", bytes: 4 },
    { name: "huge.png", bytes: MAX_FILE_BYTES + 1 },
  ]);
  assert.deepEqual(
    sifted.accepted.map((file) => file.name),
    ["shot.png"],
  );
  assert.deepEqual(
    sifted.refused.map((file) => [file.name, file.kind]),
    [["huge.png", "size"]],
  );
});

test("past the file limit the rest are refused, and every earlier one still stands", () => {
  const many = Array.from({ length: MAX_FILES + 2 }, (_, index) => ({
    name: `shot-${String(index)}.png`,
    bytes: 8,
  }));
  const sifted = sift(many);

  assert.equal(sifted.accepted.length, MAX_FILES);
  assert.deepEqual(
    sifted.refused.map((file) => file.kind),
    ["count", "count"],
  );
});

test("the title is derived and truncated; the raw text it came from is not", () => {
  assert.equal(titleOf("  the board cannot record  \nmore below", []), "the board cannot record");
  assert.equal(titleOf("\n\nsecond line is the first one written", []), "second line is the first one written");
  assert.equal(titleOf("", ["shot.png"]), "shot.png");

  const long = "x".repeat(200);
  const title = titleOf(long, []);
  assert.equal(title.length, 120);
  assert.ok(title.endsWith("…"));
});

test("a dropped name cannot escape its own directory, and two of a name cannot collide", () => {
  assert.equal(safeName("../../etc/passwd"), "passwd");
  assert.equal(safeName("C:\\Users\\me\\shot .png"), "shot_.png");
  assert.equal(safeName("..."), "file");
  assert.deepEqual(uniqueNames(["shot.png", "shot.png", "shot.png"]), [
    "shot.png",
    "shot-2.png",
    "shot-3.png",
  ]);
});

test("the assignee is the project's planning session, never a lane", () => {
  assert.equal(planningSession("pitwall"), "pitwall-planning-session");
  assert.equal(planningSession("mw"), "mw-planning-session");
});

test("bd is asked to create the issue the ticket describes, and its id is read back", () => {
  const args = createArgs({
    title: "a title",
    bodyFile: "/tmp/body.txt",
    metadataFile: "/tmp/meta.json",
    assignee: "mw-planning-session",
    labels: ["unrefined"],
    issueType: INTAKE_TYPE,
  });

  assert.deepEqual(args, [
    "create",
    "a title",
    "--type",
    INTAKE_TYPE,
    "--assignee",
    "mw-planning-session",
    "--labels",
    "unrefined",
    "--body-file",
    "/tmp/body.txt",
    "--metadata",
    "@/tmp/meta.json",
    "--silent",
  ]);
  assert.deepEqual(setMetadataArgs("mw-9", "/tmp/meta.json"), [
    "update",
    "mw-9",
    "--metadata",
    "@/tmp/meta.json",
  ]);
  assert.equal(createdId("mw-4b5\n"), "mw-4b5");
  assert.equal(createdId("warning\n✓ Created issue: mw-4b5\n"), "mw-4b5");
  assert.equal(createdId("\n"), undefined);
});

test("a note lists every dropped file by the path the bead records", () => {
  assert.equal(filesNote([".pitwall-intake/mw-1/a.png"]), "One file was dropped with this request: .pitwall-intake/mw-1/a.png");
  assert.match(filesNote([".pitwall-intake/mw-1/a.png", ".pitwall-intake/mw-1/b.png"]), /^2 files were dropped/);
});

function part(name: string, value: string, filename?: string): Buffer {
  const disposition =
    filename === undefined
      ? `content-disposition: form-data; name="${name}"`
      : `content-disposition: form-data; name="${name}"; filename="${filename}"`;
  return Buffer.from(`--${BOUNDARY}\r\n${disposition}\r\n\r\n${value}\r\n`, "utf8");
}

function multipart(parts: readonly Buffer[]): Buffer {
  return Buffer.concat([...parts, Buffer.from(`--${BOUNDARY}--\r\n`, "utf8")]);
}

test("the parser hands back part bodies byte for byte, CRLF and all", () => {
  assert.equal(boundaryOf(`multipart/form-data; boundary=${BOUNDARY}`), BOUNDARY);
  assert.equal(boundaryOf(`multipart/form-data; boundary="${BOUNDARY}"`), BOUNDARY);
  assert.equal(boundaryOf("application/json"), undefined);

  const raw = "  leading and trailing  \r\nsecond ünicode line\n\n";
  const parsed = parseMultipart(multipart([part("text", raw), part("files", "PNG", "shot.png")]), BOUNDARY);

  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.body.toString("utf8"), raw);
  assert.equal(parsed[1]?.filename, "shot.png");
  assert.throws(() => parseMultipart(Buffer.from("not multipart"), BOUNDARY), /boundary/);
});

interface Box {
  origin: string;
  root: string;
  log: string;
  notes: string;
  body: string;
  meta: string;
  post: (
    payload: Buffer,
    options?: { headers?: Record<string, string>; bare?: boolean },
  ) => Promise<{ status: number; body: string }>;
}

async function recording(
  closing: { after: (teardown: () => void) => void },
  extra: Record<string, string> = {},
): Promise<Box> {
  const room = mkdtempSync(join(tmpdir(), "pitwall-intake-test-"));
  const root = join(room, "tracker");
  cpSync(TRACKER, root, { recursive: true });
  const home = mkdtempSync(join(tmpdir(), "pitwall-intake-state-"));
  const statePath = join(home, "pitwall", "snapshot.json");
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(
    statePath,
    JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      generatedAt: "2026-09-12T10:00:00Z",
      agent: { version: VERSION, executor: "local" },
      projects: [
        {
          id: "mw",
          name: "milliwatt",
          root,
          authority: { kind: "beads", idPrefix: "mw" },
          metrics: {},
          issues: [],
          errors: [],
        },
      ],
    }),
  );
  const log = join(room, "calls.log");
  const notes = join(room, "notes.log");
  const body = join(room, "body.txt");
  const meta = join(room, "meta.json");
  const server: Server = createConsoleServer({
    env: {
      XDG_STATE_HOME: home,
      PATH: `${BD_OK}:/usr/bin:/bin`,
      BD_CALL_LOG: log,
      BD_NOTES_LOG: notes,
      BD_BODY_LOG: body,
      BD_META_LOG: meta,
      ...extra,
    },
    uiDir: join(room, "never-built"),
  });
  closing.after(() => server.close());
  await listen(server, 0);
  const { port } = server.address() as AddressInfo;
  const origin = `http://${HOST}:${String(port)}`;
  return {
    origin,
    root,
    log,
    notes,
    body,
    meta,
    post: (payload, options = {}) =>
      new Promise((done, failed) => {
        const sending = request(
          {
            host: HOST,
            port,
            path: INTAKE_ROUTE,
            method: "POST",
            headers: {
              host: `${HOST}:${String(port)}`,
              "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
              "content-length": String(payload.length),
              ...(options.bare === true ? {} : { "x-pitwall-action": "1" }),
              ...options.headers,
            },
          },
          (response) => {
            let answered = "";
            response.setEncoding("utf8");
            response.on("data", (chunk: string) => {
              answered += chunk;
            });
            response.on("end", () => done({ status: response.statusCode ?? 0, body: answered }));
          },
        );
        sending.on("error", failed);
        sending.end(payload);
      }),
  };
}

function calls(path: string): string[] {
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line !== "")
    : [];
}

const TYPED = "  the console cannot record a new request  \n\nsecond line, ünicode, trailing space  ";

test("text and a dropped screenshot become one bead whose raw text is byte for byte what was typed", async (t) => {
  const box = await recording(t);

  const answered = await box.post(
    multipart([part("text", TYPED), part("project", "mw"), part("files", "PNGDATA", "shot.png")]),
  );

  assert.equal(answered.status, 200, answered.body);
  const answer = JSON.parse(answered.body) as {
    id: string;
    project: string;
    assignee: string;
    label: string;
    files: string[];
  };
  assert.equal(answer.id, CREATED);
  assert.equal(answer.assignee, "mw-planning-session");
  assert.equal(answer.label, "unrefined");
  assert.deepEqual(answer.files, [`${INTAKE_DIR}/${CREATED}/shot.png`]);

  assert.equal(readFileSync(box.body, "utf8"), TYPED, "the description is not what was typed");
  const written = JSON.parse(readFileSync(box.meta, "utf8")) as { intake: { raw: string; files: string[] } };
  assert.equal(written.intake.raw, TYPED, "metadata.intake.raw is not what was typed");
  assert.deepEqual(written.intake.files, [`${INTAKE_DIR}/${CREATED}/shot.png`]);

  const dropped = intakePath(box.root, CREATED);
  assert.equal(readFileSync(join(dropped, "shot.png"), "utf8"), "PNGDATA");
  assert.equal(readFileSync(join(box.root, INTAKE_DIR, ".gitignore"), "utf8"), "*\n");
  assert.match(readFileSync(box.notes, "utf8"), /One file was dropped with this request/);

  const created = calls(box.log).filter((line) => line.startsWith("create "));
  assert.equal(created.length, 1, "one request wrote more than one bead");
  assert.match(created[0] ?? "", /--assignee mw-planning-session/);
  assert.match(created[0] ?? "", /--labels unrefined/);
  assert.doesNotMatch(created[0] ?? "", /devloop/, "intake assigned a bead to a lane");
});

test("what the browser's own encoder sends is stored exactly as it was typed", async (t) => {
  const box = await recording(t);
  const typed = "  the console cannot record a new request  \n\nsecond line, ünicode, trailing space  ";
  const dropped = "first\r\nsecond\r\n";
  const form = new FormData();
  form.append("text", typed);
  form.append("project", "mw");
  form.append("files", new Blob([Buffer.from(dropped, "utf8")]), "log.txt");
  const encoded = new Response(form);
  const contentType = encoded.headers.get("content-type") ?? "";
  const payload = Buffer.from(await encoded.arrayBuffer());

  assert.ok(
    payload.toString("utf8").includes("request  \r\n\r\nsecond line"),
    "the encoder no longer folds a typed newline to CRLF, and this test no longer proves anything",
  );

  const answered = await box.post(payload, { headers: { "content-type": contentType } });
  assert.equal(answered.status, 200, answered.body);

  assert.equal(readFileSync(box.body, "utf8"), typed, "the description is not what was typed");
  const written = JSON.parse(readFileSync(box.meta, "utf8")) as { intake: { raw: string } };
  assert.equal(written.intake.raw, typed, "metadata.intake.raw is not what was typed");

  const home = intakePath(box.root, CREATED);
  assert.equal(
    readFileSync(join(home, "log.txt"), "utf8"),
    dropped,
    "a dropped file's own bytes were rewritten",
  );
  assert.match(calls(box.log).find((line) => line.startsWith("create ")) ?? "", /--type task/);
});

test("a dropped file leaves the checkout it landed in clean", async (t) => {
  const box = await recording(t);
  assert.equal(spawnGit(["init", "--quiet"], { cwd: box.root }).status, 0);
  const before = spawnGit(["status", "--porcelain"], { cwd: box.root });
  assert.equal(before.status, 0);

  const answered = await box.post(
    multipart([part("text", "a screenshot"), part("files", "PNGDATA", "shot.png")]),
  );
  assert.equal(answered.status, 200, answered.body);

  const after = spawnGit(["status", "--porcelain"], { cwd: box.root });
  assert.equal(after.status, 0);
  assert.equal(after.stdout, before.stdout, "a dropped file shows up in git status");
  assert.doesNotMatch(after.stdout, /pitwall-intake/);
});

test("a recorded request with no action header is refused, and no bead is written", async (t) => {
  const box = await recording(t);

  const refused = await box.post(multipart([part("text", "anything")]), { bare: true });
  assert.equal(refused.status, 403);
  assert.match(refused.body, /x-pitwall-action/);

  const foreign = await box.post(multipart([part("text", "anything")]), {
    headers: { origin: "http://pitwall.build.evil.example" },
  });
  assert.equal(foreign.status, 403);
  assert.deepEqual(calls(box.log), [], "a refused request still reached the tracker");
});

test("an empty box records nothing, and neither does one over the cap", async (t) => {
  const box = await recording(t);

  const empty = await box.post(multipart([part("text", "")]));
  assert.equal(empty.status, 400);
  assert.match(empty.body, /needs some text or at least one file/);

  const huge = await box.post(
    multipart([
      part("text", "a big one"),
      part("files", "x".repeat(MAX_FILE_BYTES + 524_288), "huge.png"),
    ]),
  );
  assert.equal(huge.status, 400);
  assert.match(huge.body, /huge\.png is 10\.5 MB, over the 10 MB cap/);
  assert.deepEqual(calls(box.log), [], "a request over the cap still reached the tracker");
});

test("a request past the body cap is refused in words, not by a dropped connection", async (t) => {
  const box = await recording(t);

  const answered = await box.post(
    multipart([part("text", "a big one"), part("files", "x".repeat(MAX_BODY_BYTES), "huge.bin")]),
  );

  assert.equal(answered.status, 413, answered.body);
  assert.match(answered.body, /over the 25 MB cap/);
  assert.deepEqual(calls(box.log), [], "a request over the body cap still reached the tracker");
});

test("when the files cannot be recorded the bead and its id still come back", async (t) => {
  const box = await recording(t, { BD_METADATA_FAIL: "the tracker is locked" });

  const answered = await box.post(multipart([part("text", TYPED), part("files", "PNGDATA", "shot.png")]));

  assert.equal(answered.status, 502);
  const answer = JSON.parse(answered.body) as { id: string; reason: string; message: string };
  assert.equal(answer.id, CREATED, "a half-written request lost the id the owner has to follow");
  assert.match(answer.reason, /bd update mw-new --metadata/);
  assert.match(
    answer.message,
    /its files are on disk, but the ticket does not list them/,
    "a partial notice told the owner files were lost that are on disk",
  );
  assert.match(answer.message, /The text is safe on the ticket/);
  assert.equal(readFileSync(box.body, "utf8"), TYPED);
});

const { Intake, attachedSentence, carriesFiles, outcomeOf, refusalLine, refusalReason } = await import(
  "../ui/components/Intake.tsx"
);

test("the collapsed box is one grey control and says what it will do", () => {
  const markup = renderToStaticMarkup(
    createElement(Intake, { projects: [{ value: "mw", label: "milliwatt" }] }),
  );

  assert.match(markup, /aria-expanded="false"/);
  assert.match(markup, /Record a request/);
  assert.match(markup, /milliwatt/);
  assert.match(markup, /mw-planning-session/);
  assert.match(markup, /unrefined/);
  assert.doesNotMatch(markup, /pw-notice/, "the board shows a notice before anything was recorded");
  assert.doesNotMatch(markup, /pw-row--signal|pw-row--hold|pw-notice--alert/, "intake used a signal colour");
});

test("the success line leads with the number, and a refusal is never silent", () => {
  assert.equal(attachedSentence(0, 0), "");
  assert.equal(attachedSentence(2, 1), "2 files attached, 1 refused.");
  assert.equal(attachedSentence(0, 2), "2 files refused.");
  assert.equal(refusalLine([]), "");
  assert.equal(
    refusalLine([refusalReason("size", "shot.png", 12_998_493)]),
    "1 file refused. shot.png is 12.4 MB, over the 10 MB cap.",
  );
});

test("a half-written answer reads as partial, and a bodiless failure as a failure", () => {
  const partial = outcomeOf(false, JSON.stringify({ id: "mw-9", project: "mw", reason: "disk full." }), 0);
  assert.deepEqual(partial, { kind: "partial", id: "mw-9", project: "mw", reason: "disk full.", attached: 0 });

  const failed = outcomeOf(false, JSON.stringify({ message: "Nothing was recorded - no snapshot." }), 0);
  assert.deepEqual(failed, { kind: "failed", message: "Nothing was recorded - no snapshot." });

  const recorded = outcomeOf(
    true,
    JSON.stringify({ id: "mw-9", project: "mw", assignee: "mw-planning-session", label: "unrefined", files: ["a"] }),
    1,
  );
  assert.deepEqual(recorded, {
    kind: "recorded",
    id: "mw-9",
    project: "mw",
    assignee: "mw-planning-session",
    label: "unrefined",
    attached: 1,
    refused: 1,
  });
});

test("a drag that carries no file never opens the box", () => {
  assert.equal(carriesFiles({ dataTransfer: { types: ["Files"] } }), true);
  assert.equal(carriesFiles({ dataTransfer: { types: ["text/plain", "text/html"] } }), false);
  assert.equal(carriesFiles({ dataTransfer: { types: [] } }), false);
});
