/**
 * Zero-config binary discovery + login-shell environment capture.
 *
 * The Obsidian GUI app does not inherit the user's login-shell PATH (so
 * `~/.bun/bin/pi` is missing). We resolve `pi` once by asking the user's
 * login shell, and capture that shell's environment so `~/.pi` auth,
 * `PI_*` variables and env-based provider keys behave exactly as in the
 * terminal. The plugin never stores or requests API keys.
 */
import { execFile } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { existsSync } from "fs";

const DEFAULTS = {
  // Known install locations, tried in order after the login shell lookup.
  candidates: [
    (home: string) => join(home, ".bun", "bin", "pi"),
    (home: string) => join(home, ".local", "bin", "pi"),
    (home: string) => join(home, "bin", "pi"),
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

function runShell(
  shell: string,
  script: string,
  timeoutMs = 15000,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    execFile(
      shell,
      ["-lic", script],
      {
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, PI_NO_STARTUP_LOGO: "1" },
      },
      (err, stdout, stderr) => {
        const code = err ? ((err as NodeJS.ErrnoException).code as unknown as number) ?? 1 : 0;
        // execFile sets err.code to the exit code number for non-zero exits.
        const exitCode =
          typeof (err as { code?: unknown })?.code === "number"
            ? ((err as { code: number }).code as number)
            : code;
        resolve({ stdout: String(stdout), stderr: String(stderr), code: exitCode });
      },
    );
  });
}

/** Coerce a NodeJS.ProcessEnv (values may be undefined) into a string record. */
function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
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

/**
 * Detect the pi binary and capture the login environment.
 * `override` (from settings) bypasses detection entirely.
 */
export async function detectPi(override?: string): Promise<PiEnvironment> {
  const diagnostics: string[] = [];
  const shell = process.env.SHELL || "/bin/zsh";

  if (override && override.trim().length > 0) {
    const p = override.trim();
    diagnostics.push(`Using configured pi path: ${p}`);
    return {
      binaryPath: p,
      version: null,
      env: stringEnv(process.env),
      diagnostics,
    };
  }

  // Single shell invocation: `which pi` first, then dump the environment.
  const { stdout } = await runShell(shell, "which pi; env");

  const lines = stdout.split("\n");
  const whichLines: string[] = [];
  let envText: string[] = [];
  let pastWhich = false;
  for (const line of lines) {
    if (!pastWhich) {
      if (line.trim().length === 0) {
        pastWhich = true;
        continue;
      }
      // `which` may emit one path per line.
      if (line.startsWith("/") || line.startsWith("~/") || line.startsWith("$")) {
        whichLines.push(line.trim());
      } else if (line.includes("=")) {
        // No `which` output at all; env started immediately.
        pastWhich = true;
        envText.push(line);
      }
    } else {
      envText.push(line);
    }
  }

  let binary: string | null = null;
  for (const line of whichLines) {
    if (line.length > 0) {
      const expanded = line.startsWith("~/") ? join(homedir(), line.slice(2)) : line;
      if (existsSync(expanded)) {
        binary = expanded;
        break;
      }
    }
  }

  // Fallback: check known install locations directly.
  if (!binary) {
    const home = homedir();
    for (const candidate of DEFAULTS.candidates) {
      const p = candidate(home);
      if (existsSync(p)) {
        binary = p;
        diagnostics.push(`Fallback: found pi at ${p}`);
        break;
      }
    }
  }

  // Last resort: PATH lookup without login shell.
  if (!binary) {
    for (const dir of (process.env.PATH ?? "").split(":")) {
      if (!dir) continue;
      const p = join(dir, "pi");
      if (existsSync(p)) {
        binary = p;
        diagnostics.push(`Fallback: found pi in PATH at ${p}`);
        break;
      }
    }
  }

  if (!binary) {
    diagnostics.push(
      `Could not locate the pi binary. Ran: ${shell} -lic 'which pi; env' (no output). ` +
        `Set a manual path in the plugin settings.`,
    );
  }

  const shellEnv = parseEnvOutput(envText.join("\n"));
  const env = { ...stringEnv(process.env), ...shellEnv };
  // Ensure PATH includes the binary's own dir so spawned tools resolve it.
  if (binary) {
    const binDir = binary.includes("/") ? binary.slice(0, binary.lastIndexOf("/")) : "";
    if (binDir && !(env.PATH ?? "").split(":").includes(binDir)) {
      env.PATH = `${binDir}:${env.PATH ?? ""}`;
    }
  }
  env.PI_NO_STARTUP_LOGO = "1";

  return { binaryPath: binary, version: null, env, diagnostics };
}

/** Run `pi --version` once to log version drift diagnostics. */
export async function getPiVersion(binaryPath: string, env: Record<string, string>): Promise<string | null> {
  try {
    const { stdout } = await runShell(binaryPath, "--version", 10000);
    return stdout.trim().split("\n").pop() ?? null;
  } catch {
    return null;
  }
}
