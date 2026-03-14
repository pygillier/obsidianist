import { App, TAbstractFile } from "obsidian";
import Obsidianist from "../main";
import { ActivityEvent, Task } from "@doist/todoist-api-typescript";
import { FileMetadata, LocalTask, Project } from "./interfaces";

export class CacheOperation {
	app: App;
	plugin: Obsidianist;

	constructor({ app, plugin }: { app: App; plugin: Obsidianist }) {
		this.app = app;
		this.plugin = plugin;
	}

	getLastSyncTime(): Date {
		return new Date(this.plugin.settings.lastSyncTime);
	}

	updateLastSyncTime(lastSyncTime: Date): void {
		this.plugin.settings.lastSyncTime = lastSyncTime.getTime();
	}

	getFileMetadata(filepath: string): FileMetadata {
		return (
			this.plugin.settings.fileMetadata[filepath] ?? {
				todoistCount: 0,
				todoistTasks: [],
			}
		);
	}

	getAllFileMetadata() {
		return this.plugin.settings.fileMetadata ?? null;
	}

	newEmptyFileMetadata(filepath: string) {
		const metadatas = this.plugin.settings.fileMetadata;
		if (metadatas[filepath]) {
			return;
		} else {
			metadatas[filepath] = {} as FileMetadata;
		}
		metadatas[filepath].todoistTasks = [];
		metadatas[filepath].todoistCount = 0;
		// 将更新后的metadatas对象保存回设置对象中
		this.plugin.settings.fileMetadata = metadatas;
	}

	updateFileMetadata(filepath: string, newMetadata: FileMetadata) {
		this.plugin.settings.fileMetadata[filepath] = newMetadata;
	}

	async deleteTaskFromFileMetadata(filepath: string, taskId: string) {
		const metadata: FileMetadata = this.getFileMetadata(filepath);

		const newTodoistTasks = metadata.todoistTasks.filter(
			function (element) {
				return element !== taskId;
			},
		);

		const updatedMetadata: FileMetadata = {
			todoistTasks: newTodoistTasks,
			todoistCount: newTodoistTasks.length,
		};

		this.updateFileMetadata(filepath, updatedMetadata);
		await this.plugin.saveSettings();
	}

	/**
	 * Delete a filepath from file metadata.
	 * @param filepath
	 */
	async deleteEntryFromFileMetadata(filepath: string) {
		Reflect.deleteProperty(this.plugin.settings.fileMetadata, filepath);
		await this.plugin.saveSettings();
		console.warn(`${filepath} is deleted from file metadatas.`);
	}

	/**
	 * Checks for errors in the file metadata cache and fix them if necessary.
	 */
	async checkFileMetadata() {
		const allFileMetadata = this.getAllFileMetadata();

		for (const [key, entry] of Object.entries(allFileMetadata)) {
			const file: TAbstractFile | null =
				this.app.vault.getAbstractFileByPath(key);

			if (file === null) {
				// No metadata for this file, but the file exists. Clean up the metadata.
				if (entry.todoistTasks.length === 0) {
					console.warn(
						`${key} does not exist and metadata is empty. Deleting from metadata cache.`,
					);
					await this.deleteEntryFromFileMetadata(key);
				} else {
					// Tasks presents in cache but not in file, try to find the file for the first matching task.
					for (const task of entry.todoistTasks) {
						const searchResult =
							await this.plugin.fileOperation.searchFilepathsByTaskidInVault(
								task,
							);
						if (searchResult) {
							console.debug(
								`New file found for task ${task}: ${searchResult}`,
							);
							await this.updateRenamedFilePath(key, searchResult);
							await this.plugin.saveSettings();
							break;
						}
					}
				}
			}
		}
	}

	/**
	 * Get the project for a given file.
	 *
	 * @param filepath - The file path.
	 * @returns The project name and ID.
	 */
	getProjectForFile(filepath: string): {
		projectName: string;
		projectId: string;
	} {
		const metadata = this.plugin.settings.fileMetadata;
		if (metadata[filepath] && metadata[filepath].defaultProjectId) {
			// Specific project for a given file
			const defaultProjectId = metadata[filepath].defaultProjectId;
			return {
				projectName: this.getProjectNameByIdFromCache(defaultProjectId),
				projectId: defaultProjectId,
			};
		} else {
			// Default one
			return {
				projectName: this.plugin.settings.defaultProjectName,
				projectId: this.plugin.settings.defaultProjectId,
			};
		}
	}

	/**
	 * Set the default project for a file
	 * @param filepath
	 * @param projectID
	 */
	setDefaultProjectForFile(filepath: string, projectID: string) {
		if (filepath in this.plugin.settings.fileMetadata) {
			this.plugin.settings.fileMetadata[filepath].defaultProjectId =
				projectID;
		} else {
			this.plugin.settings.fileMetadata[filepath] = {
				todoistCount: 0,
				todoistTasks: [],
				defaultProjectId: projectID,
			};
		}
	}

	/**
	 * Load all tasks from the cache
	 * @returns
	 */
	loadTasksFromCache(): LocalTask[] {
		return this.plugin.settings.todoistTasksData.tasks;
	}

	// 覆盖保存所有task到cache
	saveTasksToCache(newTasks: LocalTask[]): void {
		try {
			this.plugin.settings.todoistTasksData.tasks = newTasks;
		} catch (error) {
			console.error(`Error saving tasks to Cache: ${error}`);
		}
	}

	appendEventsToCache(events: ActivityEvent[]): void {
		this.plugin.settings.todoistTasksData.events.push(...events);
	}

	loadEventsFromCache(): ActivityEvent[] {
		return this.plugin.settings.todoistTasksData.events;
	}

	/**
	 * Insert or update a task in the cache.
	 * If a task with the given ID already exists its fields are merged with `changes`.
	 * If it does not exist and `changes` contains `content` (i.e. a full task), it is inserted.
	 */
	upsertTask(taskId: string, changes: Partial<LocalTask>): void {
		const tasks = this.plugin.settings.todoistTasksData.tasks;
		const idx = tasks.findIndex((t) => t.id === taskId);
		if (idx !== -1) {
			tasks[idx] = { ...tasks[idx], ...changes };
		} else if ("content" in changes) {
			tasks.push(changes as LocalTask);
		} else {
			console.error(`upsertTask: task ${taskId} not found in cache`);
		}
	}

	/**
	 * Load a task from Cache by ID
	 * @param taskId
	 */
	loadTaskByID(taskId: string): LocalTask {
		const task = this.plugin.settings.todoistTasksData.tasks.find(
			(t: Task) => t.id === taskId,
		);

		if (!task) {
			throw new Error(`Task not found in cache: ${taskId}`);
		}

		return task;
	}

	updateTaskToCacheByID(task: LocalTask): void {
		this.upsertTask(task.id, task);
	}

	reopenTaskToCacheByID(taskId: string): void {
		this.upsertTask(taskId, { isCompleted: false });
	}

	closeTaskToCacheByID(taskId: string): void {
		this.upsertTask(taskId, { isCompleted: true });
	}

	deleteTaskFromCacheByIDs(deletedTaskIds: string[]): void {
		try {
			const savedTasks = this.plugin.settings.todoistTasksData.tasks;
			this.plugin.settings.todoistTasksData.tasks = savedTasks.filter(
				(t) => !deletedTaskIds.includes(t.id),
			);
		} catch (error) {
			console.error(`Error deleting task from Cache : ${error}`);
		}
	}

	getProjectIdByNameFromCache(projectName: string): string {
		const targetProject =
			this.plugin.settings.todoistTasksData.projects.find(
				(obj: Project) => obj.name === projectName,
			);
		return targetProject ? targetProject.id : "";
	}

	getProjectNameByIdFromCache(projectId: string): string {
		const targetProject =
			this.plugin.settings.todoistTasksData.projects.find(
				(obj: Project) => obj.id === projectId,
			);

		return targetProject ? targetProject.name : "";
	}

	/**
	 * Save projects to cache.
	 */
	async saveProjectsToCache(): Promise<boolean> {
		try {
			this.plugin.settings.todoistTasksData.projects =
				await this.plugin.todoistAPI.getAllProjects();
			return true;
		} catch (error) {
			console.error(`Error downloading projects: ${error}`);
			return false;
		}
	}

	async updateRenamedFilePath(oldpath: string, newpath: string) {
		try {
			console.debug(`oldpath is ${oldpath}`);
			console.debug(`newpath is ${newpath}`);
			const savedTask = this.loadTasksFromCache();
			//console.log(savedTask)
			const newTasks = savedTask.map((obj) => {
				if (obj.path === oldpath) {
					return { ...obj, path: newpath };
				} else {
					return obj;
				}
			});
			//console.log(newTasks)
			this.saveTasksToCache(newTasks);

			//update filepath
			const fileMetadatas = this.plugin.settings.fileMetadata;
			fileMetadatas[newpath] = fileMetadatas[oldpath];
			delete fileMetadatas[oldpath];
			this.plugin.settings.fileMetadata = fileMetadatas;
		} catch (error) {
			console.error(
				`Error updating renamed file path to cache: ${error}`,
			);
		}
	}
}
