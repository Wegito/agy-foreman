import { execFile as execFileCb } from "node:child_process";

export interface KillDeps {
  platform: NodeJS.Platform;
  execFile: (file: string, args: string[]) => Promise<void>;
  processKill: (pid: number, signal: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: KillDeps = {
  platform: process.platform,
  execFile: (file, args) =>
    new Promise((resolve, reject) =>
      execFileCb(file, args, { windowsHide: true }, (err) => (err ? reject(err) : resolve())),
    ),
  processKill: (pid, signal) => process.kill(pid, signal),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Spawn options that make killTree able to reach the whole tree. */
export function treeSpawnOptions(platform: NodeJS.Platform = process.platform): {
  detached: boolean;
  windowsHide: true;
} {
  // POSIX: detached puts the child in its own process group so kill(-pid) reaches grandchildren.
  // Windows: taskkill /T walks the tree; detached would open a new console, so keep it off.
  return { detached: platform !== "win32", windowsHide: true };
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function killTree(
  pid: number,
  opts: { graceMs?: number; deps?: Partial<KillDeps> } = {},
): Promise<void> {
  const d: KillDeps = { ...defaultDeps, ...opts.deps };
  if (d.platform === "win32") {
    try {
      await d.execFile("taskkill", ["/PID", String(pid), "/T", "/F"]);
    } catch {
      // Already exited, or access denied for an exited tree: nothing left to kill.
    }
    return;
  }
  const signalGroup = (sig: NodeJS.Signals): boolean => {
    try {
      d.processKill(-pid, sig);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw e;
    }
  };
  if (!signalGroup("SIGTERM")) return;
  await d.sleep(opts.graceMs ?? 3000);
  signalGroup("SIGKILL");
}
