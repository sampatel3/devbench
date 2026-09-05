#!/usr/bin/env bash
# Install the skills every worker this console spawns is told to apply.
#
# The console names its skills in SKILLS_RULE, and a worker that cannot find one
# is not told about it — the prose just quietly stops following the guide. They
# have to live in the account config dir rather than in this repo, because
# workers run with cwd inside a worktree of the repo being worked, so a skill
# committed under this repo's own .claude/skills would be invisible to every one
# of them.
#
# Every skill under this repo's skills/ is LINKED, never copied: edit one here
# and the next worker picks the change up with nothing to re-run, and there is
# only ever one copy to keep true.
#
# Safe to re-run. It never overwrites anything that is not a symlink it already
# owns.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
skills="$config/skills"
mkdir -p "$skills"

link() {
  local src="$1" name="$2" link="$skills/$2"
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    echo "refusing $name — $link exists and is not a symlink" >&2
    exit 1
  fi
  ln -sfn "$src" "$link"
  echo "linked $name -> $src"
}

# A directory is a skill when it has a SKILL.md; anything else under skills/ is
# not one, and an unmatched glob fails the same test rather than linking a path
# that does not exist.
linked=0
for dir in "$repo"/skills/*/; do
  [ -f "$dir/SKILL.md" ] || continue
  link "${dir%/}" "$(basename "$dir")"
  linked=$((linked + 1))
done

# Linking nothing is a failure, not a quiet success: the console would boot,
# every worker would be told to apply a skill that is not there, and the only
# symptom would be gate prose that stops following the guide.
if [ "$linked" -eq 0 ]; then
  echo "no skills found under $repo/skills — nothing linked, and every worker will be told to apply skills it cannot find" >&2
  exit 1
fi

echo
echo "done — restart the console so it re-checks"
