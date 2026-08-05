import { describe, expect, it } from "vitest";
import {
  conversationLabel,
  createConversationRecord,
  newConversationId,
  sortConversations,
} from "../src/conversation-store";

describe("conversation store", () => {
  it("generates unique conversation ids", () => {
    const a = newConversationId();
    const b = newConversationId();
    expect(a).toMatch(/^conv-/);
    expect(a).not.toBe(b);
  });

  it("creates fresh records with no session file", () => {
    const r = createConversationRecord("conv-test", "");
    expect(r.id).toBe("conv-test");
    expect(r.name).toBe("");
    expect(r.sessionFile).toBeNull();
    expect(r.createdAt).toBeGreaterThan(0);
    expect(r.updatedAt).toBe(r.createdAt);
  });

  it("labels unnamed conversations", () => {
    const r = createConversationRecord("conv-test", "");
    expect(conversationLabel(r)).toBe("Unnamed conversation");
    r.name = "Task-A";
    expect(conversationLabel(r)).toBe("Task-A");
  });

  it("sorts newest first", () => {
    const a = createConversationRecord("a", "older");
    a.updatedAt = 100;
    const b = createConversationRecord("b", "newer");
    b.updatedAt = 200;
    const c = createConversationRecord("c", "middle");
    c.updatedAt = 150;
    expect(sortConversations([a, b, c]).map((r) => r.id)).toEqual(["b", "c", "a"]);
  });
});
