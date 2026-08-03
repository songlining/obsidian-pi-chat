import { describe, it, expect, beforeAll } from "vitest";
import { detectPi, getPiVersion } from "../src/env";

describe("detectPi", () => {
  let env: Awaited<ReturnType<typeof detectPi>>;

  beforeAll(async () => {
    env = await detectPi();
  }, 60000);

  it("finds a pi binary", () => {
    expect(env.binaryPath).not.toBeNull();
  });

  it("produces a PATH that includes node's directory (shebang requirement)", () => {
    const path = env.env.PATH ?? "";
    // The pi shebang is `#!/usr/bin/env node`; the spawned process must be
    // able to resolve `node`. Verify the key macOS node locations are present.
    expect(path).toMatch(/\/opt\/homebrew\/bin|\.bun\/bin|\.local\/bin/);
  });

  it("includes the login-shell environment", () => {
    // HOME should survive the env merge.
    expect(env.env.HOME).toBeTruthy();
    // PI_NO_STARTUP_LOGO must be set so pi doesn't print a startup banner.
    expect(env.env.PI_NO_STARTUP_LOGO).toBe("1");
  });

  it("spawns pi successfully with the resolved env (no exit 127)", async () => {
    if (!env.binaryPath) return;
    const { spawn } = await import("child_process");
    const result = await new Promise<{ ok: boolean; code: number | null; output: string }>((resolve) => {
      const child = spawn(env.binaryPath!, ["--mode", "rpc", "--no-session"], {
        cwd: "/tmp",
        env: env.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (d) => {
        output += d.toString();
        if (output.length > 50) {
          child.kill("SIGTERM");
          resolve({ ok: true, code: 0, output });
        }
      });
      child.on("exit", (code) => {
        if (!output) resolve({ ok: false, code, output: "" });
      });
      setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ ok: false, code: null, output });
      }, 15000);
    });
    expect(result.ok).toBe(true);
    expect(result.code).not.toBe(127);
  });
});

describe("getPiVersion", () => {
  it("returns a version string", async () => {
    const env = await detectPi();
    if (!env.binaryPath) return;
    const v = await getPiVersion(env.binaryPath, env.env);
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  }, 30000);
});
