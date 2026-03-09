# Obsidianist

Seamless bidirectional task synchronisation between [Obsidian](https://obsidian.md) and [Todoist](https://todoist.com).

---

## Features

| Feature               | Obsidian → Todoist | Todoist → Obsidian |
|-----------------------|:------------------:|:------------------:|
| Add task              |         ✅          |         🔜        |
| Delete task           |         ✅          |         🔜        |
| Modify task content   |         ✅          |         ✅        |
| Modify due date       |         ✅          |         ✅        |
| Modify labels / tags  |         ✅          |         🔜        |
| Modify priority       |         ✅          |         🔜        |
| Mark as completed     |         ✅          |         ✅        |
| Mark as uncompleted   |         ✅          |         ✅        |
| Task notes / comments |         🔜         |         ✅         |
| Modify project        |         🔜         |         🔜         |
| Modify description    |         🔜         |         🔜         |

---

## Installation

### Community plugins (recommended)

1. Open **Settings → Community plugins** and disable Restricted mode.
2. Click **Browse**, search for `Obsidianist`, and click **Install**.
3. Enable the plugin under **Installed plugins**.

### Manual

1. Download the latest release from the [Releases](https://github.com/pygillier/obsidianist/releases) page.
2. Copy `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/obsidianist/` inside your vault.
3. Enable the plugin in **Settings → Community plugins**.

---

## Configuration

1. Go to **Settings → Obsidianist**.
2. Paste your **Todoist API token** (found at <https://app.todoist.com/app/settings/integrations/developer>) and click the send button to initialise.
3. Choose a **Default project** — new tasks without an explicit project tag are sent here.

### Available settings

| Setting                 | Default | Description                                                                 |
|-------------------------|---------|-----------------------------------------------------------------------------|
| Todoist API token       | —       | Required. Your personal Todoist API token.                                  |
| Automatic sync interval | 300 s   | How often the background sync runs. Minimum 20 s.                           |
| Default project         | Inbox   | Target project for tasks with no project tag.                               |
| Full vault sync         | Off     | When enabled, `#todoist` is added to every task in the vault automatically. |
| Use Desktop URIs        | On      | Links open in the Todoist app (`todoist://`) instead of the browser.        |
| Debug mode              | Off     | Prints verbose logs to the developer console.                               |

---

## Usage

### Task format

Mark any Markdown task with `#todoist` and it will be picked up on the next sync:

```markdown
- [ ] My task #todoist
- [ ] Buy groceries 📅2025-06-01 !!2 #work #todoist
    - [ ] Child task #todoist
```

#### Syntax reference

| Token           | Description                                                                      | Example                            |
|-----------------|----------------------------------------------------------------------------------|------------------------------------|
| `#todoist`      | Marks the line for sync. Required unless Full vault sync is on.                  | `- [ ] task #todoist`              |
| `📅 YYYY-MM-DD` | Due date. Also accepts `🗓`, `🗓️`, `📆`.                                        | `- [ ] task 📅2025-06-01 #todoist` |
| `!!1` – `!!4`   | Priority. `!!4` = urgent (red), `!!1` = natural. Must have spaces on both sides. | `- [ ] task !!4 #todoist`          |
| `#projectName`  | If the tag matches a project name exactly, the task is sent to that project.     | `- [ ] task #Work #todoist`        |
| `#tag`          | Any tag that does not match a project name becomes a Todoist label.              | `- [ ] task #tagA #tagB #todoist`  |

After a task is created, the plugin writes its Todoist ID and a deep-link back into the line:

```markdown
- [ ] My task #todoist %%[todoist_id:: 123456789]%% [link](todoist://task?id=123456789)
```

### Project assignment priority

1. File-level default project (set via command, see below).
2. Tag matching a project name (`#ProjectName`).
3. Global default project from settings.
4. Parent task's project (for indented child tasks).

### Per-file default project

Open the command palette (`Ctrl/Cmd + P`) and run **Obsidianist: Set default project for current file**. A dropdown lets you pick a project; the selection is stored per-file and shown in the status bar.

### Manual sync

In the plugin settings, click **Sync** to trigger an immediate synchronisation, or **Check Database** to scan for inconsistencies and unsynced tasks.

---

## How sync works

### Obsidian → Todoist

| Trigger                                                   | Action                                                                      |
|-----------------------------------------------------------|-----------------------------------------------------------------------------|
| New `#todoist` line detected (editor change or file save) | Task created via Todoist REST API v2; ID written back into the line.        |
| Cursor leaves a modified task line                        | Changed fields (content, due date, labels, priority) are sent as an update. |
| `Delete` / `Backspace` removes a task ID from the file    | Task deleted in Todoist.                                                    |
| Checkbox clicked                                          | Task closed or reopened in Todoist.                                         |

### Todoist → Obsidian

Background sync (default every 5 min) fetches activity events originating outside Obsidian and applies them to vault files:

| Event            | Action                             |
|------------------|------------------------------------|
| Task completed   | Checkbox set to `[x]` in the file. |
| Task uncompleted | Checkbox reset to `[ ]`.           |
| Content updated  | Task text replaced in the file.    |
| Due date updated | Date token updated or removed.     |
| Comment added    | Note appended below the task line. |
| Project event    | Project cache refreshed.           |

---

## Data storage

All data is persisted in Obsidian's plugin storage (`loadData` / `saveData`):

| Key                         | Contents                                                               |
|-----------------------------|------------------------------------------------------------------------|
| `todoistTasksData.tasks`    | Cached `Task[]` objects, each extended with a `.path` vault filepath.  |
| `todoistTasksData.projects` | Cached project list.                                                   |
| `todoistTasksData.events`   | Already-processed activity event IDs (deduplication).                  |
| `fileMetadata`              | Map of `filepath → { todoistTasks, todoistCount, defaultProjectId? }`. |
| `lastSyncTime`              | Timestamp used as `dateFrom` when fetching activity events.            |

---

## Development

```bash
npm install        # install dependencies
npm run dev        # watch mode (rebuilds on change)
npm run build      # production build (runs tsc first)
npm run version    # bump version in manifest.json and versions.json
```

No test suite exists currently.

---

## Contributing

Pull requests are welcome. Please open an issue first to discuss significant changes.

## License

Released under the [GNU GPLv3 License](LICENSE.md).
