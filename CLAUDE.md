# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (watch mode)
npm run dev

# Production build (runs tsc type check first)
npm run build

# Build without tsc type check
npm run build-without-tsc

# Bump version (updates manifest.json and versions.json)
npm run version
```

No test suite exists currently.

## Architecture

This is an Obsidian plugin that provides bidirectional task synchronization between Obsidian markdown files and Todoist.

### Plugin Entry Point

`main.ts` — The `Obsidianist` class (extends Obsidian `Plugin`) owns all module instances as properties and wires up all event handlers:
- `editor-change` → detects new task lines (when full vault sync is off)
- `vault.modify` → scans modified files for new tasks (background files only)
- `vault.rename` → updates cached file paths and task descriptions
- `keyup` (Delete/Backspace) → checks for deleted tasks
- `click` (checkbox) → completes/reopens tasks
- Arrow key navigation → triggers modified task check on line departure
- `setInterval` → scheduled sync (default 300s)

**SyncLock**: All sync operations use `acquireSyncLock()` / `releaseSyncLock()` to prevent concurrent API calls. Lock waits up to 10 seconds before throwing.

### Module Classes (all constructed in `initializePlugin`)

| Class | File | Role |
|-------|------|------|
| `TodoistAPI` | `src/todoistAPI.ts` | Wraps `@doist/todoist-api-typescript` SDK for REST API v2 (tasks, projects, activities) |
| `TodoistSyncAPI` | `src/todoistSyncAPI.ts` | Direct fetch calls to Todoist Sync API v9 for activity events; filters out events originating from Obsidian |
| `TodoistSync` | `src/syncModule.ts` | Core bidirectional sync logic (see below) |
| `TaskParser` | `src/taskParser.ts` | Parses markdown task lines into `TaskObject`; handles parent/child detection via indentation |
| `CacheOperation` | `src/cacheOperation.ts` | All reads/writes to `plugin.settings` (the persisted cache) |
| `FileOperation` | `src/fileOperation.ts` | Reads/writes to vault markdown files for task state changes |

`TodoistRestAPI` (`src/todoistRestAPI.ts`) is a legacy class being phased out on the current `claude-refactoring` branch — prefer `TodoistAPI` for new code.

### Data Storage

Everything is persisted in `plugin.settings` (Obsidian's `loadData`/`saveData`):
- `todoistTasksData.tasks` — cached Todoist `Task[]` objects, augmented with a `.path` property (vault filepath)
- `todoistTasksData.projects` — cached Todoist projects
- `todoistTasksData.events` — already-processed `ActivityEvent[]` (used to detect new unsynced events by ID)
- `fileMetadata` — map of `filepath → { todoistTasks: string[], todoistCount: number, defaultProjectId?: string }`
- `lastSyncTime` — timestamp used as `dateFrom` filter when fetching activity events

### Sync Flow: Todoist → Obsidian (`syncTodoistToObsidian`)

1. Fetch all activity events since `lastSyncTime` (via `TodoistAPI.getActivities`) filtered to non-Obsidian clients
2. Subtract already-processed events (matched by `event.id` against cache)
3. Categorize by type: completed, uncompleted, updated (content/due date), added notes, project events
4. Apply each category to vault files via `FileOperation`
5. Save processed events to cache; update `lastSyncTime`

### Sync Flow: Obsidian → Todoist

- **New task**: `editor-change` detects `#todoist` tag without `[todoist_id::]` → `addTaskFromLine` → API create → writes `%%[todoist_id:: <id>]%%` and `[link](...)` back into the line
- **Modified task**: on line departure (cursor move) → `lineModifiedTaskCheck` → compares line parse vs cached task → API update for changed fields
- **Deleted task**: on Delete/Backspace → `deletedTaskCheck` → cross-references `fileMetadata.todoistTasks` against file content → API delete for missing IDs

### Task Format in Markdown

```
- [ ] Task content !!2 🗓️ 2024-01-15 #todoist #label %%[todoist_id:: 123456]%% [link](todoist://task?id=123456)
    - [ ] Child task #todoist %%[todoist_id:: 789012]%% [link](...)
```

- `#todoist` — marks the line as a synced task (required)
- `%%[todoist_id:: <id>]%%` — Obsidian inline metadata storing the Todoist task ID
- `!!1`–`!!4` — priority (must have spaces on both sides)
- `🗓️`/`📅`/`📆` + `YYYY-MM-DD` — due date
- Indented child tasks: parent is found by scanning upward for the nearest line with less indentation that has a `[todoist_id::]`
- Tags (excluding `#todoist`) become Todoist labels; a tag matching a project name sets `projectId`

### Project Assignment Priority

1. File-specific default project (stored in `fileMetadata[path].defaultProjectId`)
2. Tag matching a project name in the projects cache
3. Global default project (`settings.defaultProjectId`)
4. Parent task's project (for child tasks)
