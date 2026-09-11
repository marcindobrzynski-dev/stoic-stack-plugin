// Temporary diagnostic sink: records the four directories that take part in
// choosing a project directory, one JSON line per hook invocation, so the
// cause of a project getting several engine identities can be observed in the
// field. Remove together with the project-root resolution fix.
import fs from "node:fs";
import path from "node:path";

import { debugLogPath } from "./paths.js";

function localTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

export function writePathDebug(paths, target = debugLogPath()) {
  try {
    const line = JSON.stringify({
      at: localTimestamp(),
      hook: paths.hook ?? null,
      session_id: paths.session_id ?? null,
      process_cwd: paths.process_cwd ?? null,
      payload_cwd: paths.payload_cwd ?? null,
      claude_project_dir: paths.claude_project_dir ?? null,
      selected_project_dir: paths.selected_project_dir ?? null,
    });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `${line}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}
