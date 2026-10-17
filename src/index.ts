#!/usr/bin/env node
import { main, readStdin } from "./cli.js";

process.exitCode = await main(process.argv.slice(2), {
  out: console.log,
  err: console.error,
  stdin: () => readStdin(),
  env: process.env,
  cwd: process.cwd(),
});
