/**
 * Strict JSONL framing for the Pi RPC protocol.
 *
 * Pi RPC mode uses LF (`\n`) as the *only* record delimiter. Node's
 * `readline` is NOT protocol-compliant because it also splits on U+2028 and
 * U+2029, which are legal inside JSON strings. We split on `\n` only and
 * tolerate an optional trailing `\r` (for `\r\n` input).
 */
export class JsonlDecoder {
  private buffer = "";
  private onLine: (line: string) => void;

  constructor(onLine: (line: string) => void) {
    this.onLine = onLine;
  }

  push(chunk: string | Buffer | Uint8Array): void {
    this.buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");

    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) break;

      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      // Skip blank records; Pi never emits them and JSON.parse would choke.
      if (line.trim().length === 0) continue;
      this.onLine(line);
    }
  }

  /** Flush any remaining buffered text without a trailing newline. */
  flush(): void {
    if (this.buffer.length > 0) {
      const line = this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer;
      this.buffer = "";
      this.onLine(line);
    }
  }
}

/**
 * Encode one command as a JSONL record for the subprocess stdin.
 */
export function encodeCommand(command: object): string {
  return JSON.stringify(command) + "\n";
}

/**
 * Split a string into records using the strict JSONL rule.
 * Exposed for tests and direct use.
 */
export function splitJsonl(input: string): string[] {
  const lines = input.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}
