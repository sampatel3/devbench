/**
 * The most informative line of a failed command's error.
 *
 * Node's `execFile` rejects with a two-line message: the command echoed back,
 * then what actually went wrong.
 *
 *     Command failed: docker restart supabase_edge_runtime_example-app_custom
 *     Error response from daemon: No such container: ...
 *
 * The console took `[0]` and showed the operator the echo, so every failure of
 * the edge-runtime button read the same and explained nothing — the button
 * always seemed to error, and never said why. By the time anyone asked, the
 * reason was gone: nothing had ever recorded it.
 *
 * So: the first real line AFTER the echo, falling back to the echo when that is
 * all there is. Capped, because a card is not a log viewer.
 */
export function why(e: Error, max = 300): string {
  const lines = String(e.message)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length === 0) return 'no reason given';
  const first = lines[0]!;
  const detail = first.startsWith('Command failed:') ? (lines[1] ?? first) : first;
  return detail.length > max ? `${detail.slice(0, max - 1)}…` : detail;
}
