import { describe, it, expect } from "vitest";
import { JsonlDecoder, splitJsonl, encodeCommand } from "../src/jsonl";

describe("JsonlDecoder", () => {
  it("splits records on LF only", () => {
    const lines: string[] = [];
    const dec = new JsonlDecoder((l) => lines.push(l));
    dec.push('{"a":1}\n{"a":2}\n');
    expect(lines).toEqual(['{"a":1}', '{"a":2}']);
  });

  it("handles partial chunks across pushes", () => {
    const lines: string[] = [];
    const dec = new JsonlDecoder((l) => lines.push(l));
    dec.push('{"a":');
    dec.push('1}\n{"b');
    dec.push('":2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("strips a trailing CR from CRLF records", () => {
    const lines: string[] = [];
    const dec = new JsonlDecoder((l) => lines.push(l));
    dec.push('{"a":1}\r\n{"a":2}\r\n');
    expect(lines).toEqual(['{"a":1}', '{"a":2}']);
  });

  it("preserves U+2028 and U+2029 inside JSON strings (readline would split)", () => {
    const lines: string[] = [];
    const dec = new JsonlDecoder((l) => lines.push(l));
    // U+2028 (line separator) and U+2029 (paragraph separator) are valid
    // inside JSON strings; readline would wrongly split on them.
    const payload = JSON.stringify({ type: "prompt", message: "a\u2028b\u2029c" });
    dec.push(payload + "\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.message).toBe("a\u2028b\u2029c");
  });

  it("flushes a trailing record without a final newline", () => {
    const lines: string[] = [];
    const dec = new JsonlDecoder((l) => lines.push(l));
    dec.push('{"a":1}');
    dec.flush();
    expect(lines).toEqual(['{"a":1}']);
  });

  it("ignores empty lines", () => {
    const lines: string[] = [];
    const dec = new JsonlDecoder((l) => lines.push(l));
    dec.push("\n\n");
    expect(lines).toEqual([]);
  });
});

describe("splitJsonl", () => {
  it("splits and strips CR", () => {
    expect(splitJsonl('{"a":1}\r\n{"a":2}\r\n')).toEqual(['{"a":1}', '{"a":2}']);
  });
});

describe("encodeCommand", () => {
  it("produces a JSONL record", () => {
    expect(encodeCommand({ type: "abort" })).toBe('{"type":"abort"}\n');
  });
});
