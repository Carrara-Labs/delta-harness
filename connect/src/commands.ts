// The local-command grammar, shared by the Connector (dispatch) and the Store (classify at ingest).
// A message is classified ONCE with this precise predicate when it lands in the inbox, so dispatch
// can find commands by an indexed boolean column rather than re-deriving a fragile SQL grammar — no
// false positives, no whitespace holes, no bounded-scan burial (codex P1).

/** A locally-handled command spends no agent turn and creates no task, so it is dispatched even
 *  while its conversation has a turn in-flight. Anything else is an agent turn (serialized). */
export function isIntercept(text: string): boolean {
  const t = text.trim();
  return (
    t === "/model" ||
    t === "/status" ||
    t === "/provider" ||
    t === "/new" ||
    t === "/id" ||
    t === "/help" ||
    t === "/start" ||
    t === "/cancel" ||
    operatorCommand(t) !== null // /restart /safemode /revert /revert_<id>
  );
}

export function operatorCommand(text: string): { name: string; args: string[] } | null {
  const parts = text.trim().split(/\s+/);
  const first = parts[0] ?? "";
  // Telegram renders /revert_12 as a tappable command link; treat a bare tap as "/revert 12"
  // (hyphens are invalid in a bot command, so the picker uses underscores). Trailing junk
  // (/revert_12 garbage) must NOT silently restore — pass the junk through so the id-parse
  // rejects it with a usage message, matching "/revert 12 garbage" (codex P1).
  const tap = first.match(/^\/revert_(\d+)$/);
  if (tap)
    return { name: "/revert", args: parts.length === 1 ? [tap[1] as string] : parts.slice(1) };
  return first === "/restart" || first === "/safemode" || first === "/revert"
    ? { name: first, args: parts.slice(1) }
    : null;
}
