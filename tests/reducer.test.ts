import { describe, it, expect } from "vitest";
import { initialState, reduce, messagesToUi, toolArgsSummary, type UiState } from "../src/reducer";
import type { AgentMessage, RpcEvent } from "../src/types";

function event(e: RpcEvent) {
  return reduce(initialState(), { type: "rpc", event: e });
}

describe("reducer: user messages", () => {
  it("adds optimistic user bubble then confirms it via message_start", () => {
    let s: UiState = initialState();
    s = reduce(s, { type: "user_message", text: "hello" });
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].kind).toBe("user");
    expect(s.messages[0].pending).toBe(true);

    s = reduce(s, {
      type: "rpc",
      event: {
        type: "message_start",
        message: { role: "user", content: "hello", timestamp: 123 },
      },
    });
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].pending).toBe(false);
    expect(s.messages[0].timestamp).toBe(123);
  });

  it("appends a second user message if text differs", () => {
    let s: UiState = initialState();
    s = reduce(s, { type: "user_message", text: "one" });
    s = reduce(s, {
      type: "rpc",
      event: {
        type: "message_start",
        message: { role: "user", content: "different text", timestamp: 1 },
      },
    });
    expect(s.messages).toHaveLength(2);
    expect(s.messages[1].text).toBe("different text");
    expect(s.messages[1].pending).toBeUndefined();
  });
});

describe("reducer: assistant streaming", () => {
  it("streams text deltas through message_update and finalizes on message_end", () => {
    let s: UiState = initialState();
    s = reduce(s, {
      type: "rpc",
      event: {
        type: "message_start",
        message: {
          role: "assistant",
          content: [],
          api: "a",
          provider: "p",
          model: "m",
          stopReason: "stop",
          timestamp: 1,
        },
      },
    });
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].streaming).toBe(true);

    s = reduce(s, {
      type: "rpc",
      event: {
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hel" }],
          api: "a",
          provider: "p",
          model: "m",
          stopReason: "stop",
          timestamp: 1,
        },
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" },
      },
    });
    s = reduce(s, {
      type: "rpc",
      event: {
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello world" }],
          api: "a",
          provider: "p",
          model: "m",
          stopReason: "stop",
          timestamp: 1,
        },
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo world" },
      },
    });
    expect(s.messages[0].text).toBe("Hello world");
    expect(s.isStreaming).toBe(true);

    s = reduce(s, {
      type: "rpc",
      event: {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello world" }],
          api: "a",
          provider: "p",
          model: "m",
          stopReason: "stop",
          timestamp: 1,
        },
      },
    });
    expect(s.messages[0].streaming).toBe(false);
    expect(s.messages[0].stopReason).toBe("stop");
    expect(s.isStreaming).toBe(false);
  });

  it("renders thinking blocks collapsed but captured", () => {
    let s: UiState = initialState();
    s = reduce(s, {
      type: "rpc",
      event: {
        type: "message_update",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let me think" },
            { type: "text", text: "Answer" },
          ],
          api: "a",
          provider: "p",
          model: "m",
          stopReason: "stop",
          timestamp: 1,
        },
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Let me think" },
      },
    });
    expect(s.messages[0].thinking).toBe("Let me think");
    expect(s.messages[0].text).toBe("Answer");
  });
});

describe("reducer: tool calls", () => {
  it("tracks tool execution lifecycle and correlates by toolCallId", () => {
    let s: UiState = initialState();
    s = reduce(s, {
      type: "rpc",
      event: {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_1",
              name: "bash",
              arguments: { command: "ls -la" },
            },
          ],
          api: "a",
          provider: "p",
          model: "m",
          stopReason: "toolUse",
          timestamp: 1,
        },
      },
    });
    expect(s.messages[0].toolCalls).toHaveLength(1);
    expect(s.messages[0].toolCalls![0].argsSummary).toBe("ls -la");

    s = reduce(s, {
      type: "rpc",
      event: {
        type: "tool_execution_start",
        toolCallId: "call_1",
        toolName: "bash",
        args: { command: "ls -la" },
      },
    });
    expect(s.messages[0].toolCalls![0].status).toBe("running");

    s = reduce(s, {
      type: "rpc",
      event: {
        type: "tool_execution_update",
        toolCallId: "call_1",
        toolName: "bash",
        args: { command: "ls -la" },
        partialResult: { content: [{ type: "text", text: "total 4\n" }] },
      },
    });
    s = reduce(s, {
      type: "rpc",
      event: {
        type: "tool_execution_update",
        toolCallId: "call_1",
        toolName: "bash",
        args: { command: "ls -la" },
        partialResult: { content: [{ type: "text", text: "drwxr-xr-x .\n" }] },
      },
    });
    expect(s.messages[0].toolCalls![0].output).toBe("total 4\ndrwxr-xr-x .\n");

    s = reduce(s, {
      type: "rpc",
      event: {
        type: "tool_execution_end",
        toolCallId: "call_1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "total 4\n" }] },
        isError: false,
      },
    });
    expect(s.messages[0].toolCalls![0].status).toBe("success");
    expect(s.messages[0].toolCalls![0].result).toBe("total 4\n");
  });

  it("marks error tools", () => {
    let s: UiState = initialState();
    s = reduce(s, {
      type: "rpc",
      event: {
        type: "tool_execution_start",
        toolCallId: "c2",
        toolName: "bash",
        args: { command: "false" },
      },
    });
    s = reduce(s, {
      type: "rpc",
      event: {
        type: "tool_execution_end",
        toolCallId: "c2",
        toolName: "bash",
        result: { content: [{ type: "text", text: "exit 1" }] },
        isError: true,
      },
    });
    expect(s.messages[0].kind).toBe("tool");
    expect(s.messages[0].toolCalls![0].status).toBe("error");
  });
});

describe("reducer: agent lifecycle", () => {
  it("tracks running state through agent_start/end/settled", () => {
    let s: UiState = initialState();
    s = reduce(s, { type: "rpc", event: { type: "agent_start" } });
    expect(s.isRunning).toBe(true);
    s = reduce(s, { type: "rpc", event: { type: "agent_end", messages: [], willRetry: false } });
    expect(s.isRunning).toBe(false);
    s = reduce(s, { type: "rpc", event: { type: "agent_settled" } });
    expect(s.isRunning).toBe(false);
  });

  it("keeps running when agent_end says willRetry", () => {
    let s: UiState = initialState();
    s = reduce(s, { type: "rpc", event: { type: "agent_start" } });
    s = reduce(s, { type: "rpc", event: { type: "agent_end", messages: [], willRetry: true } });
    expect(s.isRunning).toBe(true);
  });

  it("shows retry info on auto_retry_start and clears on end", () => {
    let s: UiState = initialState();
    s = reduce(s, {
      type: "rpc",
      event: {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 1000,
        errorMessage: "529 overloaded",
      },
    });
    expect(s.autoRetry).toMatchObject({ attempt: 1, maxAttempts: 3 });
    s = reduce(s, { type: "rpc", event: { type: "auto_retry_end", success: true, attempt: 2 } });
    expect(s.autoRetry).toBeNull();
  });
});

describe("reducer: extension UI", () => {
  it("queues dialog requests and answers them", () => {
    let s: UiState = initialState();
    const selectReq = {
      type: "extension_ui_request" as const,
      id: "r1",
      method: "select" as const,
      title: "Pick one",
      options: ["A", "B"],
    };
    s = reduce(s, { type: "rpc", event: selectReq });
    expect(s.extensionRequests).toHaveLength(1);

    const notifyReq = {
      type: "extension_ui_request" as const,
      id: "r2",
      method: "notify" as const,
      message: "done",
    };
    s = reduce(s, { type: "rpc", event: notifyReq });
    // Fire-and-forget requests never enter the pending dialog list.
    expect(s.extensionRequests).toHaveLength(1);

    s = reduce(s, { type: "extension_ui_answered", id: "r1" });
    expect(s.extensionRequests).toHaveLength(0);
  });
});

describe("reducer: session state and errors", () => {
  it("applies session_ready", () => {
    let s: UiState = initialState();
    s = reduce(s, {
      type: "session_ready",
      data: {
        model: null,
        thinkingLevel: "high",
        isStreaming: false,
        isCompacting: false,
        steeringMode: "all",
        followUpMode: "one-at-a-time",
        sessionName: "my-work",
        sessionId: "abc",
        sessionFile: "/tmp/s.jsonl",
        autoCompactionEnabled: true,
        messageCount: 0,
        pendingMessageCount: 0,
      },
    });
    expect(s.phase).toBe("ready");
    expect(s.sessionName).toBe("my-work");
    expect(s.thinkingLevel).toBe("high");
  });

  it("records fatal errors and stderr tail", () => {
    let s: UiState = initialState();
    s = reduce(s, {
      type: "session_error",
      message: "pi not found",
      stderr: ["line1", "line2"],
    });
    expect(s.phase).toBe("error");
    expect(s.error).toBe("pi not found");
    expect(s.stderr).toEqual(["line1", "line2"]);
  });
});

describe("toolArgsSummary", () => {
  it("prefers command, then path, then query", () => {
    expect(toolArgsSummary("bash", { command: "ls" })).toBe("ls");
    expect(toolArgsSummary("edit", { path: "src/main.ts" })).toBe("src/main.ts");
    expect(toolArgsSummary("grep", { query: "foo" })).toBe("foo");
  });
});

describe("messagesToUi (history on resume)", () => {
  const userMsg: AgentMessage = { role: "user", content: "Q1", timestamp: 1 };
  const assistantMsg: AgentMessage = {
    role: "assistant",
    content: [
      { type: "text", text: "A1" },
      { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
    ],
    api: "a",
    provider: "p",
    model: "m",
    stopReason: "toolUse",
    timestamp: 2,
  };
  const toolResult: AgentMessage = {
    role: "toolResult",
    toolCallId: "c1",
    toolName: "bash",
    content: [{ type: "text", text: "file1\n" }],
    isError: false,
    timestamp: 3,
  };

  it("maps user/assistant/toolResult into UI messages with results attached", () => {
    const ui = messagesToUi([userMsg, assistantMsg, toolResult]);
    expect(ui).toHaveLength(2);
    expect(ui[0]).toMatchObject({ kind: "user", text: "Q1" });
    expect(ui[1]).toMatchObject({ kind: "assistant", text: "A1" });
    const call = ui[1].toolCalls![0];
    expect(call).toMatchObject({ id: "c1", name: "bash", status: "success", result: "file1\n" });
  });

  it("maps bashExecution rows", () => {
    const bashMsg: AgentMessage = {
      role: "bashExecution",
      command: "ls",
      output: "a.txt",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 4,
    };
    const ui = messagesToUi([bashMsg]);
    expect(ui).toHaveLength(1);
    expect(ui[0].kind).toBe("tool");
    expect(ui[0].toolCalls![0]).toMatchObject({ name: "bash", argsSummary: "ls", status: "success" });
  });
});
