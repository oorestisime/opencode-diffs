import { type Plugin, tool } from "@opencode-ai/plugin"
import { mkdir } from "node:fs/promises"
import path from "node:path"

const command = "diff-review"
const name = "diff_review"
const categories = ["bug", "style", "perf", "question"] as const
const severities = ["high", "medium", "low"] as const
const sides = ["additions", "deletions"] as const

type Category = (typeof categories)[number]
type Severity = (typeof severities)[number]
type Side = (typeof sides)[number]

type Anchor = {
  before: string
  selected: string
  after: string
}

type Finding = {
  id: string
  round: number
  file: string
  side: Side
  start_line: number
  end_line: number
  category: Category
  severity: Severity
  comment: string
  status: "open" | "closed_auto" | "resolved"
  anchor: Anchor
  created_at: number
  updated_at: number
  closed_at?: number
  close_reason?: "file_removed" | "anchor_missing"
}

type DraftFinding = {
  id?: string
  file: string
  side: Side
  start_line: number
  end_line: number
  category: Category
  severity: Severity
  comment: string
}

type Draft = {
  notes: string
  new_findings: DraftFinding[]
}

type State = {
  session_id: string
  round: number
  findings: Finding[]
  draft?: Draft
  updated_at: number
}

type ReviewFile = {
  path: string
  status: "added" | "deleted" | "modified"
  additions: number
  deletions: number
  before: string
  after: string
}

type SourceFile = {
  file: string
  status: "added" | "deleted" | "modified"
  before: string
  after: string
  additions: number
  deletions: number
}

type Launch = {
  id: string
  session_id: string
  repo_root: string
  scope_root: string
  round: number
  files: ReviewFile[]
  existing_findings: Finding[]
  draft: Draft
  taxonomy: {
    categories: Category[]
    severities: Severity[]
  }
  filter?: string[]
  base?: string
}

type Submit = {
  notes?: string
  new_findings?: DraftFinding[]
}

type Done = {
  cancelled: boolean
  round: number
  notes: string
  findings: Finding[]
  json_path: string
  md_path: string
  url: string
  opened: boolean
}

function usage() {
  return "Usage: /diff-review [--base origin/dev] [--files path/to/a.ts,path/to/b.ts]"
}

function isCategory(input: string): input is Category {
  return categories.includes(input as Category)
}

function isSeverity(input: string): input is Severity {
  return severities.includes(input as Severity)
}

function isSide(input: string): input is Side {
  return sides.includes(input as Side)
}

function parse(raw: string | undefined) {
  if (!raw?.trim()) {
    return {
      files: undefined as string[] | undefined,
      base: undefined as string | undefined,
      error: undefined as string | undefined,
    }
  }

  const tokens = raw.trim().split(/\s+/).filter(Boolean)
  let files: string[] | undefined
  let base: string | undefined

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (!token) continue
    const next = tokens[index + 1]

    if (token === "--files" || token.startsWith("--files=")) {
      const value = token.startsWith("--files=") ? token.slice("--files=".length) : next
      if (!value || value.startsWith("--")) {
        return {
          files: undefined,
          base: undefined,
          error: `--files expects a comma-separated list.\n${usage()}`,
        }
      }

      const parsed = value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
      if (parsed.length === 0) {
        return {
          files: undefined,
          base: undefined,
          error: `--files expects a comma-separated list.\n${usage()}`,
        }
      }

      files = parsed
      if (token === "--files") index++
      continue
    }

    if (token === "--base" || token.startsWith("--base=")) {
      const value = token.startsWith("--base=") ? token.slice("--base=".length) : next
      if (!value || value.startsWith("--")) {
        return {
          files: undefined,
          base: undefined,
          error: `--base expects a branch, tag, or ref name.\n${usage()}`,
        }
      }

      base = value
      if (token === "--base") index++
      continue
    }

    return {
      files: undefined,
      base: undefined,
      error: `Unsupported argument: ${token}\n${usage()}`,
    }
  }

  return {
    files,
    base,
    error: undefined,
  }
}

function normalize(start: number, end: number) {
  if (start <= end) return { start, end }
  return { start: end, end: start }
}

function anchor(content: string, start: number, end: number): Anchor {
  const range = normalize(start, end)
  const lines = content.split("\n")
  const begin = Math.max(1, Math.min(range.start, lines.length || 1))
  const finish = Math.max(begin, Math.min(range.end, lines.length || begin))
  return {
    before: lines[begin - 2] ?? "",
    selected: lines.slice(begin - 1, finish).join("\n"),
    after: lines[finish] ?? "",
  }
}

function remap(item: Finding, file: ReviewFile) {
  const text = item.side === "deletions" ? file.before : file.after
  if (!item.anchor.selected) return undefined
  const index = text.indexOf(item.anchor.selected)
  if (index < 0) return undefined
  const prefix = text.slice(0, index)
  const start = prefix.split("\n").length
  const size = Math.max(1, item.anchor.selected.split("\n").length)
  return {
    start_line: start,
    end_line: start + size - 1,
  }
}

function reconcile(files: ReviewFile[], findings: Finding[]) {
  const now = Date.now()
  const map = new Map(files.map((file) => [file.path, file]))
  return findings.map((item) => {
    if (item.status !== "open") return item
    const file = map.get(item.file)
    if (!file) {
      return {
        ...item,
        status: "closed_auto" as const,
        close_reason: "file_removed" as const,
        closed_at: now,
        updated_at: now,
      }
    }
    const next = remap(item, file)
    if (!next) {
      return {
        ...item,
        status: "closed_auto" as const,
        close_reason: "anchor_missing" as const,
        closed_at: now,
        updated_at: now,
      }
    }
    return {
      ...item,
      start_line: next.start_line,
      end_line: next.end_line,
      updated_at: now,
    }
  })
}

function sanitize(items: DraftFinding[], round: number, files: Map<string, ReviewFile>) {
  const now = Date.now()
  return items.flatMap((item, index) => {
    if (typeof item.file !== "string" || !item.file) return []
    if (typeof item.comment !== "string" || !item.comment.trim()) return []
    if (!isSide(item.side)) return []
    if (!isCategory(item.category)) return []
    if (!isSeverity(item.severity)) return []
    if (!Number.isFinite(item.start_line) || !Number.isFinite(item.end_line)) return []

    const file = files.get(item.file)
    if (!file) return []

    const start_line = Math.max(1, Math.floor(Math.min(item.start_line, item.end_line)))
    const end_line = Math.max(start_line, Math.floor(Math.max(item.start_line, item.end_line)))
    const source = item.side === "deletions" ? file.before : file.after
    const next = anchor(source, start_line, end_line)
    if (!next.selected.trim()) return []

    const id = item.id?.trim() || `finding_${round}_${index + 1}_${crypto.randomUUID().slice(0, 6)}`

    return [
      {
        id,
        round,
        file: item.file,
        side: item.side,
        start_line,
        end_line,
        category: item.category,
        severity: item.severity,
        comment: item.comment.trim(),
        status: "open" as const,
        anchor: next,
        created_at: now,
        updated_at: now,
      },
    ]
  })
}

function format(result: Done) {
  if (result.cancelled) {
    return [
      "Diff review was cancelled before submission.",
      `You can relaunch with /${command}.`,
      `Last opened URL: ${result.url}`,
    ].join("\n")
  }

  const open = result.findings.filter((item) => item.status === "open")
  const rows = open.map(
    (item) =>
      `- [${item.severity}] [${item.category}] ${item.file}:${item.start_line}-${item.end_line} (${item.side}) - ${item.comment}`,
  )
  const findings = rows.length > 0 ? rows.join("\n") : "- No open findings"
  const notes = result.notes ? result.notes : "(none)"

  return [
    `# Diff Review Round ${result.round}`,
    "",
    `- Open findings: ${open.length}`,
    `- JSON export: ${result.json_path}`,
    `- Markdown export: ${result.md_path}`,
    `- Review URL: ${result.url}`,
    `- Browser opened: ${result.opened ? "yes" : "no"}`,
    "",
    "## Reviewer Notes",
    notes,
    "",
    "## Findings",
    findings,
    "",
    "Use this review to propose and discuss a fix plan only.",
    "Do not edit files yet.",
  ].join("\n")
}

function markdown(input: {
  session_id: string
  round: number
  notes: string
  findings: Finding[]
  filter?: string[]
  base?: string
}) {
  const list = input.findings
    .map(
      (item) =>
        `- [${item.status}] [${item.severity}] [${item.category}] ${item.file}:${item.start_line}-${item.end_line} (${item.side}) - ${item.comment}`,
    )
    .join("\n")
  const notes = input.notes || "(none)"
  const files = input.filter?.length ? input.filter.join(", ") : "all changed files"
  const source = input.base ? `${input.base}...HEAD` : "working tree"
  return [
    `# Diff Review Round ${input.round}`,
    "",
    `- Session: ${input.session_id}`,
    `- Diff source: ${source}`,
    `- Scope: ${files}`,
    `- Timestamp: ${new Date().toISOString()}`,
    "",
    "## Notes",
    notes,
    "",
    "## Findings",
    list || "- none",
  ].join("\n")
}

function open(url: string) {
  if (process.platform === "darwin") {
    const bin = Bun.which("open")
    if (!bin) return false
    Bun.spawn([bin, url], { stdout: "ignore", stderr: "ignore" })
    return true
  }

  if (process.platform === "win32") {
    const bin = Bun.which("cmd")
    if (!bin) return false
    Bun.spawn([bin, "/c", "start", "", url], { stdout: "ignore", stderr: "ignore" })
    return true
  }

  const bin = Bun.which("xdg-open")
  if (!bin) return false
  Bun.spawn([bin, url], { stdout: "ignore", stderr: "ignore" })
  return true
}

function defaultState(session_id: string): State {
  return {
    session_id,
    round: 0,
    findings: [],
    updated_at: Date.now(),
  }
}

async function readState(file: string, session_id: string) {
  const source = Bun.file(file)
  const exists = await source.exists()
  if (!exists) return defaultState(session_id)
  return source.json().catch(() => defaultState(session_id)) as Promise<State>
}

async function saveState(file: string, state: State) {
  await mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, JSON.stringify(state, null, 2))
}

function split(text: string) {
  return text
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)
}

function count(text: string) {
  if (!text) return 0
  const lines = text.split("\n")
  if (text.endsWith("\n")) return Math.max(0, lines.length - 1)
  return lines.length
}

function text(content: string) {
  if (content.includes("\u0000")) return ""
  return content
}

async function run(cwd: string, args: string[]) {
  const proc = Bun.spawn(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })

  const [stdout, stderr, code] = await Promise.all([
    Bun.readableStreamToText(proc.stdout).catch(() => ""),
    Bun.readableStreamToText(proc.stderr).catch(() => ""),
    proc.exited,
  ])

  return {
    ok: code === 0,
    stdout,
    stderr,
  }
}

async function repo(cwd: string) {
  const result = await run(cwd, ["git", "rev-parse", "--show-toplevel"])
  if (!result.ok) {
    return {
      path: "",
      error: result.stderr.trim() || result.stdout.trim() || "failed to resolve git root",
    }
  }

  const path = result.stdout.trim()
  if (!path) {
    return {
      path: "",
      error: "failed to resolve git root",
    }
  }

  return {
    path,
    error: undefined as string | undefined,
  }
}

async function inside(cwd: string) {
  const result = await run(cwd, ["git", "rev-parse", "--is-inside-work-tree"])
  if (!result.ok) return false
  return result.stdout.trim() === "true"
}

async function head(cwd: string) {
  const result = await run(cwd, ["git", "rev-parse", "--verify", "HEAD"])
  return result.ok
}

function scope(root: string, dir: string) {
  const rel = path.relative(root, dir)
  if (rel.startsWith("..")) return "."
  if (!rel || rel === ".") return "."
  return rel
}

function internal(file: string) {
  return file.startsWith(".opencode/reviews/") || file.includes("/.opencode/reviews/")
}

async function names(root: string, area: string, withHead: boolean) {
  const spec = ["--", area]
  const tracked = withHead
    ? await run(root, ["git", "diff", "--name-only", "--no-renames", "HEAD", ...spec])
    : await run(root, ["git", "ls-files", "--cached", ...spec])
  if (!tracked.ok) {
    return {
      files: [] as string[],
      error: tracked.stderr.trim() || tracked.stdout.trim() || "failed to list tracked changes",
    }
  }

  const untracked = await run(root, ["git", "ls-files", "--others", "--exclude-standard", ...spec])
  if (!untracked.ok) {
    return {
      files: [] as string[],
      error: untracked.stderr.trim() || untracked.stdout.trim() || "failed to list untracked files",
    }
  }

  const files = Array.from(new Set([...split(tracked.stdout), ...split(untracked.stdout)])).filter(
    (item) => !internal(item),
  )

  return {
    files,
    error: undefined as string | undefined,
  }
}

async function stats(root: string, area: string, withHead: boolean) {
  const result = new Map<string, { additions: number; deletions: number }>()
  if (!withHead) return result

  const diff = await run(root, ["git", "diff", "--numstat", "--no-renames", "HEAD", "--", area])
  if (!diff.ok) return result

  for (const row of split(diff.stdout)) {
    const [adds, dels, ...rest] = row.split("\t")
    if (!adds || !dels || rest.length === 0) continue
    const file = rest.join("\t")
    const additions = Number(adds)
    const deletions = Number(dels)
    result.set(file, {
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
    })
  }

  return result
}

async function before(root: string, file: string, withHead: boolean) {
  if (!withHead) return ""
  const result = await run(root, ["git", "show", `HEAD:${file}`])
  if (!result.ok) return ""
  return text(result.stdout)
}

async function after(root: string, file: string) {
  const source = Bun.file(path.join(root, file))
  const exists = await source.exists()
  if (!exists) return ""
  return source
    .text()
    .then(text)
    .catch(() => "")
}

async function at(root: string, rev: string, file: string) {
  const result = await run(root, ["git", "show", `${rev}:${file}`])
  if (!result.ok) return ""
  return text(result.stdout)
}

async function merge(root: string, base: string) {
  const result = await run(root, ["git", "merge-base", base, "HEAD"])
  if (!result.ok) {
    return {
      rev: "",
      error: result.stderr.trim() || result.stdout.trim() || `failed to resolve merge-base for ${base}`,
    }
  }

  const rev = result.stdout.trim()
  if (!rev) {
    return {
      rev: "",
      error: `failed to resolve merge-base for ${base}`,
    }
  }

  return {
    rev,
    error: undefined as string | undefined,
  }
}

async function branchNames(root: string, area: string, rev: string) {
  const result = await run(root, ["git", "diff", "--name-only", "--no-renames", `${rev}..HEAD`, "--", area])
  if (!result.ok) {
    return {
      files: [] as string[],
      error: result.stderr.trim() || result.stdout.trim() || "failed to list branch changes",
    }
  }

  return {
    files: split(result.stdout).filter((item) => !internal(item)),
    error: undefined as string | undefined,
  }
}

async function branchStats(root: string, area: string, rev: string) {
  const result = new Map<string, { additions: number; deletions: number }>()
  const diff = await run(root, ["git", "diff", "--numstat", "--no-renames", `${rev}..HEAD`, "--", area])
  if (!diff.ok) return result

  for (const row of split(diff.stdout)) {
    const [adds, dels, ...rest] = row.split("\t")
    if (!adds || !dels || rest.length === 0) continue
    const file = rest.join("\t")
    const additions = Number(adds)
    const deletions = Number(dels)
    result.set(file, {
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
    })
  }

  return result
}

async function collectWorking(root: string, dir: string) {
  const area = scope(root, dir)
  const withHead = await head(root)
  const listed = await names(root, area, withHead)
  if (listed.error) {
    return {
      files: [] as SourceFile[],
      error: `Failed to read git diff: ${listed.error}`,
    }
  }

  if (listed.files.length === 0) {
    return {
      files: [] as SourceFile[],
      error: undefined as string | undefined,
    }
  }

  const map = await stats(root, area, withHead)
  const files = await Promise.all(
    listed.files.map(async (file) => {
      const prev = await before(root, file, withHead)
      const next = await after(root, file)
      const stat = map.get(file)
      const status: SourceFile["status"] = prev && !next ? "deleted" : !prev && next ? "added" : "modified"
      return {
        file,
        status,
        before: prev,
        after: next,
        additions: stat?.additions ?? (prev ? Math.max(0, count(next) - count(prev)) : count(next)),
        deletions: stat?.deletions ?? Math.max(0, count(prev) - count(next)),
      }
    }),
  )

  return {
    files,
    error: undefined as string | undefined,
  }
}

async function collectBase(root: string, dir: string, base: string) {
  const area = scope(root, dir)
  const merged = await merge(root, base)
  if (merged.error) {
    return {
      files: [] as SourceFile[],
      error: `Failed to resolve --base ${base}: ${merged.error}`,
    }
  }

  const listed = await branchNames(root, area, merged.rev)
  if (listed.error) {
    return {
      files: [] as SourceFile[],
      error: `Failed to read git diff for --base ${base}: ${listed.error}`,
    }
  }

  if (listed.files.length === 0) {
    return {
      files: [] as SourceFile[],
      error: undefined as string | undefined,
    }
  }

  const map = await branchStats(root, area, merged.rev)
  const files = await Promise.all(
    listed.files.map(async (file) => {
      const prev = await at(root, merged.rev, file)
      const next = await at(root, "HEAD", file)
      const stat = map.get(file)
      const status: SourceFile["status"] = prev && !next ? "deleted" : !prev && next ? "added" : "modified"
      return {
        file,
        status,
        before: prev,
        after: next,
        additions: stat?.additions ?? (prev ? Math.max(0, count(next) - count(prev)) : count(next)),
        deletions: stat?.deletions ?? Math.max(0, count(prev) - count(next)),
      }
    }),
  )

  return {
    files,
    error: undefined as string | undefined,
  }
}

async function collect(root: string, dir: string, base?: string) {
  if (!(await inside(root))) {
    return {
      files: [] as SourceFile[],
      error: "Current directory is not a git repository.",
    }
  }

  if (base) return collectBase(root, dir, base)
  return collectWorking(root, dir)
}

async function renderFiles(files: SourceFile[]) {
  return files.map((item) => ({
    path: item.file,
    status: item.status,
    additions: item.additions,
    deletions: item.deletions,
    before: item.before,
    after: item.after,
  }))
}

function mime(file: string, fallback: string) {
  const ext = path.extname(file)
  if (ext === ".js" || ext === ".mjs") return "text/javascript; charset=utf-8"
  if (ext === ".css") return "text/css; charset=utf-8"
  if (ext === ".json") return "application/json; charset=utf-8"
  if (ext === ".map") return "application/json; charset=utf-8"
  if (ext === ".wasm") return "application/wasm"
  if (ext === ".svg") return "image/svg+xml"
  if (ext === ".html") return "text/html; charset=utf-8"
  return fallback || "application/octet-stream"
}

async function resolveFile(paths: string[]) {
  for (const item of paths) {
    const exists = await Bun.file(item).exists()
    if (exists) return item
  }
}

export const DiffReviewPlugin: Plugin = async (ctx) => {
  const html_file = await resolveFile([
    path.join(import.meta.dir, "ui", "review.html"),
    path.join(import.meta.dir, "..", "ui", "review.html"),
    path.join(import.meta.dir, "..", "dist", "ui", "review.html"),
  ])
  const app_file = await resolveFile([
    path.join(import.meta.dir, "ui", "app.js"),
    path.join(import.meta.dir, "..", "ui", "app.js"),
    path.join(import.meta.dir, "..", "dist", "ui", "app.js"),
  ])
  const asset_root = app_file ? path.dirname(app_file) : ""

  const html = html_file
    ? await Bun.file(html_file)
        .text()
        .catch(() => "")
    : ""

  return {
    config: async (output) => {
      if (output.command?.[command]) return
      output.command = {
        ...output.command,
        [command]: {
          description: "Open a local @pierre/diffs review UI and collect annotations",
          template: [
            `Call the ${name} tool exactly once.`,
            "Pass raw command arguments from $ARGUMENTS into the tool arg `raw`.",
            "After the tool returns, propose and discuss a fix strategy.",
            "Do not edit files yet.",
          ].join("\n"),
        },
      }
    },

    tool: {
      [name]: tool({
        description:
          "Open a local Diffs-based review UI for the current session and return structured findings for proposal discussion.",
        args: {
          raw: tool.schema.string().optional().describe("Raw command arguments from /diff-review"),
        },

        async execute(args, context) {
          if (!html) return "Failed to load review UI template from plugin package."
          if (!app_file) {
            return "Failed to load built UI assets. Install packaged plugin build (dist/ui/app.js) before running /diff-review."
          }

          const parsed = parse(args.raw)
          if (parsed.error) return parsed.error

          const roots = [context.worktree, context.directory].filter(Boolean)
          const resolved = await Promise.all(roots.map((item) => repo(item)))
          const root = resolved.find((item) => !item.error)
          if (!root?.path) {
            return [
              "Failed to resolve git repository root for this session.",
              `worktree=${context.worktree}`,
              `directory=${context.directory}`,
            ].join("\n")
          }

          const scope_root = context.worktree || context.directory
          const source = await collect(root.path, scope_root, parsed.base)
          if (source.error) return source.error

          const all = source.files
          const scoped = parsed.files?.length
            ? all.filter(
                (item) => parsed.files?.includes(item.file) || parsed.files?.some((value) => item.file.endsWith(value)),
              )
            : all

          if (scoped.length === 0) {
            const available = all.map((item) => `- ${item.file}`).join("\n")
            const hint = parsed.files?.length
              ? ["No files matched --files filter.", "", usage(), "", "Available files:", available || "- none"].join(
                  "\n",
                )
              : parsed.base
                ? `No changes found for --base ${parsed.base}.`
                : "No git working-tree changes found yet."
            return hint
          }

          const files = await renderFiles(scoped)
          const output_root = path.join(scope_root, ".opencode", "reviews", context.sessionID)
          const state_file = path.join(output_root, "state.json")
          const state = await readState(state_file, context.sessionID)
          const merged = reconcile(files, state.findings)
          const existing = merged.filter((item) => item.status === "open")
          const base: State = {
            ...state,
            findings: merged,
            updated_at: Date.now(),
          }
          await saveState(state_file, base)

          const id = `review_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 6)}`
          const token = crypto.randomUUID().replaceAll("-", "")
          const data: Launch = {
            id,
            session_id: context.sessionID,
            repo_root: root.path,
            scope_root,
            round: base.round + 1,
            files,
            existing_findings: existing,
            draft: base.draft ?? {
              notes: "",
              new_findings: [],
            },
            taxonomy: {
              categories: [...categories],
              severities: [...severities],
            },
            filter: parsed.files,
            base: parsed.base,
          }

          const map = new Map(files.map((item) => [item.path, item]))

          let done = false
          let finish = (_: Done) => {}
          const wait = new Promise<Done>((resolve) => {
            finish = resolve
          })

          const resolve = (result: Done) => {
            if (done) return
            done = true
            finish(result)
          }

          let opened = false

          const server = Bun.serve({
            port: 0,
            fetch: async (request: Request) => {
              const url = new URL(request.url)
              const pathname = url.pathname

              if (pathname === "/health") {
                return new Response("ok")
              }

              if (request.method === "GET" && pathname.startsWith("/assets/")) {
                if (!asset_root) return new Response("not found", { status: 404 })
                const rel = pathname.slice("/assets/".length)
                if (!rel || rel.includes("\u0000")) {
                  return new Response("bad request", { status: 400 })
                }

                const resolved = path.resolve(asset_root, rel)
                const prefix = asset_root.endsWith(path.sep) ? asset_root : `${asset_root}${path.sep}`
                if (resolved !== asset_root && !resolved.startsWith(prefix)) {
                  return new Response("forbidden", { status: 403 })
                }

                const file = Bun.file(resolved)
                const exists = await file.exists()
                if (!exists) return new Response("not found", { status: 404 })

                return new Response(file, {
                  headers: {
                    "content-type": mime(resolved, "application/octet-stream"),
                    "cache-control": "no-store",
                  },
                })
              }

              if (url.searchParams.get("token") !== token) {
                return new Response("unauthorized", { status: 401 })
              }

              if (request.method === "GET" && pathname === `/review/${id}`) {
                return new Response(html, {
                  headers: { "content-type": "text/html; charset=utf-8" },
                })
              }

              if (request.method === "GET" && pathname === `/api/review/${id}`) {
                return new Response(JSON.stringify(data), {
                  headers: { "content-type": "application/json" },
                })
              }

              if (request.method === "PUT" && pathname === `/api/review/${id}/draft`) {
                const input = (await request.json().catch(() => ({}))) as Submit
                const notes = typeof input.notes === "string" ? input.notes : ""
                const new_findings = Array.isArray(input.new_findings) ? input.new_findings : []
                const next: State = {
                  ...base,
                  draft: {
                    notes,
                    new_findings,
                  },
                  updated_at: Date.now(),
                }
                await saveState(state_file, next)
                return new Response(JSON.stringify({ ok: true }), {
                  headers: { "content-type": "application/json" },
                })
              }

              if (request.method === "POST" && pathname === `/api/review/${id}/resolve`) {
                const input = (await request.json().catch(() => ({}))) as { finding_id?: string }
                const finding_id = input.finding_id
                if (!finding_id) {
                  return new Response(JSON.stringify({ error: "finding_id required" }), {
                    status: 400,
                    headers: { "content-type": "application/json" },
                  })
                }
                const target = base.findings.find((item) => item.id === finding_id && item.status === "open")
                if (!target) {
                  return new Response(JSON.stringify({ error: "finding not found or already resolved" }), {
                    status: 404,
                    headers: { "content-type": "application/json" },
                  })
                }
                target.status = "resolved"
                target.updated_at = Date.now()
                target.closed_at = Date.now()
                base.updated_at = Date.now()
                await saveState(state_file, base)
                // Also update the existing_findings in the launch data so UI stays in sync
                const idx = data.existing_findings.findIndex((item) => item.id === finding_id)
                if (idx !== -1) data.existing_findings.splice(idx, 1)
                return new Response(JSON.stringify({ ok: true }), {
                  headers: { "content-type": "application/json" },
                })
              }

              if (request.method === "POST" && pathname === `/api/review/${id}/submit`) {
                const input = (await request.json().catch(() => ({}))) as Submit
                const notes = typeof input.notes === "string" ? input.notes.trim() : ""
                const fresh = Array.isArray(input.new_findings) ? input.new_findings : []
                const round = base.round + 1
                const created = sanitize(fresh, round, map)
                const carry = base.findings.filter((item) => item.status === "open")
                const closed = base.findings.filter((item) => item.status !== "open")
                const findings = [...closed, ...carry, ...created]
                const next: State = {
                  ...base,
                  round,
                  findings,
                  draft: undefined,
                  updated_at: Date.now(),
                }
                await saveState(state_file, next)

                const stamp = String(round).padStart(3, "0")
                const json_path = path.join(output_root, `round-${stamp}.json`)
                const md_path = path.join(output_root, `round-${stamp}.md`)
                const export_data = {
                  session_id: context.sessionID,
                  round,
                  notes,
                  findings,
                  filter: parsed.files,
                  base: parsed.base,
                  generated_at: Date.now(),
                }
                await Bun.write(json_path, JSON.stringify(export_data, null, 2))
                await Bun.write(
                  md_path,
                  markdown({
                    session_id: context.sessionID,
                    round,
                    notes,
                    findings,
                    filter: parsed.files,
                    base: parsed.base,
                  }),
                )

                const completed: Done = {
                  cancelled: false,
                  round,
                  notes,
                  findings,
                  json_path,
                  md_path,
                  url: `http://127.0.0.1:${server.port}/review/${id}?token=${token}`,
                  opened,
                }

                queueMicrotask(() => resolve(completed))

                return new Response(
                  JSON.stringify({
                    ok: true,
                    round,
                    json_path,
                    md_path,
                  }),
                  {
                    headers: { "content-type": "application/json" },
                  },
                )
              }

              return new Response("not found", { status: 404 })
            },
          })

          const review_url = `http://127.0.0.1:${server.port}/review/${id}?token=${token}`
          opened = open(review_url)
          context.metadata({
            title: "Diff review",
            metadata: {
              url: review_url,
              files: files.length,
              scope: parsed.files?.length ? parsed.files.join(",") : "all",
              base: parsed.base || "working_tree",
              repo: root.path,
            },
          })

          await ctx.client.app.log({
            body: {
              service: "diff-review",
              level: "info",
              message: `review launched for ${context.sessionID}`,
              extra: {
                url: review_url,
                files: files.length,
                opened,
                base: parsed.base || "working_tree",
                repo: root.path,
              },
            },
            query: {
              directory: context.directory,
            },
          })

          context.abort.addEventListener(
            "abort",
            () => {
              resolve({
                cancelled: true,
                round: base.round + 1,
                notes: "",
                findings: base.findings,
                json_path: "",
                md_path: "",
                url: review_url,
                opened,
              })
            },
            { once: true },
          )

          const result = await wait
          setTimeout(() => server.stop(true), 150)

          if (!result.cancelled) {
            return format({
              ...result,
              url: review_url,
              opened,
            })
          }

          return format({
            ...result,
            url: review_url,
            opened,
          })
        },
      }),
    },
  }
}

export default DiffReviewPlugin
