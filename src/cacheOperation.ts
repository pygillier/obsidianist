import {App, TAbstractFile} from "obsidian";
import Obsidianist from "../main";
import {ActivityEvent, Task} from "@doist/todoist-api-typescript";
import {Project} from "./interfaces";

interface Due {
	date?: string;
	[key: string]: any; // allow for additional properties
}

interface FileMetadata {
	todoistTasks: string[];
	todoistCount: number;
	defaultProjectId?: string;
}

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

	async getFileMetadata(filepath: string): Promise<FileMetadata> {
		return this.plugin.settings.fileMetadata[filepath] ?? {} as FileMetadata;
	}

	async getAllFileMetadata() {
		return this.plugin.settings.fileMetadata ?? null;
	}

	async newEmptyFileMetadata(filepath: string) {
		const metadatas = this.plugin.settings.fileMetadata;
		if (metadatas[filepath]) {
			return;
		} else {
			metadatas[filepath] = {};
		}
		metadatas[filepath].todoistTasks = [];
		metadatas[filepath].todoistCount = 0;
		// 将更新后的metadatas对象保存回设置对象中
		this.plugin.settings.fileMetadata = metadatas;
	}

	async updateFileMetadata(filepath: string, newMetadata: FileMetadata) {
		this.plugin.settings.fileMetadata[filepath] = newMetadata;
	}

	async deleteTaskFromFileMetadata(filepath: string, taskId: string) {
		const metadata: FileMetadata = await this.getFileMetadata(filepath);

		const newTodoistTasks = metadata.todoistTasks.filter(
			function (element) {
				return element !== taskId;
			},
		);

		const updatedMetadata: FileMetadata = {
			todoistTasks: newTodoistTasks,
			todoistCount: newTodoistTasks.length
		};

		await this.updateFileMetadata(filepath, updatedMetadata);
		await this.plugin.saveSettings();
	}

	/**
	 * Delete a filepath from file metadata.
	 * @param filepath
	 */
	async deleteEntryFromFileMetadata(filepath: string) {
		Reflect.deleteProperty(this.plugin.settings.fileMetadata, filepath);
		await this.plugin.saveSettings();
		console.log(`${filepath} is deleted from file metadatas.`);
	}

	/**
	 * Checks for errors in the file metadata cache and fix them if necessary.
	 */
	async checkFileMetadata() {
		const allFileMetadata = await this.getAllFileMetadata();

		for (const entry of allFileMetadata) {
			const key: string = allFileMetadata.indexOf(entry);
			const file: TAbstractFile | null = this.app.vault.getAbstractFileByPath(key);

			if (file === null) {
				// No metadata for this file, but the file exists. Clean up the metadata.
				if (entry.todoistTasks.length === 0) {
					console.log(`${key} does not exist and metadata is empty. Deleting from metadata cache.`);
					await this.deleteEntryFromFileMetadata(key);
				} else {
					// Tasks presents in cache but not in file, try to find the file for the first matching task.
					for (const task in entry.todoistTasks) {
						const searchResult = await this.plugin.fileOperation.searchFilepathsByTaskidInVault(
							task
						)
						if (searchResult) {
							console.log(`New file found for task ${task}: ${searchResult}`);
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
	getProjectForFile(filepath: string) : {projectName: string, projectId: string} {
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
			this.plugin.settings.fileMetadata[filepath].defaultProjectId = projectID;
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
	loadTasksFromCache(): Task[] {
		return this.plugin.settings.todoistTasksData.tasks;
	}

	// 覆盖保存所有task到cache
	saveTasksToCache(newTasks) {
		try {
			this.plugin.settings.todoistTasksData.tasks = newTasks;
		} catch (error) {
			console.error(`Error saving tasks to Cache: ${error}`);
			return false;
		}
	}

	appendEventsToCache(events: ActivityEvent[]) {
		try {
			this.plugin.settings.todoistTasksData.events.push(...events);
		} catch (error) {
			console.error(`Error append events to Cache: ${error}`);
		}
	}

	loadEventsFromCache() {
		return this.plugin.settings.todoistTasksData.events;
	}

	/**
	 * Add a Todoist task object to Cache
	 * @param task Task
	 * @returns void
	 */
	appendTaskToCache(task: Task): void {
		if (task === null) {
			return;
		}
		this.plugin.settings.todoistTasksData.tasks.push(task);
	}

	/**
	 * Load a task from Cache by ID
	 * @param taskId
	 */
	loadTaskByID(taskId: string): Task | null {

		const task =  this.plugin.settings.todoistTasksData.tasks.find((t: Task) => t.id === taskId);

		return task ?? null;
	}

	//覆盖update指定id的task
	updateTaskToCacheByID(task) {
		try {
			//删除就的task
			this.deleteTaskFromCache(task.id);
			//添加新的task
			this.appendTaskToCache(task);
		} catch (error) {
			console.error(`Error updating task to Cache: ${error}`);
			return [];
		}
	}

	//due 的结构  {date: "2025-02-25",isRecurring: false,lang: "en",string: "2025-02-25"}

	modifyTaskToCacheByID(
		taskId: string,
		{ content, due }: { content?: string; due?: Due },
	): void {
		try {
			const savedTasks = this.plugin.settings.todoistTasksData.tasks;
			const taskIndex = savedTasks.findIndex(
				(task) => task.id === taskId,
			);

			if (taskIndex !== -1) {
				const updatedTask = { ...savedTasks[taskIndex] };

				if (content !== undefined) {
					updatedTask.content = content;
				}

				if (due !== undefined) {
					if (due === null) {
						updatedTask.due = null;
					} else {
						updatedTask.due = due;
					}
				}

				savedTasks[taskIndex] = updatedTask;

				this.plugin.settings.todoistTasksData.tasks = savedTasks;
			} else {
				throw new Error(`Task with ID ${taskId} not found in cache.`);
			}
		} catch (error) {
			// Handle the error appropriately, e.g. by logging it or re-throwing it.
		}
	}

	//open a task status
	reopenTaskToCacheByID(taskId: string) {
		try {
			const savedTasks = this.plugin.settings.todoistTasksData.tasks;

			for (let i = 0; i < savedTasks.length; i++) {
				if (savedTasks[i].id === taskId) {
					savedTasks[i].isCompleted = false;
					break;
				}
			}
			this.plugin.settings.todoistTasksData.tasks = savedTasks;
		} catch (error) {
			console.error(`Error open task to Cache file: ${error}`);
		}
	}

	//close a task status
	closeTaskToCacheByID(taskId: string): void {
		try {
			const savedTasks = this.plugin.settings.todoistTasksData.tasks;

			for (let i = 0; i < savedTasks.length; i++) {
				if (savedTasks[i].id === taskId) {
					savedTasks[i].isCompleted = true;
					break;
				}
			}
			this.plugin.settings.todoistTasksData.tasks = savedTasks;
		} catch (error) {
			console.error(`Error close task to Cache file: ${error}`);
			throw error;
		}
	}

	// 通过 ID 删除任务
	deleteTaskFromCache(taskId) {
		try {
			const savedTasks = this.plugin.settings.todoistTasksData.tasks;
			const newSavedTasks = savedTasks.filter((t) => t.id !== taskId);
			this.plugin.settings.todoistTasksData.tasks = newSavedTasks;
		} catch (error) {
			console.error(`Error deleting task from Cache file: ${error}`);
		}
	}

	// 通过 ID 数组 删除task
	deleteTaskFromCacheByIDs(deletedTaskIds) {
		try {
			const savedTasks = this.plugin.settings.todoistTasksData.tasks;
			const newSavedTasks = savedTasks.filter(
				(t) => !deletedTaskIds.includes(t.id),
			);
			this.plugin.settings.todoistTasksData.tasks = newSavedTasks;
		} catch (error) {
			console.error(`Error deleting task from Cache : ${error}`);
		}
	}

	//通过 name 查找 project id
	getProjectIdByNameFromCache(projectName: string) {
		const targetProject = this.plugin.settings.todoistTasksData.projects.find(
			(obj:Project) => obj.name === projectName,
		);
		return targetProject ? targetProject.id : "";
	}

	getProjectNameByIdFromCache(projectId: string) {
		const targetProject = this.plugin.settings.todoistTasksData.projects.find(
			(obj: Project) => obj.id === projectId,
		);

		return targetProject ? targetProject.name : "";
	}

	/**
	 * Save projects to cache.
	 */
	async saveProjectsToCache() {
		try {
			this.plugin.settings.todoistTasksData.projects = await this.plugin.todoistAPI.getAllProjects();
			return true;
		} catch (error) {
			console.log(`error downloading projects: ${error}`);
			return false;
		}
	}

	async updateRenamedFilePath(oldpath: string, newpath: string) {
		try {
			console.log(`oldpath is ${oldpath}`);
			console.log(`newpath is ${newpath}`);
			const savedTask = await this.loadTasksFromCache();
			//console.log(savedTask)
			const newTasks = savedTask.map((obj) => {
				if (obj.path === oldpath) {
					return { ...obj, path: newpath };
				} else {
					return obj;
				}
			});
			//console.log(newTasks)
			await this.saveTasksToCache(newTasks);

			//update filepath
			const fileMetadatas = this.plugin.settings.fileMetadata;
			fileMetadatas[newpath] = fileMetadatas[oldpath];
			delete fileMetadatas[oldpath];
			this.plugin.settings.fileMetadata = fileMetadatas;
		} catch (error) {
			console.log(`Error updating renamed file path to cache: ${error}`);
		}
	}
}
