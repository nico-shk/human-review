import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { archiveDir, canonicalTarget, ensureStateDir, journalPath, pageKey, realFile, statePath, targetKey } from "./paths.js";

/** Anything untouched this long is review debris, not work in progress. */
const PRUNE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const fresh = (entry, now) => !!entry && now - (entry.updatedAt || 0) < PRUNE_AGE_MS;

/**
 * Atomic write via a unique sibling tmp file. The name is unguessable and the
 * create is exclusive, so a pre-planted symlink can never redirect the write,
 * and a failed rename never leaves a predictable orphan behind.
 */
export function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.human-review.tmp`;
  fs.writeFileSync(tmp, data, { flag: "wx" });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

/**
 * All durable state lives in one JSON file. No database, no network.
 *
 * Shape:
 *   {
 *     pages:    { <key>: { key, file, pristine, comments[], edits[], updatedAt } },
 *     batches:  { <entryKey>: { batch, cleanup, updatedAt } },
 *     sessions: { <id>: { entryKey, activeKey, visited[], updatedAt } },
 *   }
 *
 * Pages are fully independent: no page ever references another. Batches are
 * feedback the user sent that no agent has acknowledged yet; persisting them
 * means "your feedback is safe" stays true across server restarts.
 */
export class Store {
  constructor() {
    this.data = { pages: {}, batches: {}, sessions: {} };
    /** Batches this process acked; save() must not resurrect them from disk. */
    this.clearedBatches = new Set();
    /** Sessions this process ended; same resurrection guard as batches. */
    this.clearedSessions = new Set();
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(statePath(), "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.pages) {
        this.data = { pages: parsed.pages, batches: parsed.batches || {}, sessions: parsed.sessions || {} };
      }
    } catch {
      // Missing or unreadable state is not an error; start empty.
    }
    this.prune();
    return this.data;
  }

  /** Drop pages whose file is gone or that nobody has touched in a month. */
  prune() {
    const now = Date.now();
    for (const [key, page] of Object.entries(this.data.pages)) {
      const missingFile = page.kind !== "url" && !fs.existsSync(page.file);
      if (!fresh(page, now) || missingFile) {
        delete this.data.pages[key];
        delete this.data.batches[key];
      }
    }
    for (const [key, batch] of Object.entries(this.data.batches)) {
      if (!fresh(batch, now)) delete this.data.batches[key];
    }
    for (const [id, session] of Object.entries(this.data.sessions || {})) {
      // A session guarding unsent feedback or an unacked batch is never debris.
      if (!fresh(session, now) && !this.sessionHasWork(session)) delete this.data.sessions[id];
    }
  }

  /** Does this session still guard unsent comments/edits or a pending batch? */
  sessionHasWork(session) {
    if (this.data.batches[session.entryKey]) return true;
    for (const key of session.visited || []) {
      const page = this.data.pages[key];
      if (page && (page.comments.length || page.edits.length)) return true;
    }
    return false;
  }

  /**
   * Merge over whatever is on disk rather than overwriting it. If a second
   * server is ever running, a blind write would silently drop the pages and
   * comments it owns.
   */
  save() {
    ensureStateDir();
    const target = statePath();
    let onDisk = { pages: {}, batches: {}, sessions: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
      // An older server's save() writes no sessions key at all; our in-memory
      // copy re-merges them below, so such a write never wipes sessions.
      if (parsed && parsed.pages) onDisk = { pages: parsed.pages, batches: parsed.batches || {}, sessions: parsed.sessions || {} };
    } catch {
      // No readable state yet; ours becomes the file.
    }
    const merged = {
      pages: { ...onDisk.pages, ...this.data.pages },
      batches: { ...onDisk.batches, ...this.data.batches },
      sessions: { ...(onDisk.sessions || {}), ...(this.data.sessions || {}) },
    };
    for (const key of this.clearedBatches) delete merged.batches[key];
    for (const id of this.clearedSessions) delete merged.sessions[id];
    // Age-prune the merged result too, so the file cannot grow without bound.
    const now = Date.now();
    for (const [key, page] of Object.entries(merged.pages)) {
      if (!fresh(page, now)) delete merged.pages[key];
    }
    for (const [key, batch] of Object.entries(merged.batches)) {
      if (!fresh(batch, now)) delete merged.batches[key];
    }
    for (const [id, session] of Object.entries(merged.sessions)) {
      const busy =
        merged.batches[session.entryKey] ||
        (session.visited || []).some((key) => {
          const page = merged.pages[key];
          return page && (page.comments.length || page.edits.length);
        });
      if (!fresh(session, now) && !busy) delete merged.sessions[id];
    }
    atomicWrite(target, JSON.stringify(merged, null, 2));
  }

  /** Register a file as a reviewable page, capturing the agent's version. */
  openPage(file, pristine) {
    const key = pageKey(file);
    const existing = this.data.pages[key];
    const page = existing || {
      key,
      kind: "file",
      file: realFile(file),
      pristine: "",
      comments: [],
      edits: [],
      updatedAt: 0,
    };
    page.kind = "file";
    page.file = realFile(file);
    delete page.url;
    if (!existing || typeof pristine === "string") {
      page.pristine = typeof pristine === "string" ? pristine : page.pristine;
    }
    page.updatedAt = Date.now();
    this.data.pages[key] = page;
    this.save();
    return page;
  }

  /** Register a rendered localhost route. Browser edits are never written to it. */
  openUrl(url) {
    const target = canonicalTarget(url);
    if (target.kind !== "url") throw new Error("Expected a localhost URL.");
    const key = targetKey(target.value);
    const existing = this.data.pages[key];
    const page = existing || {
      key,
      kind: "url",
      url: target.value,
      pristine: "",
      comments: [],
      edits: [],
      updatedAt: 0,
    };
    page.kind = "url";
    page.url = target.value;
    delete page.file;
    page.updatedAt = Date.now();
    this.data.pages[key] = page;
    this.save();
    return page;
  }

  page(key) {
    return this.data.pages[key] || null;
  }

  pageForFile(file) {
    return this.page(pageKey(file));
  }

  pageForTarget(target) {
    return this.page(targetKey(target));
  }

  update(key, mutate) {
    const page = this.page(key);
    if (!page) return null;
    mutate(page);
    page.updatedAt = Date.now();
    this.save();
    return page;
  }

  addComment(key, comment) {
    return this.update(key, (page) => {
      page.comments.push(comment);
    });
  }

  removeComment(key, id) {
    return this.update(key, (page) => {
      page.comments = page.comments.filter((c) => c.id !== id);
    });
  }

  /** Rewording feedback before it is sent. Returns null for an unknown id. */
  updateComment(key, id, feedback) {
    let found = false;
    const page = this.update(key, (p) => {
      const comment = p.comments.find((c) => c.id === id);
      if (comment) {
        comment.feedback = feedback;
        found = true;
      }
    });
    return found ? page : null;
  }

  /**
   * Edits are deduped by label+kind so retyping one block stays one row, but
   * the text is refreshed every time so `after` is always the latest wording.
   */
  addEdit(key, label, kind, before, after, beforeHtml, afterHtml, extra) {
    return this.update(key, (page) => {
      const row = page.edits.find((e) => e.label === label && e.kind === kind);
      if (row) {
        if (after !== undefined) row.after = after;
        if (afterHtml !== undefined) row.after_html = afterHtml;
        // A re-move of the same block replaces its landing spot.
        if (extra) {
          if (extra.staged_assets) {
            const assets = [...(row.staged_assets || []), ...extra.staged_assets];
            extra = { ...extra, staged_assets: [...new Map(assets.map((asset) => [asset.path, asset])).values()] };
          }
          Object.assign(row, extra);
        }
        row.updatedAt = Date.now();
        return;
      }
      page.edits.push({ label, kind, before, after, before_html: beforeHtml, after_html: afterHtml, ...(extra || {}), at: Date.now(), updatedAt: Date.now() });
    });
  }

  clearEdits(key) {
    return this.update(key, (page) => {
      page.edits = [];
    });
  }

  /** After the agent writes, its version becomes the new revert target. */
  setPristine(key, html) {
    return this.update(key, (page) => {
      page.pristine = html;
      page.edits = [];
    });
  }

  /**
   * Drop exactly what the acknowledged batch carried. Comments made after
   * Send have unknown ids; edits made (or retyped) after Send have a newer
   * timestamp than the batch. Both must survive for the next batch.
   */
  clearSent(key, ids, sentAt) {
    return this.update(key, (page) => {
      const drop = new Set(ids);
      page.comments = page.comments.filter((c) => !drop.has(c.id));
      // >= not >: an edit stamped the same millisecond as the send may not
      // have shipped — resending it is harmless, dropping it loses work.
      page.edits = typeof sentAt === "number" ? page.edits.filter((e) => (e.updatedAt || e.at || 0) >= sentAt) : [];
    });
  }

  // Sent-but-unacked feedback, keyed by the entry page the agent polls.

  batch(entryKey) {
    return this.data.batches[entryKey] || null;
  }

  allBatches() {
    return this.data.batches;
  }

  setBatch(entryKey, { batch, cleanup, delivered }) {
    this.clearedBatches.delete(entryKey);
    this.data.batches[entryKey] = { batch, cleanup, delivered: !!delivered, updatedAt: Date.now() };
    this.save();
  }

  /**
   * Delivery is persisted so an ack arriving at another instance — or after a
   * restart — is honored instead of re-serving the batch a second time.
   */
  markBatchDelivered(entryKey) {
    const record = this.data.batches[entryKey];
    if (!record || record.delivered) return;
    record.delivered = true;
    record.updatedAt = Date.now();
    this.save();
  }

  clearBatch(entryKey) {
    delete this.data.batches[entryKey];
    this.clearedBatches.add(entryKey);
    this.save();
  }

  /**
   * A batch persisted by another server instance after this one loaded is
   * invisible to the in-memory copy. Re-reading just that key from disk makes
   * such stranded feedback deliverable instead of lost.
   */
  reloadBatch(entryKey) {
    if (this.clearedBatches.has(entryKey)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath(), "utf8"));
      const record = parsed && parsed.batches && parsed.batches[entryKey];
      if (!record) return null;
      this.data.batches[entryKey] = record;
      return record;
    } catch {
      return null;
    }
  }

  // Browser sessions, persisted so a server restart never kills open tabs.

  allSessions() {
    return this.data.sessions;
  }

  session(id) {
    return this.data.sessions[id] || null;
  }

  setSession(id, { entryKey, activeKey, visited }) {
    this.clearedSessions.delete(id);
    this.data.sessions[id] = { entryKey, activeKey, visited: [...visited], updatedAt: Date.now() };
    this.save();
  }

  removeSession(id) {
    delete this.data.sessions[id];
    this.clearedSessions.add(id);
    this.save();
  }
}

/**
 * Append-only feedback journal: one JSON line per event, never pruned by the
 * tool. Failures are swallowed — recording history must never break the
 * review itself.
 */
export function journal(event, entry) {
  try {
    ensureStateDir();
    fs.appendFileSync(journalPath(), `${JSON.stringify({ ts: new Date().toISOString(), event, ...entry })}\n`);
  } catch {
    // Journaling is best-effort by design.
  }
}

/**
 * Full copy of every sent batch, written before delivery and never deleted by
 * the tool — ack clears the pending queue, not the archive.
 */
export function archiveBatch(entryKey, batch) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `${stamp}-${entryKey}.json`;
  try {
    fs.mkdirSync(archiveDir(), { recursive: true });
    atomicWrite(path.join(archiveDir(), name), JSON.stringify({ entryKey, archived_at: new Date().toISOString(), batch }, null, 2));
    return name;
  } catch {
    return null;
  }
}

/** Resolve a sibling asset request without escaping the artifact's directory. */
export function resolveAsset(pageFile, relative) {
  let decoded;
  try {
    decoded = decodeURIComponent(relative);
  } catch {
    return null;
  }
  const base = path.dirname(pageFile);
  const target = path.resolve(base, decoded);
  const contained = (candidate, root) => {
    const rel = path.relative(root, candidate);
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  };
  if (!contained(target, base)) return null;
  // The lexical check alone would follow a symlink out of the directory, so
  // the resolved filesystem path must land inside it too.
  let real;
  try {
    real = fs.realpathSync(target);
  } catch {
    // Nothing readable at that path — anything a symlink could point to would
    // have resolved. The caller's read fails with a plain 404.
    return target;
  }
  let realBase = base;
  try {
    realBase = fs.realpathSync(base);
  } catch {}
  if (!contained(real, realBase)) return null;
  return real;
}
