# Obsidianist Code Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           OBSIDIANIST PLUGIN                                │
│                              main.ts (Obsidianist)                          │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │ onload()
                                   ▼
                          ┌─────────────────┐
                          │ loadSettings()  │
                          │ initializePlugin│
                          └────────┬────────┘
                                   │
          ┌────────────────────────┼────────────────────────┐
          ▼                        ▼                         ▼
  ┌───────────────┐      ┌─────────────────┐      ┌──────────────────┐
  │ TodoistAPI    │      │ CacheOperation  │      │ TodoistRestAPI   │
  │ (REST v9 SDK) │      │ (settings data) │      │ (raw HTTP)       │
  └───────────────┘      └─────────────────┘      └──────────────────┘
          │                        │                         │
          └────────────────────────┼─────────────────────────┘
                                   │ all passed to
                                   ▼
                          ┌─────────────────┐
                          │  TodoistSync    │  ◄─── TaskParser
                          │  (syncModule)   │  ◄─── FileOperation
                          └────────┬────────┘  ◄─── TodoistSyncAPI
                                   │
         ┌─────────────────────────┴────────────────────────┐
         │                                                   │
         │           EVENT TRIGGERS (main.ts)                │
         │                                                   │
         ▼                                                   ▼
┌──────────────────────────────────────┐   ┌────────────────────────────────┐
│         DOM / Editor Events          │   │     Scheduled Sync (interval)  │
├──────────────────────────────────────┤   ├────────────────────────────────┤
│ keyup (Arrow keys)                   │   │ syncTodoistToObsidian()        │
│   └─► checkLineChanges()             │   │   └─► SyncAPI.getActivityEvents│
│       └─► lineModifiedTaskCheck()    │   │       ├─► syncCompleted        │
│                                      │   │       ├─► syncUncompleted      │
│ keyup (Delete/Backspace)             │   │       ├─► syncUpdated          │
│   └─► deletedTaskCheck()            │   │       └─► syncAddedNotes       │
│                                      │   │                                │
│ click (checkbox)                     │   │ fullTextNewTaskCheck() per file │
│   └─► closeTask() / reopenTask()    │   │ deletedTaskCheck() per file     │
│                                      │   │ fullTextModifiedTaskCheck()     │
│ editor-change                        │   └────────────────────────────────┘
│   └─► addTaskFromLine()             │
│                                      │
│ vault rename                         │
│   └─► updateTaskDescription()       │
│                                      │
│ vault modify (external file)         │
│   └─► fullTextNewTaskCheck()        │
└──────────────────────────────────────┘

━━━━━━━━━━━━━━━━ CORE OPERATIONS ━━━━━━━━━━━━━━━━

addTaskFromLine / fullTextNewTaskCheck:
  TaskParser.convertTextToTaskObject()
    └─► TodoistAPI.addTask()
        └─► CacheOperation.appendTaskToCache()
            └─► FileOperation: inject %%[todoist_id::]%% into file

lineModifiedTaskCheck:
  TaskParser.convertTextToTaskObject()
    └─► CacheOperation.loadTaskFromCacheID()
        └─► Compare fields (content/tags/dueDate/priority/status)
            ├─► TodoistRestAPI.UpdateTask()  ── content/tags/dueDate/priority
            └─► TodoistRestAPI.CloseTask() / OpenTask()  ── status

deletedTaskCheck:
  CacheOperation.getFileMetadata()
    └─► Find todoistTasks IDs missing from file content
        └─► TodoistAPI.deleteTask()
            └─► CacheOperation.deleteTaskFromCacheByIDs()

━━━━━━━━━━━━━━━━ API LAYER ━━━━━━━━━━━━━━━━

TodoistAPI (todoistAPI.ts)       ← @doist/todoist-api-typescript SDK (REST v9)
  addTask / closeTask / deleteTask / getProjects / getActiveTasks

TodoistRestAPI (todoistRestAPI.ts) ← raw HTTP calls
  UpdateTask / CloseTask / OpenTask / getTaskDueById

TodoistSyncAPI (todoistSyncAPI.ts) ← Todoist Sync API
  getAllResources / getNonObsidianAllActivityEvents / filterActivityEvents

━━━━━━━━━━━━━━━━ SYNC LOCK ━━━━━━━━━━━━━━━━

  acquireSyncLock() → [wait up to 10s] → set syncLock=true
  releaseSyncLock() → set syncLock=false
  All mutating operations are gated through the lock to prevent races.
```

## Key Data Flows

- **Obsidian → Todoist**: Editor events detect new/modified/deleted tasks and push changes via `TodoistAPI` / `TodoistRestAPI`
- **Todoist → Obsidian**: Scheduled interval polls `TodoistSyncAPI` for activity events not yet seen, then updates files via `FileOperation` and cache via `CacheOperation`
- **Cache** (`settings.fileMetadata` + task JSON): the source of truth for task IDs, used to diff what changed
