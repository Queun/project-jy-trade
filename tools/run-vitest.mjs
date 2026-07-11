import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitestEntry = resolve(projectRoot, "node_modules/vitest/vitest.mjs");
const child = spawn(process.execPath, [vitestEntry, "run", ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: { ...process.env, NODE_ENV: "test" },
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
