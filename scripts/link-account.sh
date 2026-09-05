#!/usr/bin/env bash
# Give a worker account the canonical skills and instructions without copying
# either. The one-argument form is the original Claude contract:
#
#   scripts/link-account.sh ~/.claude-work
#
# Codex uses an explicit provider word because it also needs AGENTS.md and the
# worker-only PreToolUse fence:
#
#   scripts/link-account.sh codex ~/.codex-worker
#
# Idempotent: a safe link or byte-identical owned hooks.json is reused. A real
# file, directory, foreign symlink or different hooks.json is never replaced.
set -euo pipefail

usage() {
  echo "usage: scripts/link-account.sh <claude-config-dir>" >&2
  echo "   or: scripts/link-account.sh codex <codex-home>" >&2
  exit 2
}

MODE="claude"
TARGET=""
if [ "$#" -eq 2 ] && [ "$1" = "codex" ]; then
  MODE="codex"
  TARGET="$2"
elif [ "$#" -eq 1 ]; then
  TARGET="$1"
else
  usage
fi

CANONICAL="${CANONICAL_CLAUDE_DIR:-$HOME/.claude}"
CANONICAL_CODEX="${CANONICAL_CODEX_DIR:-$HOME/.codex}"

# Expand a leading ~ the same way the console's registry does. The shell does
# not expand a tilde that arrived inside an argv value.
expand_home() {
  case "$1" in
    "~") printf '%s\n' "$HOME" ;;
    "~/"*) printf '%s/%s\n' "$HOME" "${1#\~/}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}
TARGET="$(expand_home "$TARGET")"
CANONICAL="$(expand_home "$CANONICAL")"
CANONICAL_CODEX="$(expand_home "$CANONICAL_CODEX")"

if [ "$MODE" = "codex" ]; then
  NODE_BIN="${WORKER_NODE_BIN:-}"
  HOOK_PATH="${WORKER_WRITE_FENCE_HOOK:-}"
  if [ -z "$NODE_BIN" ] || [ -z "$HOOK_PATH" ]; then
    echo "STOP hooks.json: WORKER_NODE_BIN and WORKER_WRITE_FENCE_HOOK are required for a Codex account" >&2
    exit 2
  fi
  case "$NODE_BIN" in
    /*) ;;
    *) echo "STOP hooks.json: WORKER_NODE_BIN must be an absolute path" >&2; exit 2 ;;
  esac
  case "$HOOK_PATH" in
    /*) ;;
    *) echo "STOP hooks.json: WORKER_WRITE_FENCE_HOOK must be an absolute path" >&2; exit 2 ;;
  esac
  if [ ! -x "$NODE_BIN" ]; then
    echo "STOP hooks.json: Node interpreter is not executable: $NODE_BIN" >&2
    exit 2
  fi
  if [ ! -f "$HOOK_PATH" ]; then
    echo "STOP hooks.json: write-fence hook does not exist: $HOOK_PATH" >&2
    exit 2
  fi
fi

if [ "$MODE" = "codex" ]; then
  # `cd "$path" && pwd -P` cannot compare two paths that do not exist yet. That
  # is a safety hole here: the first link attempt at a not-yet-created ~/.codex
  # would miss equality, create it below, and install the worker-only hook into
  # the interactive home. Resolve the nearest existing ancestor and append the
  # missing suffix, so lexical aliases and symlinked parents compare correctly
  # before mkdir touches either destination.
  normalize_for_compare() {
    "$NODE_BIN" - "$1" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
let candidate = path.resolve(process.argv[2]);
let cursor = candidate;
const suffix = [];
while (!fs.existsSync(cursor)) {
  const parent = path.dirname(cursor);
  if (parent === cursor) break;
  suffix.unshift(path.basename(cursor));
  cursor = parent;
}
let base = cursor;
try { base = fs.realpathSync.native(cursor); } catch {}
process.stdout.write(path.join(base, ...suffix));
NODE
  }

  target_compare="$(normalize_for_compare "$TARGET")"
  codex_compare="$(normalize_for_compare "$CANONICAL_CODEX")"
  canonical_compare="$(normalize_for_compare "$CANONICAL")"
  if [ "$target_compare" = "$codex_compare" ]; then
    echo "STOP $TARGET is the interactive Codex home; use a dedicated worker CODEX_HOME (for example ~/.codex-worker)" >&2
    exit 1
  fi
  if [ "$target_compare" = "$canonical_compare" ]; then
    echo "STOP $TARGET is the canonical Claude dir; refusing to install worker hooks into that interactive account" >&2
    exit 1
  fi
else
  canonical_real="$(cd "$CANONICAL" 2>/dev/null && pwd -P || echo "")"
  target_real="$(cd "$TARGET" 2>/dev/null && pwd -P || echo "-")"
  if [ "$canonical_real" = "$target_real" ]; then
    echo "$TARGET is the canonical dir — it is the source, nothing to link."
    exit 0
  fi
fi

mkdir -p "$TARGET"

# Claude historically printed conflicts and returned success. Keep that exact
# behavior for the one-argument contract. Codex linking is a health operation:
# any missing/foreign owned artifact makes the command fail after reporting all
# problems, so the console cannot show a false green.
STOPPED=0
mark_stop() {
  if [ "$MODE" = "codex" ]; then STOPPED=1; fi
}

link_one() {
  local source_name="$1"
  local dest_name="$2"
  local src="$CANONICAL/$source_name"
  local dest="$TARGET/$dest_name"

  if [ ! -e "$src" ]; then
    echo "skip $dest_name: $src does not exist"
    mark_stop
    return 0
  fi

  if [ -L "$dest" ]; then
    if [ "$(readlink "$dest")" = "$src" ]; then
      echo "ok   $dest_name: already linked to $src"
    else
      echo "STOP $dest_name: $dest is a symlink to $(readlink "$dest"), not to $src"
      echo "     if that is wrong, remove it yourself:  rm '$dest'  then re-run this script"
      mark_stop
    fi
    return 0
  fi

  if [ -e "$dest" ]; then
    echo "STOP $dest_name: $dest already exists and is a real file/directory — refusing to replace it"
    echo "     move it out of the way yourself, then re-run:  mv '$dest' '$dest.bak'"
    mark_stop
    return 0
  fi

  ln -s "$src" "$dest"
  echo "ok   $dest_name: linked $dest -> $src"
}

# Generate the exact same document as codexHooksJson() in src/fence.ts. Node is
# already a required, absolute input; using it here avoids hand-escaped JSON in
# shell and keeps paths with spaces, dollars or apostrophes safe.
generate_codex_hooks() {
  "$NODE_BIN" - "$NODE_BIN" "$HOOK_PATH" <<'NODE'
const [nodeBin, hookPath] = process.argv.slice(2);
const quote = (value) => "'" + value.split("'").join("'\"'\"'") + "'";
const document = {
  description: 'Worker Console write fence. Managed by scripts/link-account.sh codex.',
  hooks: {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [
          {
            type: 'command',
            command: `${quote(nodeBin)} ${quote(hookPath)}`,
            timeout: 20,
          },
        ],
      },
    ],
  },
};
process.stdout.write(JSON.stringify(document, null, 2) + '\n');
NODE
}

write_codex_hooks() {
  local dest="$TARGET/hooks.json"
  local tmp
  tmp="$(mktemp "$TARGET/.worker-console-hooks.XXXXXX")"
  if ! generate_codex_hooks > "$tmp"; then
    rm -f -- "$tmp"
    echo "STOP hooks.json: could not generate the Worker Console hook document"
    mark_stop
    return 0
  fi
  chmod 600 "$tmp"

  if [ -L "$dest" ] || [ -d "$dest" ]; then
    rm -f -- "$tmp"
    echo "STOP hooks.json: $dest is not the real file owned by Worker Console — refusing to replace it"
    mark_stop
    return 0
  fi
  if [ -f "$dest" ]; then
    if cmp -s "$tmp" "$dest"; then
      rm -f -- "$tmp"
      echo "ok   hooks.json: already the Worker Console hook document"
    else
      rm -f -- "$tmp"
      echo "STOP hooks.json: $dest already exists with different content — refusing to replace it"
      echo "     review or move it yourself, then re-run this script"
      mark_stop
    fi
    return 0
  fi
  if [ -e "$dest" ]; then
    rm -f -- "$tmp"
    echo "STOP hooks.json: $dest already exists and is not a regular file — refusing to replace it"
    mark_stop
    return 0
  fi

  # Hard-linking a temp file in the same directory is an atomic no-clobber
  # create: unlike mv, it fails if another file appeared after the checks above.
  if ln "$tmp" "$dest" 2>/dev/null; then
    rm -f -- "$tmp"
    echo "ok   hooks.json: wrote the Worker Console hook document"
    return 0
  fi
  if [ -f "$dest" ] && cmp -s "$tmp" "$dest"; then
    rm -f -- "$tmp"
    echo "ok   hooks.json: already the Worker Console hook document"
    return 0
  fi
  rm -f -- "$tmp"
  echo "STOP hooks.json: $dest appeared while linking and is not ours — refusing to replace it"
  mark_stop
}

link_one skills skills
if [ "$MODE" = "codex" ]; then
  link_one CLAUDE.md AGENTS.md
  write_codex_hooks
else
  link_one CLAUDE.md CLAUDE.md
fi

if [ "$STOPPED" -ne 0 ]; then
  echo >&2
  echo "linking incomplete; no conflicting file was changed" >&2
  exit 1
fi

echo
echo "next: log this account in yourself (never scripted, never stored):"
if [ "$MODE" = "codex" ]; then
  echo "  CODEX_HOME=$TARGET codex login"
else
  echo "  CLAUDE_CONFIG_DIR=$TARGET claude /login"
fi
echo "then add it to accounts.json (see accounts.example.json)."
