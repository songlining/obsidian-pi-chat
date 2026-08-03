/**
 * PiSession — a thin wrapper around one `pi --mode rpc` subprocess.
 *
 * Owns the process, the strict JSONL framing on stdout, and the command
 * plumbing. Events are dispatched to an `onEvent` handler; commands return
 * promises that resolve with their correlated `response` record (or reject
 * with `success: false`).
 */
import { spawn, type ChildProcess } from "child_process";
import { JsonlDecoder, encodeCommand } from "./jsonl";
import type { RpcCommand, RpcEvent, RpcOutput, RpcResponse } from "./types";

export interface PiSessionOptions {
  /** Absolute path to the pi binary. */
  binaryPath: string;
  /** Working directory for the subprocess (vault root). */
  cwd: string;
  /** Full environment for the subprocess. */
  env: Record<string, string>;
  /**
   * Spawn-time session selection as already-split CLI args:
   *  - undefined            -> fresh session
   *  - `["-c"]`            -> continue latest
   *  - `["--session", path]` -> resume a specific session (path may contain spaces)
   */
  sessionArg?: string[];
  /** Extra CLI args from settings (escape hatch). */
  extraArgs?: string[];
  /** Optional initial display name (-n). */
  name?: string;
  onEvent: (event: RpcEvent) => void;
  onStderr?: (line: string) => void;
  onExit: (code: number | null, signal: string | null) => void;
}

export class PiSession {
  readonly cwd: string;
  private proc: ChildProcess | null = null;
  private decoder = new JsonlDecoder((line) => this.handleLine(line));
  private pending = new Map<string, { resolve: (r: RpcResponse) => void; reject: (e: Error) => void }>();
  private reqSeq = 0;
  private stderrTail: string[] = [];
  private started = false;
  private exitHandler: ((code: number | null, signal: string | null) => void) | null = null;
  private opts: PiSessionOptions;

  /** Cached version string from the handshake (may be empty). */
  version = "";

  constructor(opts: PiSessionOptions) {
    this.opts = opts;
    this.cwd = opts.cwd;
  }

  get isAlive(): boolean {
    return this.proc !== null && this.proc.exitCode === null && this.proc.signalCode === null;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  /** Spawn the subprocess and begin the get_state handshake. */
  start(): void {
    if (this.started) return;
    this.started = true;

    const args = ["--mode", "rpc"];
    if (this.opts.sessionArg) args.push(...this.opts.sessionArg);
    if (this.opts.name) args.push("--name", this.opts.name);
    if (this.opts.extraArgs) args.push(...this.opts.extraArgs);

    const proc = spawn(this.opts.binaryPath, args, {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc = proc;

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.decoder.push(chunk));
    proc.stdout.on("end", () => this.decoder.flush());

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim()) {
          this.stderrTail.push(line);
          if (this.stderrTail.length > 30) this.stderrTail.shift();
          this.opts.onStderr?.(line);
        }
      }
    });

    this.exitHandler = (code, signal) => {
      this.proc = null;
      this.opts.onExit(code, signal);
    };
    proc.on("exit", this.exitHandler);
    proc.on("error", (err) => {
      this.stderrTail.push(`spawn error: ${err.message}`);
      this.opts.onStderr?.(`spawn error: ${err.message}`);
      // Treat spawn failure as exit with code -1 (no process).
      if (this.exitHandler) this.exitHandler(-1, null);
    });
  }

  /**
   * Send a command. Resolves with the correlated response. If the command has
   * no `id`, it is fire-and-forget (still returns a promise that resolves when
   * the line is written, or rejects if the process is dead).
   */
  send(command: RpcCommand): Promise<RpcResponse> {
    const proc = this.proc;
    const stdin = proc?.stdin;
    if (!proc || proc.exitCode !== null || !stdin) {
      return Promise.reject(new Error("Pi process is not running."));
    }
    const id = command.id ?? `req${++this.reqSeq}`;
    const cmd: RpcCommand = { ...command, id };
    const promise = new Promise<RpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      stdin.write(encodeCommand(cmd), (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
    return promise;
  }

  /** Fire-and-forget event emission (extension_ui_response etc). */
  sendRaw(command: RpcCommand): void {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null || !proc.stdin) return;
    proc.stdin.write(encodeCommand(command));
  }

  private handleLine(line: string): void {
    let record: RpcOutput;
    try {
      record = JSON.parse(line) as RpcOutput;
    } catch (err) {
      // Malformed line: log and skip (forward-compatible).
      console.warn("[pi-chat] malformed RPC line:", line.slice(0, 200), err);
      return;
    }

    if (record.type === "response") {
      const resp = record as RpcResponse;
      if (resp.id && this.pending.has(resp.id)) {
        const { resolve, reject } = this.pending.get(resp.id)!;
        this.pending.delete(resp.id);
        if (resp.success) resolve(resp);
        else reject(new Error(resp.error ?? `Command ${resp.command} failed`));
      }
      return;
    }

    if (record.type === "extension_ui_request" && !("method" in record)) {
      console.warn("[pi-chat] unknown record:", line.slice(0, 200));
      return;
    }

    this.opts.onEvent(record as RpcEvent);
  }

  /** Send SIGTERM (pi flushes its session file on exit). */
  stop(): void {
    if (this.proc && this.proc.exitCode === null) {
      try {
        this.proc.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }

  /** Force kill if SIGTERM didn't land within the timeout. */
  kill(graceMs = 1500): void {
    if (this.proc && this.proc.exitCode === null) {
      this.stop();
      const proc = this.proc;
      setTimeout(() => {
        if (proc.exitCode === null) {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }
      }, graceMs);
    }
  }
}
