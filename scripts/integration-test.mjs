#!/usr/bin/env node
/**
 * Integration test: spawn the real local `pi --mode rpc` and drive a scripted
 * prompt, asserting the event flow matches the protocol assumptions in the
 * plugin (JSONL framing, command/response correlation, event stream).
 *
 * Run: npm run test:integration
 * Exits 0 on success, 1 on failure.
 */
import { spawn, execFileSync } from "child_process";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";

const verbose = process.argv.includes("--verbose");
const log = (...args) => {
  if (verbose) console.log("[it]", ...args);
};

function detectPiBinary() {
  try {
    const out = execFileSync(process.env.SHELL || "/bin/zsh", ["-lic", "which pi"], {
      encoding: "utf8",
      timeout: 15000,
    });
    const path = out.trim().split("\n").pop();
    if (path && path.startsWith("/")) return path;
  } catch {
    /* fall through */
  }
  for (const p of [join(homedir(), ".bun/bin/pi"), join(homedir(), ".local/bin/pi")]) {
    if (existsSync(p)) return p;
  }
  return null;
}

function main() {
  const binary = detectPiBinary();
  if (!binary) {
    console.error("✗ pi binary not found");
    process.exit(1);
  }
  log(`using pi at ${binary}`);

  const workdir = mkdtempSync(join(tmpdir(), "pi-rpc-it-"));
  const proc = spawn(binary, ["--mode", "rpc", "--no-session"], {
    cwd: workdir,
    env: { ...process.env, PI_NO_STARTUP_LOGO: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d.toString()));

  // Strict JSONL framing (LF only), exactly like src/jsonl.ts.
  let buffer = "";
  const pending = new Map();
  const eventLog = [];
  let reqSeq = 0;
  let settleTimeout = null;

  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim().length === 0) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        console.error("✗ malformed JSONL line:", line.slice(0, 120));
        proc.kill("SIGKILL");
        process.exit(1);
      }
      if (rec.type === "response") {
        const p = pending.get(rec.id);
        if (p) {
          pending.delete(rec.id);
          if (rec.success) p.resolve(rec);
          else p.reject(new Error(`${rec.command}: ${rec.error}`));
        }
      } else {
        eventLog.push(rec.type);
        if (rec.type === "agent_settled" && settleTimeout) {
          clearTimeout(settleTimeout);
          settleTimeout = null;
          checkDone();
        }
      }
    }
  });

  function send(cmd) {
    const id = `it${++reqSeq}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      proc.stdin.write(JSON.stringify({ ...cmd, id }) + "\n");
    });
  }

  const started = Date.now();
  let finished = false;
  const failures = [];

  function checkDone() {
    if (finished) return;
    finished = true;
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    log(`events: ${eventLog.join(", ")}`);
    proc.kill("SIGTERM");
    setTimeout(() => {
      rmSync(workdir, { recursive: true, force: true });
      if (failures.length === 0) {
        console.log(`✓ integration OK (${elapsed}s)`);
        process.exit(0);
      } else {
        console.error("✗ integration FAILED:");
        for (const f of failures) console.error("  -", f);
        process.exit(1);
      }
    }, 300);
  }

  (async () => {
    try {
      // 1. Handshake: get_state
      const state = await send({ type: "get_state" });
      if (!state.data?.sessionId) failures.push("get_state missing sessionId");
      log("get_state ok");

      // 2. Prompt a trivial request
      const promptP = send({ type: "prompt", message: "Reply with exactly: INTEGRATION_OK" });
      await new Promise((resolve) => {
        settleTimeout = setTimeout(resolve, 180000);
      });
      await promptP.catch(() => {});

      // 3. Assertions on the event stream
      const types = new Set(eventLog);
      if (!types.has("agent_start")) failures.push("no agent_start event");
      if (!types.has("message_start")) failures.push("no message_start event");
      if (!types.has("message_update")) failures.push("no message_update event");
      if (!types.has("agent_settled")) failures.push("no agent_settled event");
      if (types.has("extension_error")) failures.push("extension_error emitted");

      // 4. get_messages round-trip and content check
      const msgs = await send({ type: "get_messages" }).catch(() => ({ data: { messages: [] } }));
      if (Array.isArray(msgs?.data?.messages) && msgs.data.messages.length > 0) {
        const last = msgs.data.messages[msgs.data.messages.length - 1];
        if (last.role === "assistant") {
          const text = (last.content || [])
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join(" ");
          if (!text.includes("INTEGRATION_OK")) {
            failures.push(`assistant reply did not contain INTEGRATION_OK (got: ${text.slice(0, 80)})`);
          } else {
            log("reply verified");
          }
        }
      } else {
        failures.push("get_messages returned no messages");
      }

      // 5. abort command accepted
      await send({ type: "abort" }).catch(() => {});
      log("abort ok");

      checkDone();
    } catch (err) {
      console.error("✗ integration error:", err.message);
      console.error("  stderr:", stderr.slice(0, 500));
      proc.kill("SIGKILL");
      rmSync(workdir, { recursive: true, force: true });
      process.exit(1);
    }
  })();
}

main();
