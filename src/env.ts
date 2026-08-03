/**
 * Zero-config binary discovery + login-shell environment capture.
 *
 * The Obsidian GUI app does not inherit the user's login-shell PATH (so
 * `~/.bun/bin/pi` is missing). We resolve `pi` once by asking the user's
 * login shell, and capture that shell's environment so `~/.pi` auth,
 * `PI_*` variables and env-based provider keys behave exactly as in the
 * terminal. The plugin never stores or requests API keys.
 *
 * Robustness notes:
 *  - `pi` is a `#!/usr/bin/env node` script. The spawned process MUST have
 *    `node`'s directory on PATH or it exits 127 (`env: node: No such file
 *    or directory`). We therefore resolve `node` alongside `pi` and always
 *    prepend both directories to the child PATH.
 *  - The login-shell `execFile` can hang if grandchildren keep stdout open;
 *    we use a process-group kill and an absolute fallback timer so the
 *    detection promise ALWAYS resolves.
 */
import { execFile, spawn, type ChildProcess } from "child_process";
import { homedir } from "os";
import { join, dirname } from "path";
import { existsSync } from "fs";

const DEFAULTS = {
  candidates: [
    (home: string) => join(home, ".bun", "bin", "pi"),
    (home: string) => join(home, ".local", "bin", "pi"),
    (home: string) => join(home, "bin", "pi"),
  ],
  nodeCandidates: [
    (home: string) => join(home, ".bun", "bin", "node"),
    (home: string) => "/opt/homebrew/bin/node",
    (home: string) => "/usr/local/bin/node",
    (home: string) => join(home, ".nvm", "versions"),
  ],
};

export interface PiEnvironment {
  /** Absolute path to the pi binary, or null if not found. */
  binaryPath: string | null;
  /** `pi --version` output (trimmed). */
  version: string | null;
  /** Full environment for the subprocess (login-shell env wins). */
  env: Record<string, string>;
  /** Human-readable diagnostic for the setup notice. */
  diagnostics: string[];
}

interface ShellResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/**
 * Run a command in the login shell with a hard cap. Uses a detached process
 * group so the whole tree (shell + grandchildren) can be killed on timeout,
 * guaranteeing the promise always resolves.
 */
function runShell(
  shell: string,
  script: string,
  timeoutMs = 30000,
  env?: Record<string, string>,
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn(shell, ["-lic", script], {
      timeout: timeoutMs,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: env ?? { ...process.env, PI_NO_STARTUP_LOGO: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardStop);
      resolve({ stdout, stderr, code, timedOut });
    };

    child.stdout.on("data", (d: Buffer | string) => {
      stdout += d.toString();
      if (stdout.length > 16 * 1024 * 1024) child.kill("SIGKILL");
    });
    child.stderr.on("data", (d: Buffer | string) => {
      stderr += d.toString();
    });
    child.on("error", (err: Error) => {
      stderr += `spawn error: ${err.message}`;
      finish(null);
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (signal === "SIGTERM" || signal === "SIGKILL") timedOut = true;
      finish(code);
    });
    child.on("exit", (code: number | null) => finish(code));

    const hardStop = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* ignore */
      }
      try {
        if (child.pid) child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      finish(null);
    }, timeoutMs + 8000);
  });
}

function parseEnvOutput(output: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    // Skip variables that don't make sense to inherit into a long-lived child
    // (shell cwd, prompt internals, session ids).
    if (/^(SHLVL|PWD|OLDPWD|_|PPID|RANDOM|SECONDS|LINENO)$/.test(key)) continue;
    env[key] = value;
  }
  return env;
}

/** Coerce a NodeJS.ProcessEnv (values may be undefined) into a string record. */
function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function findExecutable(possibilities: string[]): string | null {
  for (const p of possibilities) {
    if (!p) continue;
    const expanded = p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
    if (expanded.startsWith("$")) continue; // unexpanded shell var — skip
    if (existsSync(expanded)) return expanded;
  }
  return null;
}

function findInPath(program: string, path: string): string | null {
  for (const dir of path.split(":")) {
    if (!dir) continue;
    const p = join(dir, program);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Detect the pi binary and capture the login environment.
 * `override` (from settings) bypasses detection entirely.
 */
export async function detectPi(override?: string): Promise<PiEnvironment> {
  const diagnostics: string[] = [];
  const shell = process.env.SHELL || "/bin/zsh";
  const home = homedir();

  if (override && override.trim().length > 0) {
    const p = override.trim();
    diagnostics.push(`Using configured pi path: ${p}`);
    return { binaryPath: p, version: null, env: ensureNodeOnPath(stringEnv(process.env)), diagnostics };
  }

  // Single shell invocation: resolve `pi`, `node`, and dump the environment.
  const { stdout, timedOut } = await runShell(shell, "which pi; which node; env");
  if (timedOut) diagnostics.push("Login-shell detection timed out; falling back to PATH probes.");

  const lines = stdout.split("\n");
  const pathLines: string[] = [];
  let envText: string[] = [];
  let pastWhich = false;
  for (const line of lines) {
    if (!pastWhich) {
      if (line.trim().length === 0) {
        pastWhich = true;
        continue;
      }
      if (line.startsWith("/") || line.startsWith("~/")) {
        pathLines.push(line.trim());
      } else if (line.includes("=")) {
        pastWhich = true;
        envText.push(line);
      }
    } else {
      envText.push(line);
    }
  }

  // First path line is `pi`, second is `node` (in that order from our script).
  let piPath: string | null = null;
  let nodePath: string | null = null;
  for (const line of pathLines) {
    const expanded = line.startsWith("~/") ? join(home, line.slice(2)) : line;
    if (!piPath && existsSync(expanded) && basenameIs(expanded, "pi")) {
      piPath = expanded;
    } else if (!nodePath && existsSync(expanded) && basenameIs(expanded, "node")) {
      nodePath = expanded;
    }
  }

  // Fallbacks if the shell lookup didn't resolve either.
  if (!piPath) {
    piPath = findExecutable(DEFAULTS.candidates.map((c) => c(home)));
    if (piPath) diagnostics.push(`Fallback: found pi at ${piPath}`);
  }
  if (!nodePath) {
    nodePath = findInPath("node", process.env.PATH ?? "") ?? findExecutable(["/opt/homebrew/bin/node", "/usr/local/bin/node"]);
    if (nodePath) diagnostics.push(`Fallback: found node at ${nodePath}`);
  }

  if (!piPath) {
    diagnostics.push(
      `Could not locate the pi binary. Ran: ${shell} -lic 'which pi; which node; env'. ` +
        `Set a manual path in the plugin settings.`,
    );
  }

  const shellEnv = parseEnvOutput(envText.join("\n"));
  const env = { ...stringEnv(process.env), ...shellEnv };
  env.PI_NO_STARTUP_LOGO = "1";

  // --- Guarantee node (and pi) directories are on PATH ---
  // pi is `#!/usr/bin/env node`; without node's dir the child exits 127.
  const dirsToPrepend: string[] = [];
  if (piPath) dirsToPrepend.push(dirname(piPath));
  if (nodePath) dirsToPrepend.push(dirname(nodePath));
  // Ensure homebrew (common for node on macOS) is present even if the shell
  // env was captured empty.
  dirsToPrepend.push("/opt/homebrew/bin", "/usr/local/bin", join(home, ".bun", "bin"));

  const existingPath = (env.PATH ?? "").split(":").filter(Boolean);
  const prepend = dirsToPrepend.filter((d) => !existingPath.includes(d));
  env.PATH = [...prepend, ...existingPath].join(":") || "/usr/bin:/bin:/usr/sbin:/sbin";

  return { binaryPath: piPath, version: null, env, diagnostics };
}

function basenameIs(p: string, name: string): boolean {
  return p.slice(p.lastIndexOf("/") + 1) === name;
}

/** Ensure a path set at least has a node candidate (override path case). */
function ensureNodeOnPath(env: Record<string, string>): Record<string, string> {
  const path = (env.PATH ?? "").split(":").filter(Boolean);
  const home = homedir();
  for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", join(home, ".bun", "bin")]) {
    if (!path.includes(dir)) path.push(dir);
  }
  return { ...env, PATH: path.join(":") || "/usr/bin:/bin:/usr/sbin:/sbin" };
}

/** Run `pi --version` once to log version drift diagnostics. */
export async function getPiVersion(binaryPath: string, env: Record<string, string>): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(binaryPath, ["--version"], {
      timeout: 10000,
      env,
      windowsHide: true,
    }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(String(stdout).trim().split("\n").pop() ?? null);
    });
  });
}
