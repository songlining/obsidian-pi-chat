import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { encodeCwdForSessionDir, getSessionDir, parseSessionSummary, listSessions, sessionDisplayName } from "../src/session-store";

describe("encodeCwdForSessionDir", () => {
  it("encodes a unix path like Pi does", () => {
    expect(encodeCwdForSessionDir("/Users/larry.song/work/hashicorp/obsidian-notes")).toBe(
      "--Users-larry.song-work-hashicorp-obsidian-notes--",
    );
  });

  it("encodes the root path", () => {
    // Pi's encoding: strip leading slash (""), replace [/\\:] with "-" -> "--" + "--"
    expect(encodeCwdForSessionDir("/")).toBe("----");
  });

  it("handles a trailing slash", () => {
    expect(encodeCwdForSessionDir("/tmp/foo/")).toBe("--tmp-foo---");
  });

  it("matches observed Pi behavior for this machine", () => {
    // Observed real directory: ~/.pi/agent/sessions/--Users-larry.song-work-hashicorp-obsidian-notes--
    expect(getSessionDir("/Users/larry.song/work/hashicorp/obsidian-notes").endsWith(
      "--Users-larry.song-work-hashicorp-obsidian-notes--",
    )).toBe(true);
  });
});

describe("parseSessionSummary", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-chat-test-"));
    mkdirSync(join(dir, "--tmp-session-test--"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const header =
    '{"type":"session","version":3,"id":"uuid-123","timestamp":"2026-08-01T00:00:00.000Z","cwd":"/tmp"}\n';
  const sessionInfo =
    '{"type":"session_info","id":"aaaa1111","parentId":null,"timestamp":"2026-08-01T00:00:01.000Z","name":"My Session"}\n';
  const userMsg =
    '{"type":"message","id":"bbbb2222","parentId":null,"timestamp":"2026-08-01T00:00:02.000Z","message":{"role":"user","content":"First prompt here","timestamp":1}}\n';
  const assistantMsg =
    '{"type":"message","id":"cccc3333","parentId":"bbbb2222","timestamp":"2026-08-01T00:00:03.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Hi"}],"timestamp":1}}\n';

  it("parses header, name, and first user message", async () => {
    const file = join(dir, "--tmp-session-test--", "2026-08-01T00-00-00-000Z_uuid.jsonl");
    writeFileSync(file, header + sessionInfo + userMsg + assistantMsg);
    const summary = await parseSessionSummary(file, 1000);
    expect(summary).not.toBeNull();
    expect(summary!.id).toBe("uuid-123");
    expect(summary!.name).toBe("My Session");
    expect(summary!.firstUserMessage).toBe("First prompt here");
    expect(summary!.messageCount).toBe(2);
  });

  it("falls back to first user message when no name", async () => {
    const file = join(dir, "--tmp-session-test--", "2026-08-01T00-00-00-000Z_uuid2.jsonl");
    writeFileSync(file, header + userMsg);
    const summary = await parseSessionSummary(file, 1000);
    expect(summary!.name).toBeUndefined();
    expect(sessionDisplayName(summary!)).toBe("First prompt here");
  });

  it("returns null for a file without a session header", async () => {
    const file = join(dir, "--tmp-session-test--", "bad.jsonl");
    writeFileSync(file, '{"type":"message","id":"x","parentId":null,"timestamp":"2026-08-01T00:00:00.000Z","message":{"role":"user","content":"hi","timestamp":1}}\n');
    const summary = await parseSessionSummary(file, 1000);
    expect(summary).toBeNull();
  });

  it("tolerates truncated tail lines", async () => {
    const file = join(dir, "--tmp-session-test--", "2026-08-01T00-00-00-000Z_uuid3.jsonl");
    writeFileSync(file, header + userMsg + '{"type":"message","id":"z","p');
    const summary = await parseSessionSummary(file, 1000);
    expect(summary).not.toBeNull();
    expect(summary!.messageCount).toBe(1);
  });
});

describe("listSessions", () => {
  it("returns [] for a missing directory", async () => {
    const sessions = await listSessions("/nonexistent/path");
    expect(sessions).toEqual([]);
  });

  it("lists and sorts sessions newest first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-chat-list-"));
    try {
      const cwd = "/tmp/list-test";
      const sessionsDir = join(dir, "--tmp-list-test--");
      mkdirSync(sessionsDir, { recursive: true });
      const old = join(sessionsDir, "2026-01-01T00-00-00-000Z_old.jsonl");
      const newFile = join(sessionsDir, "2026-06-01T00-00-00-000Z_new.jsonl");
      writeFileSync(old, '{"type":"session","version":3,"id":"old","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n');
      writeFileSync(newFile, '{"type":"session","version":3,"id":"new","timestamp":"2026-06-01T00:00:00.000Z","cwd":"/tmp"}\n');
      const summaries = await listSessions(cwd, dir);
      expect(summaries.map((s) => s.id)).toEqual(["new", "old"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
