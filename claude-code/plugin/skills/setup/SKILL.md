---
name: setup
description: Install claude-cache-meter and make it Claude Code's status line. Use only when the user runs /cache-meter:setup.
disable-model-invocation: true
---

Set up the cache meter status line:

1. Run `npx -y claude-cache-meter@0.1.2 install` with the Bash tool. It installs the npm package globally and writes `statusLine` into `~/.claude/settings.json`, keeping the old file as `settings.json.bak`.
2. If it reports that a status line already exists, show the user that existing `statusLine` value and stop. Don't edit `settings.json` yourself; the user decides whether to remove their status line first.
3. Otherwise tell the user it's done: the meter appears under the prompt after the next response, `claude-cache-meter panel` shows the session's details, and `claude-cache-meter uninstall` removes it.
