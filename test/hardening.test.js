import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "human-review-hardening-"));
process.env.HUMAN_REVIEW_STATE_DIR = path.join(tmp, "state");
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { start } = await import("../src/server.js");
const { Store } = await import("../src/state.js");
const { archiveDir, journalPath } = await import("../src/paths.js");

function request(server, method, route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: server.port,
        method,
        path: route,
        headers: {
          ...(server.token ? { "x-human-review-token": server.token } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, raw }));
      }
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function collect(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("a sent batch lands in the archive dir and the journal", async (t) => {
  const file = path.join(tmp, "archive-me.html");
  fs.writeFileSync(file, "<p>Original</p>");
  const running = await start(0);
  t.after(() => running.dispose());

  const opened = JSON.parse((await request(running, "POST", "/api/session", { target: file })).raw);
  await request(running, "POST", `/api/page/${opened.key}/comment`, {
    kind: "selection",
    quote: "Original",
    feedback: "Sharpen this.",
  });
  const sent = await request(running, "POST", `/api/page/${opened.key}/send`, { sessionId: opened.sessionId, note: "" });
  assert.equal(sent.status, 200);

  const archived = fs.readdirSync(archiveDir()).filter((name) => name.endsWith(`-${opened.key}.json`));
  assert.equal(archived.length, 1);
  const record = JSON.parse(fs.readFileSync(path.join(archiveDir(), archived[0]), "utf8"));
  assert.equal(record.entryKey, opened.key);
  assert.equal(record.batch.pages[0].comments[0].feedback, "Sharpen this.");

  const events = fs
    .readFileSync(journalPath(), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(events.some((e) => e.event === "comment_added" && e.key === opened.key));
  assert.ok(events.some((e) => e.event === "batch_sent" && e.key === opened.key));
});

test("a session record survives a server stop and start", async (t) => {
  const file = path.join(tmp, "survive-me.html");
  fs.writeFileSync(file, "<p>Persist</p>");
  const first = await start(0);
  const opened = JSON.parse((await request(first, "POST", "/api/session", { target: file })).raw);
  const before = await request(first, "GET", opened.path);
  assert.equal(before.status, 200);
  first.dispose();

  const second = await start(0);
  t.after(() => second.dispose());
  const after = await request(second, "GET", opened.path);
  assert.equal(after.status, 200, after.raw);
  assert.match(after.raw, /__SESSION_ID__|human-review|<html/i);
});

test("poll picks up a batch another instance persisted after startup", async (t) => {
  const file = path.join(tmp, "stranded.html");
  fs.writeFileSync(file, "<p>Stranded</p>");
  const running = await start(0);
  t.after(() => running.dispose());

  // Simulate a second server instance persisting a batch behind our back.
  const other = new Store();
  const page = other.openPage(file, "<p>Stranded</p>");
  other.setBatch(page.key, {
    batch: { status: "feedback", pages: [{ kind: "file", file, comments: [], edits: [] }], sent_at: new Date().toISOString() },
    cleanup: [],
  });

  const polled = await request(running, "GET", `/api/poll?target=${encodeURIComponent(file)}`);
  assert.equal(polled.status, 200);
  const batch = JSON.parse(polled.raw);
  assert.equal(batch.status, "feedback");
  assert.equal(batch.pages[0].file, file);
});

test("history lists archived batches and --show prints one in full", async (t) => {
  const file = path.join(tmp, "history-me.html");
  fs.writeFileSync(file, "<p>History</p>");
  const running = await start(0);
  t.after(() => running.dispose());

  const opened = JSON.parse((await request(running, "POST", "/api/session", { target: file })).raw);
  await request(running, "POST", `/api/page/${opened.key}/comment`, {
    kind: "selection",
    quote: "History",
    feedback: "Keep this forever.",
  });
  await request(running, "POST", `/api/page/${opened.key}/send`, { sessionId: opened.sessionId, note: "" });

  const env = { ...process.env, HUMAN_REVIEW_STATE_DIR: process.env.HUMAN_REVIEW_STATE_DIR };
  const listed = await collect(spawn(process.execPath, ["src/cli.js", "history", file], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] }));
  assert.equal(listed.code, 0, listed.stderr);
  const listing = JSON.parse(listed.stdout);
  assert.equal(listing.batches.length, 1);
  assert.equal(listing.batches[0].comments, 1);
  assert.equal(listing.batches[0].acked, false);

  const shown = await collect(
    spawn(process.execPath, ["src/cli.js", "history", file, "--show", "0"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] })
  );
  assert.equal(shown.code, 0, shown.stderr);
  const record = JSON.parse(shown.stdout);
  assert.equal(record.batch.pages[0].comments[0].feedback, "Keep this forever.");
});
