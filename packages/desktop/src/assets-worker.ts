/** Runs the asset extractor off the main thread so the viewer stays responsive. */
import { parentPort, workerData } from "node:worker_threads";
import { buildAssets } from "@tb/assets";

const { instance, clientJar, out } = workerData as { instance: string; clientJar: string; out: string };
try {
  const r = buildAssets({ instance, clientJar, out, progress: (msg, done, total) => parentPort!.postMessage({ type: "progress", msg, done, total }) });
  parentPort!.postMessage({ type: "done", ...r });
} catch (e) {
  parentPort!.postMessage({ type: "error", message: e instanceof Error ? e.message : String(e) });
}
