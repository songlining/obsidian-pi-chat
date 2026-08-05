import { describe, expect, it } from "vitest";
import { hasDiff, wordDiff } from "../src/diff";

function words(segments: { text: string; changed: boolean }[]): string {
  return segments.map((s) => s.text).join("");
}

describe("wordDiff", () => {
  it("marks nothing changed for identical text", () => {
    const d = wordDiff("hello world", "hello world");
    expect(d.old.every((t) => !t.changed)).toBe(true);
    expect(d.new.every((t) => !t.changed)).toBe(true);
    expect(hasDiff(d)).toBe(false);
    expect(words(d.old)).toBe("hello world");
  });

  it("detects a simple word replacement", () => {
    const d = wordDiff("the quick brown fox", "the quick blue fox");
    expect(hasDiff(d)).toBe(true);
    expect(d.old.filter((t) => t.changed).map((t) => t.text.trim())).toEqual(["brown"]);
    expect(d.new.filter((t) => t.changed).map((t) => t.text.trim())).toEqual(["blue"]);
  });

  it("detects insertions", () => {
    const d = wordDiff("quick fox", "quick brown fox");
    expect(hasDiff(d)).toBe(true);
    expect(d.old.filter((t) => t.changed)).toHaveLength(0);
    expect(d.new.filter((t) => t.changed).map((t) => t.text.trim())).toEqual(["brown"]);
  });

  it("detects deletions", () => {
    const d = wordDiff("quick brown fox", "quick fox");
    expect(hasDiff(d)).toBe(true);
    expect(d.old.filter((t) => t.changed).map((t) => t.text.trim())).toEqual(["brown"]);
    expect(d.new.filter((t) => t.changed)).toHaveLength(0);
  });

  it("handles multi-line text and preserves whitespace", () => {
    const d = wordDiff("line one\nline two", "line one\nline 2");
    expect(hasDiff(d)).toBe(true);
    expect(words(d.old)).toBe("line one\nline two");
    expect(words(d.new)).toBe("line one\nline 2");
  });

  it("handles a full rewrite", () => {
    const d = wordDiff("old content here", "brand new text entirely");
    expect(hasDiff(d)).toBe(true);
    expect(d.old.every((t) => t.changed)).toBe(true);
    expect(d.new.every((t) => t.changed)).toBe(true);
  });
});
