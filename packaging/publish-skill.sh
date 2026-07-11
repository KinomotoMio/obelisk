#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="dist/obelisk-skill"
REMOTE="git@github.com:tommy0103/obelisk-skill.git"

if [ ! -d "$SKILL_DIR/scripts" ]; then
  echo "Error: run 'npm run build:skill' first" >&2
  exit 1
fi

cp packaging/skill-README.md "$SKILL_DIR/README.md"
cp packaging/skill-LICENSE "$SKILL_DIR/LICENSE"

cd "$SKILL_DIR"
rm -rf .git
git init
git remote add origin "$REMOTE"
git add -A
git commit -m "publish: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
git push --force origin HEAD:main
