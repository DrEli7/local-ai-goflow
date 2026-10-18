/**
 * Summarises normalized agent tool events into a compact trace report.
 *
 * The function never mutates its input and only counts events whose fields
 * have the expected types; anything else is silently ignored. At most the
 * first 64 entries of the supplied array are inspected.
 *
 * @param {unknown} events Normalized event array supplied by the upstream caller.
 * @returns {{total: number, reads: number, writes: number, commands: number, failed: number, files: Array<{path: string, read: boolean, written: boolean, bytes: number}>, commandResults: Array<{id: string, exitCode: number|null, ok: boolean}>}}
 */

const MAX_EVENTS = 64;
const MAX_IDENTIFIER_LENGTH = 240;

const FILE_TOOLS = new Set(['read_file', 'write_file']);

function isUsableIdentifier(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH
  );
}

function isByteCount(value) {
  return Number.isInteger(value) && value >= 0;
}

function isUsableExitCode(value) {
  return value === null || Number.isInteger(value);
}

function createEmptySummary() {
  return {
    total: 0,
    reads: 0,
    writes: 0,
    commands: 0,
    failed: 0,
    files: [],
    commandResults: [],
  };
}

export function summarizeTrace(events) {
  const summary = createEmptySummary();

  if (!Array.isArray(events)) {
    return summary;
  }

  const windowSize = Math.min(events.length, MAX_EVENTS);
  const filesByPath = new Map();

  for (let index = 0; index < windowSize; index += 1) {
    const event = events[index];

    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      continue;
    }

    if (typeof event.ok !== 'boolean') {
      continue;
    }

    if (FILE_TOOLS.has(event.tool)) {
      if (!isUsableIdentifier(event.path) || !isByteCount(event.bytes)) {
        continue;
      }

      const isRead = event.tool === 'read_file';

      summary.total += 1;
      if (isRead) {
        summary.reads += 1;
      } else {
        summary.writes += 1;
      }

      if (event.ok === false) {
        summary.failed += 1;
      }

      let file = filesByPath.get(event.path);
      if (file === undefined) {
        file = {
          path: event.path,
          read: false,
          written: false,
          bytes: event.bytes,
        };
        filesByPath.set(event.path, file);
        summary.files.push(file);
      }

      if (isRead) {
        file.read = true;
      } else {
        file.written = true;
      }
      file.bytes = event.bytes;

      continue;
    }

    if (event.tool === 'run_command') {
      if (!isUsableIdentifier(event.commandId) || !isUsableExitCode(event.exitCode)) {
        continue;
      }

      summary.total += 1;
      summary.commands += 1;

      if (event.ok === false || (event.exitCode !== null && event.exitCode !== 0)) {
        summary.failed += 1;
      }

      summary.commandResults.push({
        id: event.commandId,
        exitCode: event.exitCode,
        ok: event.ok === true && event.exitCode === 0,
      });
    }
  }

  return summary;
}
