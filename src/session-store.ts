/**
 * Session directory discovery.
 *
 * Pi stores sessions under `~/.pi/agent/sessions/--<encoded-cwd>--/`.
 * We read that directory directly (no plugin-side store) so terminal-created
 * sessions appear here too. The vault path is encoded the same way Pi encodes
 * it: strip leading `/` and replace `/`, `\`, `:` with `-`.
 */
import { homedir } from "os";
import { join, basename } from "path";
import { readdir, open, stat } from "fs/promises";

const DEFAULT_SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");

export function encodeCwdForSessionDir(cwd: string): string {
  // Matches Pi's SessionManager.getSessionsDir() encoding:
  //   `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
  const safe = cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
  return `--${safe}--`;
}

export function getSessionDir(cwd: string, sessionsDir?: string): string {
  return join(sessionsDir ?? DEFAULT_SESSIONS_DIR, encodeCwdForSessionDir(cwd));
}

export interface SessionSummary {
  /** Absolute path to the .jsonl session file. */
  file: string;
  /** Session UUID from the header. */
  id: string;
  /** Display name from the latest session_info entry, if any. */
  name?: string;
  /** First user message text, for display when no name is set. */
  firstUserMessage?: string;
  /** Header timestamp (session creation time). */
  createdAt?: string;
  /** File mtime (last write). */
  mtime: number;
  /** Approximate message count (lines with type message). */
  messageCount: number;
}

interface SessionHeader {
  type: string;
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

/**
 * Read only the first part of a session file (up to ~256KB) and extract the
 * header line, the first user message, and the latest session_info name.
 * We never read whole sessions into memory here.
 */
export async function parseSessionSummary(
  file: string,
  mtime: number,
  maxBytes = 256 * 1024,
): Promise<SessionSummary | null> {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    const head = buf.subarray(0, bytesRead).toString("utf8");

    let header: SessionHeader | null = null;
    let firstUserMessage: string | undefined;
    let name: string | undefined;
    let messageCount = 0;

    // Walk lines manually; files are JSONL so `\n` is the only delimiter.
    const lines = head.split("\n");
    for (const line of lines) {
      if (!line) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // truncated tail line — ignore
      }
      if (entry.type === "session" && !header) {
        header = entry as unknown as SessionHeader;
      } else if (entry.type === "session_info") {
        const n = (entry as { name?: string }).name;
        if (typeof n === "string" && n.length > 0) name = n;
      } else if (entry.type === "message") {
        messageCount++;
        const msg = (entry as { message?: { role?: string; content?: unknown } }).message;
        if (msg?.role === "user" && firstUserMessage === undefined) {
          firstUserMessage = extractUserText(msg.content);
        }
      }
    }

    if (!header) return null;
    return {
      file,
      id: header.id,
      name,
      firstUserMessage,
      createdAt: header.timestamp,
      mtime,
      messageCount,
    };
  } finally {
    await fh.close();
  }
}

function extractUserText(
  content: unknown,
): string | undefined {
  if (typeof content === "string") return content.slice(0, 300);
  if (Array.isArray(content)) {
    const texts = content
      .filter((b): b is { type: string; text: string } => b && typeof b === "object" && b.type === "text")
      .map((b) => b.text);
    if (texts.length > 0) return texts.join("\n").slice(0, 300);
  }
  return undefined;
}

/**
 * List sessions for a working directory, newest first.
 */
export async function listSessions(
  cwd: string,
  sessionsDir?: string,
): Promise<SessionSummary[]> {
  const dir = getSessionDir(cwd, sessionsDir);
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return []; // no sessions dir yet
  }

  const summaries: SessionSummary[] = [];
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const file = join(dir, name);
    try {
      const st = await stat(file);
      const s = await parseSessionSummary(file, st.mtimeMs);
      if (s) summaries.push(s);
    } catch {
      // unreadable/racing file — skip
    }
  }
  summaries.sort((a, b) => b.mtime - a.mtime);
  return summaries;
}

/** Human-readable label for the resume list. */
export function sessionDisplayName(s: SessionSummary): string {
  if (s.name && s.name.length > 0) return s.name;
  if (s.firstUserMessage && s.firstUserMessage.length > 0) return s.firstUserMessage;
  return s.id.slice(0, 12);
}

export function sessionSubtitle(s: SessionSummary): string {
  const date = new Date(s.mtime).toLocaleString();
  const msgs = `${s.messageCount} messages`;
  return `${date} · ${msgs} · ${basename(s.file)}`;
}
