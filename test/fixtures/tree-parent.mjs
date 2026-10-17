import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const pidFile = process.argv[2];
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(pidFile, String(child.pid));
setInterval(() => {}, 1000);
