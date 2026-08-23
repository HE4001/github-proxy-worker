import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const projectDir = dirname(fileURLToPath(import.meta.url));
const workerPath = join(projectDir, "worker.js");
const frontendPath = join(projectDir, "frontend-home.js");
const worker = await readFile(workerPath, "utf8");
const frontend = (await readFile(frontendPath, "utf8")).trim();
const startMarker = "function generateHomePage(";
const endMarker = "function rootRouteResponse(";
const start = worker.indexOf(startMarker);
const end = worker.indexOf(endMarker, start);

if (start === -1 || end === -1 || end <= start) {
  throw new Error("Could not locate the homepage function in worker.js");
}

const integrated = worker.slice(0, start) + frontend + "\n\n" + worker.slice(end);
await writeFile(workerPath, integrated, "utf8");
console.log("Integrated frontend-home.js into worker.js");
