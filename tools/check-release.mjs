import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const forbiddenPathPatterns = [
  /^data\//,
  /^outputs\//,
  /^inputs\//,
  /^apps\/api\/inputs\//,
  /^ole案例文件——发货前\//,
  /^docs\/excel-schema-probe\.json$/,
  /^node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)\.env$/,
  /(^|\/)\.env\.(?!example$|production\.example$)[^/]+$/,
  /\.(db|db-shm|db-wal|db-journal|sqlite|sqlite-shm|sqlite-wal|sqlite-journal)$/i,
];

const requiredFiles = [
  ".env.production.example",
  "docs/deployment.md",
  "deploy/jy-trade-api.service.example",
  "deploy/nginx-jy-trade.conf.example",
];

function gitLines(args) {
  return execFileSync("git", args, { encoding: "utf8" })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replaceAll("\\", "/"));
}

function isForbidden(path) {
  return forbiddenPathPatterns.some((pattern) => pattern.test(path));
}

const tracked = gitLines(["ls-files"]);
const untracked = gitLines(["ls-files", "--others", "--exclude-standard"]);
const trackedForbidden = tracked.filter(isForbidden);
const untrackedForbidden = untracked.filter(isForbidden);
const missingRequired = requiredFiles.filter((path) => !existsSync(path));

if (trackedForbidden.length || untrackedForbidden.length || missingRequired.length) {
  console.error("Release check failed.");
  if (trackedForbidden.length) {
    console.error("\nTracked runtime/private files must be removed from Git:");
    for (const path of trackedForbidden) console.error(`- ${path}`);
  }
  if (untrackedForbidden.length) {
    console.error("\nRuntime/private files are not ignored correctly:");
    for (const path of untrackedForbidden) console.error(`- ${path}`);
  }
  if (missingRequired.length) {
    console.error("\nRequired deployment files are missing:");
    for (const path of missingRequired) console.error(`- ${path}`);
  }
  process.exit(1);
}

console.log("Release check passed: no tracked runtime data, private env files, or database files.");
