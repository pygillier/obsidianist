# Obsidianist — Task Backlog

## Critical / Bugs

- [ ] **[BUG] `saveSettings()` not awaited before `releaseSyncLock()`** — `main.ts:143,150`. Lock is released before settings are persisted, creating a race window.
- [ ] **[BUG] Sync lock bypassed via direct assignment** — `main.ts:194,223,228`. `this.syncLock = false` is set directly instead of calling `releaseSyncLock()`, breaking encapsulation.
- [ ] **[BUG] `closeTask` / `openTask` not awaited before cache update** — `syncModule.ts:529,537`. Cache is updated before the API call resolves, leaving state inconsistent on failure.
- [ ] **[BUG] `forEach` with async callbacks in metadata update** — `syncModule.ts:947`. `forEach` does not await async operations; switch to `for...of` or `Promise.all`.
- [ ] **[BUG] `deleteTaskIdFromMetadata` never saves the new metadata** — `cacheOperation.ts:67-81`. Computes a new metadata object but never writes it back; the deletion has no effect.
- [ ] **[BUG] Parent task accessed without null check** — `taskParser.ts:150-151`. `loadTaskFromCacheID()` can return `undefined`; `parentTask.projectId` will throw.
- [ ] **[BUG] Wrong field passed to `localDateStringToUTCDatetimeString`** — `todoistAPI.ts:106`. `task.dueDatetime` is passed instead of `task.dueDate`.
- [ ] **[BUG] `todoistId.toString()` called without null guard** — `syncModule.ts:387`. `todoistId` can be null at that point.
- [ ] **[BUG] `event.parent_item_id` used instead of `event.parentItemId`** — `syncModule.ts:797`. Wrong property name (snake_case vs camelCase from SDK).
- [ ] **[BUG] Duplicate unreachable `return` statement** — `taskParser.ts:364`. Second `return localDateString` is dead and signals a logic error.

---

## Dead Code

- [ ] **[DEAD] Remove `TodoistRestAPI`** — `main.ts`, `src/todoistRestAPI.ts`. Legacy class still instantiated but all active code uses `TodoistAPI`. Remove instantiation in `main.ts` (`initializeModuleClass`, `checkModuleClass`) and delete `todoistRestAPI.ts`.
- [ ] **[DEAD] Remove unused import `import {file} from "zod"`** — `fileOperation.ts:4`.
- [ ] **[DEAD] Remove unused destructured variables `todoist_projectId`, `todoist_url`** — `syncModule.ts:282-285`.
- [ ] **[DEAD] Remove commented-out front-matter update blocks** — `syncModule.ts:86-91, 193-198, 336-341`. Same pattern repeated three times, all commented out.
- [ ] **[DEAD] Remove trivial `getFileMetadatas()` wrapper** — `cacheOperation.ts:34-36`. Just returns `this.plugin.settings.fileMetadata`; callers can access directly.
- [ ] **[DEAD] Remove invalid/orphan import `import Timestamp = module`** — `cacheOperation.ts:5`. Malformed syntax that shouldn't compile.
- [ ] **[DEAD] Remove `import {Runtime} from "node:inspector"`** — `cacheOperation.ts:4`. Not used anywhere.

---

## Type Safety

- [ ] **[TYPES] Replace `any` in settings interface** — `settings.ts:16,17,19`. `todoistTasksData`, `fileMetadata`, and `statistics` are typed as `any`; define proper interfaces.
- [ ] **[TYPES] Remove `@ts-ignore` in `getAllProjects`** — `todoistAPI.ts:39,49`. Type `allProjects` as `PersonalProject[] | WorkspaceProject[]` or appropriate SDK type.
- [ ] **[TYPES] Add type to `newMetadata` parameter** — `cacheOperation.ts:51`. Parameter has no type annotation.
- [ ] **[TYPES] Add type to `task` parameter in `updateTaskToCacheByID`** — `cacheOperation.ts:243`. No type annotation on the parameter.
- [ ] **[TYPES] Replace `Object` parameter type in comparison methods** — `taskParser.ts:233,246`. Use `TaskObject` and `Task` instead of the generic `Object`.
- [ ] **[TYPES] Add return types to cache methods** — `cacheOperation.ts`. Several methods (e.g. `loadTasksFromCache`) lack return type annotations.
- [ ] **[TYPES] Fix `readContentFromFilePath` return type** — `fileOperation.ts`. Returns `string | boolean`; callers don't check the type. Change to `string | null` or throw on error.

---

## Duplication

- [ ] **[DUP] Consolidate `localDateStringToUTCDatetimeString`** — defined separately in `todoistRestAPI.ts`, `taskParser.ts`, and `utils.ts`. Keep only the `utils.ts` version and import from there.
- [ ] **[DUP] Extract task close/reopen + cache update into a helper** — the pattern of calling `closeTask`/`openTask` then updating the cache appears multiple times in `syncModule.ts`.
- [ ] **[DUP] Extract file-read-with-null-check pattern** — reading file content with an existence check is repeated at `syncModule.ts:20-37`, `214-231`, `591-609`; extract to a single method.

---

## Architecture

- [ ] **[ARCH] Complete migration from `TodoistRestAPI` to `TodoistAPI`** — audit all remaining `todoistRestAPI` call sites in `syncModule.ts` and migrate them; then remove the legacy class (see Dead Code item above).
- [ ] **[ARCH] Replace polling sync lock with a Promise-based mutex** — `main.ts:514-570`. Current implementation polls with `setTimeout` for up to 10 s. Use a proper async lock (e.g. a queued Promise chain).
- [ ] **[ARCH] Unify cache update methods** — `cacheOperation.ts` has four different patterns (`appendTaskToCache`, `updateTaskToCacheByID`, `closeTaskToCacheByID`, `modifyTaskToCacheByID`) with overlapping responsibilities. Consolidate into a single `upsertTask(id, changes)`.
- [ ] **[ARCH] Define proper interfaces for `todoistTasksData` and `fileMetadata`** — currently untyped blobs in settings; define `TasksData`, `FileMetadata` interfaces in `interfaces.ts`.
- [ ] **[ARCH] Reduce coupling between `TodoistSync` and other modules** — `syncModule.ts` directly accesses `plugin.todoistAPI`, `plugin.cacheOperation`, `plugin.fileOperation`, `plugin.taskParser`. Pass dependencies via constructor instead of going through the plugin root.

---

## Error Handling

- [ ] **[ERR] Empty `catch` block in `modifyTaskToCacheByID`** — `cacheOperation.ts:288-290`. Swallows all errors silently; at minimum log them.
- [ ] **[ERR] `readContentFromFilePath` returns `false` on error** — `fileOperation.ts`. Callers cast the return value without checking; replace with thrown errors or `null`.
- [ ] **[ERR] Establish a consistent error reporting strategy** — currently a mix of `console.error`, `new Notice()`, silent swallowing, and re-throwing. Decide on one pattern per error severity level and apply it uniformly.

---

## Naming

- [ ] **[NAME] Fix typo `SetDefalutProjectInTheFilepathModal`** — `modal.ts:9` and `main.ts`. Rename to `SetDefaultProjectInTheFilepathModal`.
- [ ] **[NAME] Rename `TodoistRestAPI` methods to camelCase** — methods like `AddTask`, `GetActiveTasks` violate the camelCase convention used everywhere else (moot if the class is deleted).
- [ ] **[NAME] Rename confusing boolean variables in task comparison** — `syncModule.ts:233,241,254`. `contentModified` is set via `!compare()` which makes the semantics hard to read; name them `isContentChanged` etc.

---

## Performance

- [ ] **[PERF] Cache `getActiveViewOfType()` result** — `main.ts:369-380`. Called multiple times in succession; cache in a local variable.
- [ ] **[PERF] Use `Set` for task ID lookup in deleted-task check** — `syncModule.ts:54-57`. `currentFileContent.includes(taskId)` is O(n·m); build a `Set<string>` of IDs found in the file instead.
- [ ] **[PERF] Avoid loading full task cache just to filter event IDs** — `syncModule.ts:835`. Load only IDs from cache, not full `Task` objects, when checking which events are already synced.
