#!/usr/bin/env node
import { main } from "./cli.js";

process.exitCode = await main(process.argv.slice(2), {
  out: console.log,
  err: console.error,
  env: process.env,
  cwd: process.cwd(),
});
