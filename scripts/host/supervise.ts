import { spawn } from "node:child_process";
/** Bounded output and lifetime for qualification children; kill the whole process group. */
export function supervise(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
    killGraceMs?: number;
    signal?: AbortSignal;
    maxOutputBytes?: number;
  },
) {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1) throw new Error("invalid child deadline");
  return new Promise<string>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("qualification interrupted"));
      return;
    }
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
      failure: string | undefined,
      escalation: ReturnType<typeof setTimeout> | undefined,
      finished = false;
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid)
        try {
          process.kill(-child.pid, signal);
        } catch {
          child.kill(signal);
        }
    };
    const terminate = (reason: string) => {
      if (failure) return;
      failure = reason;
      kill("SIGTERM");
      escalation = setTimeout(() => kill("SIGKILL"), options.killGraceMs ?? 15_000);
    };
    const abort = () => terminate("qualification interrupted"),
      timeout = setTimeout(() => terminate("qualification child deadline exceeded"), options.timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    const retain = (chunk: unknown) => {
      output = (output + String(chunk)).slice(-(options.maxOutputBytes ?? 1_000_000));
    };
    child.stdout.on("data", retain);
    child.stderr.on("data", retain);
    const finish = (error?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(new Error(`${error}${output ? `: ${output.slice(-4_000)}` : ""}`));
      else resolve(output);
    };
    child.once("error", () => finish("qualification child could not start"));
    child.once("close", (code, signal) =>
      finish(failure ?? (code === 0 ? undefined : `qualification child exited ${code ?? signal}`)),
    );
  });
}
