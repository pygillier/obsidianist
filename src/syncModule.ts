import Todoistian from "../main";
import { TodoistAPI } from "./todoistAPI";
import { CacheOperation } from "./cacheOperation";
import { FileOperation } from "./fileOperation";
import { TaskParser } from "./taskParser";
import { App, Editor, MarkdownView, Notice, TFile } from "obsidian";
import { ActivityEvent, Task } from "@doist/todoist-api-typescript";
import { filterActivityEvents } from "./utils";
import { FileMetadata, LocalTask } from "./interfaces";

export class TodoistSync {
	app: App;
	plugin: Todoistian;
	private todoistAPI: TodoistAPI;
	private cacheOperation: CacheOperation;
	private fileOperation: FileOperation;
	private taskParser: TaskParser;

	constructor(app: App, plugin: Todoistian) {
		this.app = app;
		this.plugin = plugin;
		this.todoistAPI = plugin.todoistAPI;
		this.cacheOperation = plugin.cacheOperation;
		this.fileOperation = plugin.fileOperation;
		this.taskParser = plugin.taskParser;
	}

	private async getFileContext(
		file_path: string,
	): Promise<{ filepath: string; content: string }> {
		if (file_path) {
			const file = this.app.vault.getAbstractFileByPath(file_path);
			const content =
				file instanceof TFile ? await this.app.vault.read(file) : "";
			return { filepath: file_path, content };
		} else {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			const file = this.app.workspace.getActiveFile();
			return { filepath: file?.path ?? "", content: view?.data ?? "" };
		}
	}

	async deletedTaskCheck(file_path: string = ""): Promise<void> {
		const { filepath, content: currentFileValue } =
			await this.getFileContext(file_path);

		const frontMatter = this.cacheOperation.getFileMetadata(filepath);
		if (!frontMatter || !frontMatter.todoistTasks) {
			console.debug("frontmatter没有task");
			return;
		}

		//console.log(currentFileValue)
		const currentFileValueWithOutFrontMatter = currentFileValue.replace(
			/^---[\s\S]*?---\n/,
			"",
		);
		const frontMatter_todoistTasks = frontMatter.todoistTasks;
		const frontMatter_todoistCount = frontMatter.todoistCount;

		const presentIds = new Set(
			Array.from(
				currentFileValueWithOutFrontMatter.matchAll(
					/\[todoist_id::\s*(\w+)\]/g,
				),
			).map((m) => m[1]),
		);

		const deleteTasksPromises = frontMatter_todoistTasks
			.filter((taskId: string) => !presentIds.has(taskId))
			.map(async (taskId: string) => {
				try {
					await this.todoistAPI.deleteTask(taskId);
					new Notice(`task ${taskId} is deleted`);
					return taskId;
				} catch (error) {
					console.error(`Failed to delete task ${taskId}: ${error}`);
				}
			});

		const deletedTaskIds = await Promise.all(deleteTasksPromises);
		const deletedTaskAmount = deletedTaskIds.length;
		if (!deletedTaskIds.length) {
			//console.log("没有删除任务");
			return;
		}
		this.cacheOperation.deleteTaskFromCacheByIDs(deletedTaskIds);
		//console.log(`删除了${deletedTaskAmount} 条 task`)
		await this.plugin.saveSettings();
		// 更新 newFrontMatter_todoistTasks 数组

		// Disable automatic merging

		const newFrontMatter_todoistTasks = frontMatter_todoistTasks.filter(
			(taskId: string) => !deletedTaskIds.includes(taskId),
		);

		const newFileMetadata = {
			todoistTasks: newFrontMatter_todoistTasks,
			todoistCount: frontMatter_todoistCount - deletedTaskAmount,
		};
		this.cacheOperation.updateFileMetadata(filepath, newFileMetadata);
	}

	/**
	 * Create a task from the provided line
	 *
	 * @param editor
	 * @param view
	 */
	async addTaskFromLine(editor: Editor, view: MarkdownView): Promise<void> {
		const filePath = view.file?.path ?? "";
		const fileContent = view.data;
		const cursor = editor.getCursor();
		const line = cursor.line;
		const linetxt = editor.getLine(line);

		const extractedTask = this.taskParser.convertLineToTask({
			lineContent: linetxt,
			lineNumber: line,
			fileContent: fileContent,
			filePath: filePath,
		});

		try {
			const newTask = await this.todoistAPI.addTask(extractedTask);

			newTask.path = filePath;

			new Notice(`new task ${newTask.content} id is ${newTask.id}`);

			this.cacheOperation.upsertTask(newTask.id, newTask);

			// WHen a task is created with completed status, need to close it in todoist and cache
			if (extractedTask.isCompleted === true) {
				await this.todoistAPI.closeTask(newTask.id);
				this.cacheOperation.closeTaskToCacheByID(newTask.id);
			}
			await this.plugin.saveSettings();

			// Insert the Todoist ID and link back to the task in the file
			const text_with_out_link = `${linetxt} %%[todoist_id:: ${newTask.id}]%%`;
			const link = this.plugin.settings.useAppURI
				? `[link](todoist://task?id=${newTask.id})`
				: `[link](${newTask.url})`;
			const text = this.taskParser.addTodoistLink(
				text_with_out_link,
				link,
			);
			const from = { line: cursor.line, ch: 0 };
			const to = { line: cursor.line, ch: linetxt.length };
			view.app.workspace.activeEditor?.editor?.replaceRange(
				text,
				from,
				to,
			);

			// Update file metadata in cache
			const metadata: FileMetadata =
				this.cacheOperation.getFileMetadata(filePath);

			metadata.todoistTasks.push(newTask.id);
			metadata.todoistCount = metadata.todoistTasks.length;

			this.cacheOperation.updateFileMetadata(filePath, metadata);
		} catch (error) {
			console.error("Error adding task:", error);
			console.error(`The error occurred in the file: ${filePath}`);
			return;
		}
	}

	async fullTextNewTaskCheck(file_path: string): Promise<void> {
		const { filepath, content } = await this.getFileContext(file_path);

		if (this.plugin.settings.enableFullVaultSync) {
			await this.fileOperation.addTodoistTagToFile(filepath);
		}

		const frontMatter = this.cacheOperation.getFileMetadata(filepath);
		if (!frontMatter) console.debug("frontmatter is empty");
		const newFrontMatter: FileMetadata = frontMatter
			? { ...frontMatter }
			: { todoistTasks: [], todoistCount: 0 };

		const lines = content.split("\n");
		let hasNewTask = false;

		for (let i = 0; i < lines.length; i++) {
			if (!this.isUnregisteredTask(lines[i])) continue;
			const registered = await this.registerNewTask(
				lines[i],
				i,
				lines,
				filepath,
				content,
				newFrontMatter,
			);
			if (registered) hasNewTask = true;
		}

		if (hasNewTask) {
			await this.saveFileAndMetadata(filepath, lines, newFrontMatter);
		}
	}

	private isUnregisteredTask(line: string): boolean {
		return (
			!this.taskParser.hasTodoistId(line) &&
			this.taskParser.hasTodoistTag(line)
		);
	}

	private async registerNewTask(
		line: string,
		lineIndex: number,
		lines: string[],
		filepath: string,
		content: string,
		frontMatter: FileMetadata,
	): Promise<boolean> {
		console.debug(filepath);
		const currentTask = this.taskParser.convertLineToTask({
			lineContent: line,
			lineNumber: lineIndex,
			fileContent: content,
			filePath: filepath,
		});
		if (!currentTask) return false;
		console.debug(currentTask);

		try {
			const newTask = await this.todoistAPI.addTask(currentTask);
			const { id: todoist_id } = newTask;
			newTask.path = filepath;
			console.debug(newTask);
			new Notice(`new task ${newTask.content} id is ${newTask.id}`);

			this.cacheOperation.upsertTask(newTask.id, newTask);
			if (currentTask.isCompleted) {
				await this.todoistAPI.closeTask(newTask.id);
				this.cacheOperation.closeTaskToCacheByID(todoist_id);
			}
			await this.plugin.saveSettings();

			lines[lineIndex] = this.taskParser.addTodoistLink(
				`${line} %%[todoist_id:: ${todoist_id}]%%`,
				`[link](${newTask.url})`,
			);
			frontMatter.todoistCount = (frontMatter.todoistCount ?? 0) + 1;
			frontMatter.todoistTasks = [
				...(frontMatter.todoistTasks || []),
				todoist_id,
			];
			return true;
		} catch (error) {
			console.error("Error adding task:", error);
			return false;
		}
	}

	private async saveFileAndMetadata(
		filepath: string,
		lines: string[],
		frontMatter: FileMetadata,
	): Promise<void> {
		try {
			const vaultFile = this.app.vault.getAbstractFileByPath(filepath);
			if (vaultFile instanceof TFile) {
				await this.app.vault.modify(vaultFile, lines.join("\n"));
			}
			this.cacheOperation.updateFileMetadata(filepath, frontMatter);
		} catch (error) {
			console.error(error);
		}
	}

	async lineModifiedTaskCheck(
		filepath: string,
		lineText: string,
		lineNumber: number,
		fileContent: string,
	): Promise<void> {
		console.debug("Line modified, checking if it's a task line...");
		//const lineText = await this.fileOperation.getLineTextFromFilePath(filepath,lineNumber)

		if (this.plugin.settings.enableFullVaultSync) {
			//await this.fileOperation.addTodoistTagToLine(filepath,lineText,lineNumber,fileContent)

			//new empty metadata
			const metadata = this.cacheOperation.getFileMetadata(filepath);
			if (!metadata) {
				this.cacheOperation.newEmptyFileMetadata(filepath);
			}
			void this.plugin.saveSettings();
		}

		//检查task
		if (
			this.taskParser.hasTodoistId(lineText) &&
			this.taskParser.hasTodoistTag(lineText)
		) {
			const lineTask = this.taskParser.convertLineToTask({
				lineContent: lineText,
				lineNumber: lineNumber,
				fileContent: fileContent,
				filePath: filepath,
			});

			const lineTask_todoist_id = lineTask.todoistId?.toString();
			//console.log(lineTask_todoist_id )
			//console.log(`lastline task id is ${lastLineTask_todoist_id}`)
			const savedTask =
				this.cacheOperation.loadTaskByID(lineTask_todoist_id); //dataview中 id为数字，todoist中id为字符串，需要转换
			if (!savedTask) {
				console.warn(`本地缓存中没有task ${lineTask.todoistId}`);
				const url =
					this.taskParser.getObsidianUrlFromFilepath(filepath);
				console.debug(url);
				return;
			}
			//console.log(savedTask)

			//检查内容是否修改
			const lineTaskContent = lineTask.content;

			//content 是否修改
			const isContentChanged = !this.taskParser.taskContentCompare(
				lineTask,
				savedTask,
			);
			//tag or labels 是否修改
			const isTagsChanged = !this.taskParser.taskTagCompare(
				lineTask,
				savedTask,
			);
			//project 是否修改
			const isProjectChanged = !this.taskParser.taskProjectCompare(
				lineTask,
				savedTask,
			);
			//status 是否修改
			const isStatusChanged = !this.taskParser.taskStatusCompare(
				lineTask,
				savedTask,
			);
			//due date 是否修改
			const isDueDateChanged = !this.taskParser.compareTaskDueDate(
				lineTask,
				savedTask,
			);
			//parent id 是否修改
			const isParentIdChanged = !(
				lineTask.parentId === savedTask.parentId
			);
			//check priority
			const isPriorityChanged = !(
				lineTask.priority === savedTask.priority
			);

			try {
				let contentChanged = false;
				let tagsChanged = false;
				let projectChanged = false;
				let statusChanged = false;
				let dueDateChanged = false;
				let parentIdChanged = false;
				let priorityChanged = false;

				let updatedContent = {};
				if (isContentChanged) {
					console.debug(
						`Content modified for task ${lineTask_todoist_id}`,
					);
					updatedContent.content = lineTaskContent;
					contentChanged = true;
				}

				if (isTagsChanged) {
					console.debug(
						`Tags modified for task ${lineTask_todoist_id}`,
					);
					updatedContent.labels = lineTask.labels;
					tagsChanged = true;
				}

				if (isDueDateChanged) {
					console.debug(
						`Due date modified for task ${lineTask_todoist_id}`,
					);
					console.debug(lineTask.dueDate);
					//console.log(savedTask.due.date)
					if (lineTask.dueDate === "") {
						updatedContent.dueString = "no date";
					} else {
						updatedContent.dueDate = lineTask.dueDate;
					}

					dueDateChanged = true;
				}

				//todoist Rest api 没有 move task to new project的功能
				if (isProjectChanged) {
					//console.log(`Project id modified for task ${lineTask_todoist_id}`)
					//updatedContent.projectId = lineTask.projectId
					//projectChanged = false;
				}

				//todoist Rest api 没有修改 parent id 的借口
				if (isParentIdChanged) {
					//console.log(`Parnet id modified for task ${lineTask_todoist_id}`)
					//updatedContent.parentId = lineTask.parentId
					//parentIdChanged = false;
				}

				if (isPriorityChanged) {
					updatedContent.priority = lineTask.priority;
					priorityChanged = true;
				}

				if (
					contentChanged ||
					tagsChanged ||
					dueDateChanged ||
					projectChanged ||
					parentIdChanged ||
					priorityChanged
				) {
					//console.log("task content was modified");
					//console.log(updatedContent)
					const updatedTask = await this.todoistAPI.updateTask(
						lineTask.todoistId.toString(),
						updatedContent,
					);
					updatedTask.path = filepath;
					this.cacheOperation.updateTaskToCacheByID(updatedTask);
				}

				if (isStatusChanged) {
					console.debug(
						`Status modified for task ${lineTask_todoist_id}`,
					);
					if (lineTask.isCompleted === true) {
						await this.closeTask(lineTask.todoistId.toString());
					} else {
						await this.reopenTask(lineTask.todoistId.toString());
					}
					statusChanged = true;
				}

				if (
					contentChanged ||
					statusChanged ||
					dueDateChanged ||
					tagsChanged ||
					projectChanged ||
					priorityChanged
				) {
					console.debug(lineTask);
					console.debug(savedTask);
					//`Task ${lastLineTaskTodoistId} was modified`
					await this.plugin.saveSettings();
					let message = `Task ${lineTask_todoist_id} is updated.`;

					if (contentChanged) {
						message += " Content was changed.";
					}
					if (statusChanged) {
						message += " Status was changed.";
					}
					if (dueDateChanged) {
						message += " Due date was changed.";
					}
					if (tagsChanged) {
						message += " Tags were changed.";
					}
					if (projectChanged) {
						message += " Project was changed.";
					}
					if (priorityChanged) {
						message += " Priority was changed.";
					}

					new Notice(message);
				} else {
					//console.log(`Task ${lineTask_todoist_id} did not change`);
				}
			} catch (error) {
				console.error("Error updating task:", error);
			}
		}
	}

	async fullTextModifiedTaskCheck(file_path: string): Promise<void> {
		console.debug("ENTER fullTextModifiedTaskCheck");

		try {
			const { filepath, content } = await this.getFileContext(file_path);

			let hasModifiedTask = false;
			const lines = content.split("\n");

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				if (
					this.taskParser.hasTodoistId(line) &&
					this.taskParser.hasTodoistTag(line)
				) {
					try {
						await this.lineModifiedTaskCheck(
							filepath,
							line,
							i,
							content,
						);
						hasModifiedTask = true;
					} catch (error) {
						console.error("Error modifying task:", error);
					}
				}
			}

			if (hasModifiedTask) {
				try {
					// Perform necessary actions on the modified content and front matter
				} catch (error) {
					console.error("Error processing modified content:", error);
				}
			}
		} catch (error) {
			console.error("Error:", error);
		}
	}

	// Close a task by calling API and updating JSON file
	async closeTask(taskId: string): Promise<void> {
		try {
			await this.todoistAPI.closeTask(taskId);
			await this.fileOperation.completeTaskInFile(taskId);
			this.cacheOperation.closeTaskToCacheByID(taskId);
			void this.plugin.saveSettings();
			new Notice(`Task "${taskId}" closed.`);
		} catch (error) {
			console.error("Error closing task:", error);
			throw error;
		}
	}

	//open task
	async reopenTask(taskId: string): Promise<void> {
		try {
			await this.todoistAPI.openTask(taskId);
			await this.fileOperation.uncompleteTaskInFile(taskId);
			this.cacheOperation.reopenTaskToCacheByID(taskId);
			await this.plugin.saveSettings();
			new Notice(`Task "${taskId}" reopened.`);
		} catch (error) {
			console.error("Error while reopening task:", error);
			throw error;
		}
	}

	/**
	 * Sync missing completed items to Obsidian
	 *
	 * @param events
	 */
	async syncCompletedItemsToObsidian(events: ActivityEvent[]) {
		try {
			const processedEvents = [];
			for (const evt of events) {
				await this.fileOperation.completeTaskInFile(evt.objectId);
				this.cacheOperation.closeTaskToCacheByID(evt.objectId);
				new Notice(`Task ${evt.objectId} is closed.`);
				processedEvents.push(evt);
			}

			// Save processed events to cache
			this.cacheOperation.appendEventsToCache(processedEvents);
			await this.plugin.saveSettings();
		} catch (error) {
			throw new Error(
				"Error while processing unsyncedCompletedItems：" + error,
			);
		}
	}

	/**
	 * Update Obsidian with uncompleted events
	 *
	 * @param events
	 */
	async syncUncompletedItemsToObsidian(events: ActivityEvent[]) {
		try {
			const processedEvents: ActivityEvent[] = [];
			for (const evt of events) {
				await this.fileOperation.uncompleteTaskInFile(evt.objectId);
				this.cacheOperation.reopenTaskToCacheByID(evt.objectId);
				new Notice(`Task ${evt.objectId} is reopened.`);
				processedEvents.push(evt);
			}

			this.cacheOperation.appendEventsToCache(processedEvents);
			await this.plugin.saveSettings();
		} catch (error) {
			throw new Error(
				"Error while processing unsyncedUncompletedItems：" + error,
			);
		}
	}

	/**
	 * Sync missing updated events in Obsidian
	 * @param events
	 */
	async syncUpdatedItemsToObsidian(events: ActivityEvent[]) {
		try {
			const processedEvents: ActivityEvent[] = [];
			for (const e of events) {
				if (Object.hasOwn(e, "extraData") && e.extraData !== null) {
					if (Object.hasOwn(e.extraData, "lastDueDate")) {
						await this.syncUpdatedTaskDueDateToObsidian(e);
					}

					if (Object.hasOwn(e.extraData, "lastContent")) {
						await this.syncUpdatedTaskContentToObsidian(e);
					}
				}

				processedEvents.push(e);
			}

			this.cacheOperation.appendEventsToCache(processedEvents);
			await this.plugin.saveSettings();
		} catch (error) {
			throw new Error(
				"Error while processing unsyncedUpdatedItems：" + error,
			);
		}
	}

	async syncUpdatedTaskContentToObsidian(e: ActivityEvent) {
		await this.fileOperation.syncUpdatedTaskContentToTheFile(e);
		const task: LocalTask | null = this.cacheOperation.loadTaskByID(
			e.objectId,
		);

		if (task) {
			task.content =
				(e.extraData?.content as string | undefined) ?? task.content;
			this.cacheOperation.updateTaskToCacheByID(task);
			new Notice(`The content of Task ${e.objectId} has been modified.`);
		} else {
			console.error(`Task ${e.objectId} not found in cache.`);
		}
	}

	async syncUpdatedTaskDueDateToObsidian(e: ActivityEvent) {
		await this.fileOperation.syncUpdatedTaskDueDateToFile(e);

		const task: Task = await this.todoistAPI.getTaskById(e.objectId);
		this.cacheOperation.updateTaskToCacheByID(task);

		new Notice(`The due date of Task ${e.objectId} has been modified.`);
	}

	/**
	 * Sync added tasks notes to obsidian
	 * @param events
	 */
	async syncAddedTaskNoteToObsidian(events: ActivityEvent[]) {
		try {
			const processedEvents = [];
			for (const e of events) {
				await this.fileOperation.syncAddedTaskNoteToTheFile(e);
				new Notice(`Task ${e.parentItemId} note is added.`);
				processedEvents.push(e);
			}
			this.cacheOperation.appendEventsToCache(processedEvents);
			await this.plugin.saveSettings();
		} catch (error) {
			console.error(
				"Error while syncing tasks notes to obsidian：",
				error,
			);
		}
	}

	async syncTodoistToObsidian() {
		try {
			const unsyncedEvents = await this.getUnsyncedEvents();
			console.debug(`Events to synchronize: ${unsyncedEvents.length}`);

			const syncedTaskIds = new Set(
				this.cacheOperation.loadTasksFromCache().map((t) => t.id),
			);

			const eventsForTrackedTasks = this.filterEventsForTrackedTasks(
				unsyncedEvents,
				syncedTaskIds,
			);
			const eventsByType = this.categorizeEventsByType(
				eventsForTrackedTasks,
				unsyncedEvents,
				syncedTaskIds,
			);

			this.logEventCategories(eventsByType);
			await this.syncEventCategoriesToObsidian(eventsByType);
			await this.handleProjectEvents(eventsByType.projectEvents);
			await this.finalizeSync();
		} catch (err) {
			console.error("An error occurred while synchronizing:", err);
		}
	}

	private async getUnsyncedEvents(): Promise<ActivityEvent[]> {
		const allEvents = await this.todoistAPI.getNonObsidianActivities();
		const syncedEventIds = new Set(
			this.cacheOperation.loadEventsFromCache().map((e) => e.id),
		);

		return allEvents.filter(
			(event: ActivityEvent): boolean => !syncedEventIds.has(event.id),
		);
	}

	private filterEventsForTrackedTasks(
		unsyncedEvents: ActivityEvent[],
		syncedTaskIds: Set<string>,
	): ActivityEvent[] {
		return unsyncedEvents.filter((event: ActivityEvent): boolean =>
			syncedTaskIds.has(event.objectId),
		);
	}

	private categorizeEventsByType(
		eventsForTrackedTasks: ActivityEvent[],
		unsyncedEvents: ActivityEvent[],
		syncedTaskIds: Set<string>,
	) {
		const eventsForUntrackedNotes = unsyncedEvents.filter(
			(event: ActivityEvent): boolean =>
				!syncedTaskIds.has(event.parentItemId ?? ""),
		);

		return {
			completedItems: filterActivityEvents(eventsForTrackedTasks, {
				eventType: "completed",
				objectType: "task",
			}),
			uncompletedItems: filterActivityEvents(eventsForTrackedTasks, {
				eventType: "uncompleted",
				objectType: "task",
			}),
			updatedItems: filterActivityEvents(eventsForTrackedTasks, {
				eventType: "updated",
				objectType: "task",
			}),
			addedNotes: filterActivityEvents(eventsForUntrackedNotes, {
				eventType: "added",
				objectType: "note",
			}),
			projectEvents: filterActivityEvents(unsyncedEvents, {
				objectType: "project",
			}),
		};
	}

	private logEventCategories(
		eventsByType: ReturnType<typeof this.categorizeEventsByType>,
	) {
		if (eventsByType.projectEvents.length > 0)
			console.debug("unsyncedProjectEvents", eventsByType.projectEvents);
		if (eventsByType.completedItems.length > 0)
			console.debug(
				"unsyncedItemCompletedEvents",
				eventsByType.completedItems,
			);
		if (eventsByType.uncompletedItems.length > 0)
			console.debug(
				"unsyncedItemUncompletedEvents",
				eventsByType.uncompletedItems,
			);
		if (eventsByType.updatedItems.length > 0)
			console.debug(
				"unsyncedItemUpdatedEvents",
				eventsByType.updatedItems,
			);
		if (eventsByType.addedNotes.length > 0)
			console.debug("unsyncedNotesAddedEvents", eventsByType.addedNotes);
	}

	private async syncEventCategoriesToObsidian(
		eventsByType: ReturnType<typeof this.categorizeEventsByType>,
	) {
		await this.syncCompletedItemsToObsidian(eventsByType.completedItems);
		await this.syncUncompletedItemsToObsidian(
			eventsByType.uncompletedItems,
		);
		await this.syncUpdatedItemsToObsidian(eventsByType.updatedItems);
		await this.syncAddedTaskNoteToObsidian(eventsByType.addedNotes);
	}

	private async handleProjectEvents(projectEvents: ActivityEvent[]) {
		if (projectEvents.length > 0) {
			console.debug("New project event");
			await this.cacheOperation.saveProjectsToCache();
			this.cacheOperation.appendEventsToCache(projectEvents);
		}
	}

	private async finalizeSync() {
		this.cacheOperation.updateLastSyncTime(new Date());
		await this.plugin.saveSettings();
	}

	async backupTodoistAllResources() {
		try {
			const resources = await this.todoistAPI.getAllResources();
			const filename = this.generateBackupFilename();

			await this.app.vault.create(
				filename,
				JSON.stringify(resources, null, 2),
			);

			new Notice(`Todoist backup saved: ${filename}`);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			console.error("Failed to create Todoist backup:", message);
			new Notice(`Backup failed: ${message}`);
		}
	}

	private generateBackupFilename(): string {
		const now = new Date();
		const timestamp = now
			.toISOString()
			.replace(/[-:]/g, "")
			.replace(/\.\d{3}Z$/, "")
			.replace("T", "-");

		return `todoist-backup-${timestamp}.json`;
	}

	//After renaming the file, check all tasks in the file and update all links.
	async updateTaskDescription(filepath: string) {
		const metadata = this.cacheOperation.getFileMetadata(filepath);
		if (!metadata || !metadata.todoistTasks) {
			return;
		}
		const description =
			this.taskParser.getObsidianUrlFromFilepath(filepath);
		const updatedContent = {
			description: "",
		};
		updatedContent.description = description;
		try {
			for (const taskId of metadata.todoistTasks) {
				const updatedTask = await this.todoistAPI.updateTask(
					taskId,
					updatedContent,
				);
				updatedTask.path = filepath;
				this.cacheOperation.updateTaskToCacheByID(updatedTask);
			}
		} catch (error) {
			console.error("An error occurred in updateTaskDescription:", error);
		}
	}
}
