// A fake `codex app-server` that replays an exchange recorded from the real
// one (fixtures/codex/*.jsonl, codex-cli 0.169.0 on Windows). Each request the
// plugin sends is matched to the next recorded request with the same method;
// what codex wrote after the previous answer, up to the answer to that
// request, is written back, with the plugin's own ids in place of the
// recorded ones. So notifications that came while nobody read, such as a
// whole turn between two refreshes, arrive with the next answer.
import { readFileSync } from "node:fs";

export const recorded = (name) =>
  readFileSync(new URL(`fixtures/codex/${name}.jsonl`, import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

/** The first recorded message that `test` accepts. */
export function find(name, test) {
  for (const entry of recorded(name)) {
    const message = entry.send ?? entry.receive;
    if (test(message, entry)) return message;
  }
  throw new Error(`No such message in ${name}.`);
}

/**
 * The program's handler for the SDK fake's `processSession`. `unrecorded`
 * answers a request the recording doesn't have, as a result or `{ error }`.
 * `log` gets every line the plugin sent.
 */
export function replay(name, { unrecorded, log } = {}) {
  const entries = recorded(name);
  let sends = 0;
  let receives = 0;
  const ids = new Map();
  const held = new Map();
  const write = (message) => {
    if (message.id !== undefined && !message.method && ids.has(message.id))
      return JSON.stringify({ ...message, id: ids.get(message.id) });
    return JSON.stringify(message);
  };
  return {
    receive(line) {
      log?.push(line);
      const message = JSON.parse(line);
      // An answer to codex's own request.
      if (!message.method) return [];
      const index = entries.findIndex(
        (entry, i) =>
          i >= sends &&
          entry.send?.method === message.method &&
          (entry.send.id === undefined) === (message.id === undefined) &&
          entry.send.params?.threadId === message.params?.threadId,
      );
      if (index < 0) {
        if (message.id === undefined) return [];
        const answer = unrecorded?.(message);
        if (answer === undefined)
          return [
            JSON.stringify({
              id: message.id,
              error: { code: -32601, message: `unrecorded ${message.method}` },
            }),
          ];
        return [
          JSON.stringify(
            answer.error
              ? { id: message.id, error: answer.error }
              : { id: message.id, result: answer },
          ),
        ];
      }
      sends = index + 1;
      if (message.id === undefined) return [];
      const recordedId = entries[index].send.id;
      ids.set(recordedId, message.id);
      // Codex answered it out of order, before a request still to come.
      if (held.has(recordedId)) {
        const answer = held.get(recordedId);
        held.delete(recordedId);
        return [write(answer)];
      }
      const answered = entries.findIndex(
        (entry, i) =>
          i >= receives &&
          entry.receive &&
          !entry.receive.method &&
          entry.receive.id === recordedId,
      );
      if (answered < 0) return [];
      const lines = [];
      for (const entry of entries.slice(receives, answered + 1)) {
        const received = entry.receive;
        if (!received) continue;
        if (
          received.id !== undefined &&
          !received.method &&
          !ids.has(received.id)
        )
          held.set(received.id, received);
        else lines.push(write(received));
      }
      receives = answered + 1;
      return lines;
    },
  };
}
