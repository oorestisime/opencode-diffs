# opencode-diffs

An [OpenCode](https://opencode.ai) plugin that adds browser-based diff code review powered by [@pierre/diffs](https://diffs.com).

---

## Install

```bash
npm install opencode-diffs
```

---

## Configure

Add `"opencode-diffs"` to the `plugin` array in your `opencode.json`.

```json
{
  "plugin": ["opencode-diffs"]
}
```

This registers the `/diff-review` slash command.

---

## Use the command

Review your working tree changes.

```
/diff-review
```

Review against a specific branch.

```
/diff-review --base origin/main
```

Filter to specific files.

```
/diff-review --files src/foo.ts,src/bar.ts
```

Combine flags as needed.

```
/diff-review --base origin/main --files src/foo.ts
```

---

## Review UI

Running the command opens a browser window with syntax-highlighted diffs. The left sidebar lists changed files and each file gets a collapsible diff card.

Click a line number to select lines and create a finding. This opens the review drawer where you pick a category (`bug`, `style`, `perf`, `question`) and severity (`high`, `medium`, `low`) and write a comment.

Findings from prior review rounds show up with a "Resolve" button. Drafts are auto-saved so you can close and reopen without losing work.

---

## Review output

When you submit, the plugin exports results as both JSON and Markdown to `.opencode/reviews/<session>/`. OpenCode receives the findings and proposes a fix strategy.

Multiple review rounds are tracked per session. Each round builds on findings from previous rounds.

---

## Features

- Light and dark mode with theme toggle
- File navigation sidebar
- Collapsible diff cards per file
- Line selection for creating findings
- Review drawer with category and severity
- Resolve findings from prior rounds
- Auto-save drafts
- JSON and Markdown export

---

## License

MIT
