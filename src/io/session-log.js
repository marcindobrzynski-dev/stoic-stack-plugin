// The per-session event log — the observation pipeline's hand-off point.
//
// Capture hooks append one JSON line per observed event during the turn; the
// Stop hook reads the accumulated events, scores the turn, and truncates the
// log so the next turn starts empty. The log lives under the personal-state
// directory, outside the repository, one file per session id.
//
// Read and truncate are two separate calls, not one atomic take: this module
// offers no snapshot-and-consume operation, and the PoC deliberately does not
// need one. So "consumed once" is the ordinary case, not a guarantee — an
// append landing between a reader's two calls is discarded unread, and a
// truncation that fails leaves already read events to resurface next turn.
// See architecture/trade-offs.md §11.
//
// Asymmetry is the point of this module:
//
// - Appends are fail-silent. A capture hook runs inside the user's session,
//   so a full disk or a permission problem must cost an event, never a turn.
//   The sessions directory comes into existence on the first append — reads
//   create nothing.
// - Reads are tolerant. Appends are not atomic, so an interrupted hook can
//   leave a torn final line (and the append after it a merged one); a line
//   that does not parse is dropped rather than poisoning the next turn's
//   group. Shape validation of parsed events belongs to the group builder,
//   not here.
// - Truncation deletes the file. Read-then-truncate is the Stop hook's
//   consume step; deleting (rather than emptying) also garbage-collects the
//   sessions directory, which would otherwise keep one file per session id
//   forever.
//
// Contract: thoughts/shared/.project/architecture/payloads.md
// §`Session event log`.
import fs from "node:fs";

import { sessionLogPath, sessionsDir } from "./paths.js";

/**
 * Append one event to the session's log. Never throws and never prints: a
 * failed append silently costs this event and nothing else.
 *
 * @param {string} projectDir - Project directory (absolute or relative to cwd).
 * @param {string} sessionId - Session identifier from the hook payload.
 * @param {object} event - Event line per the session-event-log contract.
 * @param {string} [homeDir] - Home directory override for tests.
 */
export function appendSessionEvent(projectDir, sessionId, event, homeDir) {
  try {
    const line = JSON.stringify(event);
    if (line === undefined) {
      return;
    }
    fs.mkdirSync(sessionsDir(projectDir, homeDir), { recursive: true });
    fs.appendFileSync(
      sessionLogPath(projectDir, sessionId, homeDir),
      `${line}\n`,
      "utf8",
    );
  } catch {
    // Observation must never break the observed session.
  }
}

/**
 * Read the session's accumulated events in append order. Never throws and
 * never creates anything: a missing log is an empty turn, and any line that
 * does not parse — torn by an interrupted append or merged with the append
 * after it — is dropped.
 *
 * @param {string} projectDir - Project directory (absolute or relative to cwd).
 * @param {string} sessionId - Session identifier from the hook payload.
 * @param {string} [homeDir] - Home directory override for tests.
 * @returns {unknown[]} Parsed event lines; empty when missing or unreadable.
 */
export function readSessionEvents(projectDir, sessionId, homeDir) {
  let raw;
  try {
    raw = fs.readFileSync(
      sessionLogPath(projectDir, sessionId, homeDir),
      "utf8",
    );
  } catch {
    return [];
  }
  const events = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "") {
      continue;
    }
    try {
      events.push(JSON.parse(line));
    } catch {
      // Torn or corrupt line — skip it, keep every line that survived.
    }
  }
  return events;
}

/**
 * Consume the session's log by deleting it, so the next turn starts empty.
 * Never throws; a log that is already gone is already truncated.
 *
 * Best effort, and the caller gets no report: a deletion that fails is
 * indistinguishable here from one that succeeded, which is why the events the
 * caller just read may be read again by the next turn.
 *
 * @param {string} projectDir - Project directory (absolute or relative to cwd).
 * @param {string} sessionId - Session identifier from the hook payload.
 * @param {string} [homeDir] - Home directory override for tests.
 */
export function truncateSessionLog(projectDir, sessionId, homeDir) {
  try {
    fs.rmSync(sessionLogPath(projectDir, sessionId, homeDir), { force: true });
  } catch {
    // Best effort: a leftover log re-surfaces next turn, it never crashes one.
  }
}
