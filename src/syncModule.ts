import Obsidianist from "../main";
import {App, Editor, MarkdownView, Notice} from "obsidian";
import {ActivityEvent, Task} from "@doist/todoist-api-typescript";
import {filterActivityEvents} from "./utils";

type FrontMatter = {
	todoistTasks: string[];
	todoistCount: number;
};

export class TodoistSync {
	app: App;
	plugin: Obsidianist;

	constructor(app: App, plugin: Obsidianist) {
		this.app = app;
		this.plugin = plugin;
	}

	async deletedTaskCheck(file_path: string = ""): Promise<void> {
		let file;
		let currentFileValue;
		let view;
		let filepath;

		if (file_path != "") {
			file = this.app.vault.getAbstractFileByPath(file_path);
			filepath = file_path;
			currentFileValue = await this.app.vault.read(file);
		} else {
			view = this.app.workspace.getActiveViewOfType(MarkdownView);
			//const editor = this.app.workspace.activeEditor?.editor
			file = this.app.workspace.getActiveFile();
			filepath = file?.path;
			//使用view.data 代替 valut.read。vault.read有延迟
			currentFileValue = view?.data;
		}

		const frontMatter =
			await this.plugin.cacheOperation.getFileMetadata(filepath);
		if (!frontMatter || !frontMatter.todoistTasks) {
			console.log("frontmatter没有task");
			return;
		}

		//console.log(currentFileValue)
		const currentFileValueWithOutFrontMatter = currentFileValue.replace(
			/^---[\s\S]*?---\n/,
			"",
		);
		const frontMatter_todoistTasks = frontMatter.todoistTasks;
		const frontMatter_todoistCount = frontMatter.todoistCount;

		const deleteTasksPromises = frontMatter_todoistTasks
			.filter(
				(taskId: string) =>
					!currentFileValueWithOutFrontMatter.includes(taskId),
			)
			.map(async (taskId: string) => {
				try {
					this.plugin.todoistAPI.deleteTask(taskId);
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
		this.plugin.cacheOperation.deleteTaskFromCacheByIDs(deletedTaskIds);
		//console.log(`删除了${deletedTaskAmount} 条 task`)
		this.plugin.saveSettings();
		// 更新 newFrontMatter_todoistTasks 数组

		// Disable automatic merging

		const newFrontMatter_todoistTasks = frontMatter_todoistTasks.filter(
			(taskId: string) => !deletedTaskIds.includes(taskId),
		);

		/*
        await this.plugin.fileOperation.updateFrontMatter(file, (frontMatter) => {
          frontMatter.todoistTasks = newFrontMatter_todoistTasks;
          frontMatter.todoistCount = frontMatter_todoistCount - deletedTaskAmount;
        });
        */
		const newFileMetadata = {
			todoistTasks: newFrontMatter_todoistTasks,
			todoistCount: frontMatter_todoistCount - deletedTaskAmount,
		};
		await this.plugin.cacheOperation.updateFileMetadata(
			filepath,
			newFileMetadata,
		);
	}

	/**
	 * Create a task from the provided line
	 * 
	 * @param editor 
	 * @param view 
	 */
	async addTaskFromLine(
		editor: Editor,
		view: MarkdownView,
	): Promise<void> {

		const filepath = view.file?.path;
		const fileContent = view.data;
		const cursor = editor.getCursor();
		const line = cursor.line;
		const linetxt = editor.getLine(line);

		const extractedTask =
			await this.plugin.taskParser.convertTextToTaskObject(
				linetxt,
				filepath,
				fileContent,
				line,
			);

		try {
			const newTask =	await this.plugin.todoistAPI.addTask(extractedTask);

			const {
				id: todoist_id,
				projectId: todoist_projectId,
				url: todoist_url,
			} = newTask;
			
			// @ts-ignore - This is a custom property we're adding to the Task object, so we can ignore the type error
			newTask.path = filepath;

			new Notice(`new task ${newTask.content} id is ${newTask.id}`);

			this.plugin.cacheOperation.appendTaskToCache(newTask);

			// WHen a task is created with completed status, need to close it in todoist and cache
			if (extractedTask.isCompleted === true) {
				await this.plugin.todoistAPI.closeTask(newTask.id);
				this.plugin.cacheOperation.closeTaskToCacheByID(newTask.id);
			}
			this.plugin.saveSettings();

			// Insert the Todoist ID and link back to the task in the file
			const text_with_out_link = `${linetxt} %%[todoist_id:: ${newTask.id}]%%`;
			const link = this.plugin.settings.useAppURI
				? `[link](todoist://task?id=${newTask.id})`
				: `[link](${newTask.url})`;
			const text = this.plugin.taskParser.addTodoistLink(
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

			//处理frontMatter
			try {
				// 处理 front matter
				const frontMatter =
					await this.plugin.cacheOperation.getFileMetadata(
						filepath,
					);
				console.log(frontMatter);

				if (!frontMatter) {
					//console.log('frontmatter is empty');
					//return;
				}

				// 将 todoistCount 加 1
				const newFrontMatter = { ...frontMatter };
				newFrontMatter.todoistCount =
					(newFrontMatter.todoistCount ?? 0) + 1;

				// 记录 taskID
				newFrontMatter.todoistTasks = [
					...(newFrontMatter.todoistTasks || []),
					todoist_id,
				];

				// 更新 front matter
				/*
					this.plugin.fileOperation.updateFrontMatter(view.file, (frontMatter) => {
					frontMatter.todoistTasks = newFrontMatter.todoistTasks;
					frontMatter.todoistCount = newFrontMatter.todoistCount;
					});
					*/
				//console.log(newFrontMatter)
				await this.plugin.cacheOperation.updateFileMetadata(
					filepath,
					newFrontMatter,
				);
			} catch (error) {
				console.error(error);
			}
		} catch (error) {
			console.error("Error adding task:", error);
			console.log(`The error occurred in the file: ${filepath}`);
			return;
		}
	}

	async fullTextNewTaskCheck(file_path: string): Promise<void> {
		let file;
		let currentFileValue;
		let view;
		let filepath;

		if (file_path) {
			file = this.app.vault.getAbstractFileByPath(file_path);
			filepath = file_path;
			currentFileValue = await this.app.vault.read(file);
		} else {
			view = this.app.workspace.getActiveViewOfType(MarkdownView);
			//const editor = this.app.workspace.activeEditor?.editor
			file = this.app.workspace.getActiveFile();
			filepath = file?.path;
			//使用view.data 代替 valut.read。vault.read有延迟
			currentFileValue = view?.data;
		}

		if (this.plugin.settings.enableFullVaultSync) {
			//console.log('full vault sync enabled')
			//console.log(filepath)
			await this.plugin.fileOperation.addTodoistTagToFile(filepath);
		}

		const content = currentFileValue;

		let newFrontMatter;
		//frontMatteer
		const frontMatter =
			await this.plugin.cacheOperation.getFileMetadata(filepath);
		//console.log(frontMatter);

		if (!frontMatter) {
			console.log("frontmatter is empty");
			newFrontMatter = {};
		} else {
			newFrontMatter = { ...frontMatter };
		}

		let hasNewTask = false;
		const lines = content.split("\n");

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (
				!this.plugin.taskParser.hasTodoistId(line) &&
				this.plugin.taskParser.hasTodoistTag(line)
			) {
				//console.log('this is a new task')
				//console.log(`current line is ${i}`)
				//console.log(`line text: ${line}`)
				console.log(filepath);
				const currentTask =
					await this.plugin.taskParser.convertTextToTaskObject(
						line,
						filepath,
						i,
						content,
					);
				if (typeof currentTask === "undefined") {
					continue;
				}
				console.log(currentTask);
				try {
					const newTask =
						await this.plugin.todoistAPI.addTask(currentTask);
					const {
						id: todoist_id,
						projectId: todoist_projectId,
						url: todoist_url,
					} = newTask;
					newTask.path = filepath;
					console.log(newTask);
					new Notice(
						`new task ${newTask.content} id is ${newTask.id}`,
					);
					//newTask写入json文件
					this.plugin.cacheOperation.appendTaskToCache(newTask);

					//如果任务已完成
					if (currentTask.isCompleted === true) {
						await this.plugin.todoistAPI.closeTask(newTask.id);
						this.plugin.cacheOperation.closeTaskToCacheByID(
							todoist_id,
						);
					}
					this.plugin.saveSettings();

					//todoist id 保存到 任务后面
					const text_with_out_link = `${line} %%[todoist_id:: ${todoist_id}]%%`;
					const link = `[link](${newTask.url})`;
					const text = this.plugin.taskParser.addTodoistLink(
						text_with_out_link,
						link,
					);
					lines[i] = text;

					newFrontMatter.todoistCount =
						(newFrontMatter.todoistCount ?? 0) + 1;

					// 记录 taskID
					newFrontMatter.todoistTasks = [
						...(newFrontMatter.todoistTasks || []),
						todoist_id,
					];

					hasNewTask = true;
				} catch (error) {
					console.error("Error adding task:", error);
					continue;
				}
			}
		}
		if (hasNewTask) {
			//文本和 frontMatter
			try {
				// 保存file
				const newContent = lines.join("\n");
				await this.app.vault.modify(file, newContent);

				// 更新 front matter
				/*
                this.plugin.fileOperation.updateFrontMatter(file, (frontMatter) => {
                frontMatter.todoistTasks = newFrontMatter.todoistTasks;
                frontMatter.todoistCount = newFrontMatter.todoistCount;
                });
                */

				await this.plugin.cacheOperation.updateFileMetadata(
					filepath,
					newFrontMatter,
				);
			} catch (error) {
				console.error(error);
			}
		}
	}

	async lineModifiedTaskCheck(
		filepath: string,
		lineText: string,
		lineNumber: number,
		fileContent: string,
	): Promise<void> {
		console.log("Line modified, checking if it's a task line...");
		//const lineText = await this.plugin.fileOperation.getLineTextFromFilePath(filepath,lineNumber)

		if (this.plugin.settings.enableFullVaultSync) {
			//await this.plugin.fileOperation.addTodoistTagToLine(filepath,lineText,lineNumber,fileContent)

			//new empty metadata
			const metadata =
				await this.plugin.cacheOperation.getFileMetadata(filepath);
			if (!metadata) {
				await this.plugin.cacheOperation.newEmptyFileMetadata(filepath);
			}
			this.plugin.saveSettings();
		}

		//检查task
		if (
			this.plugin.taskParser.hasTodoistId(lineText) &&
			this.plugin.taskParser.hasTodoistTag(lineText)
		) {
			const lineTask =
				await this.plugin.taskParser.convertTextToTaskObject(
					lineText,
					filepath,
					lineNumber,
					fileContent,
				);
			//console.log(lastLineTask)
			const lineTask_todoist_id = lineTask.todoistId.toString();
			//console.log(lineTask_todoist_id )
			//console.log(`lastline task id is ${lastLineTask_todoist_id}`)
			const savedTask =
				await this.plugin.cacheOperation.loadTaskFromCacheID(
					lineTask_todoist_id,
				); //dataview中 id为数字，todoist中id为字符串，需要转换
			if (!savedTask) {
				console.log(`本地缓存中没有task ${lineTask.todoistId}`);
				const url =
					this.plugin.taskParser.getObsidianUrlFromFilepath(filepath);
				console.log(url);
				return;
			}
			//console.log(savedTask)

			//检查内容是否修改
			const lineTaskContent = lineTask.content;

			//content 是否修改
			const contentModified = !this.plugin.taskParser.taskContentCompare(
				lineTask,
				savedTask,
			);
			//tag or labels 是否修改
			const tagsModified = !this.plugin.taskParser.taskTagCompare(
				lineTask,
				savedTask,
			);
			//project 是否修改
			const projectModified =
				!(await this.plugin.taskParser.taskProjectCompare(
					lineTask,
					savedTask,
				));
			//status 是否修改
			const statusModified = !this.plugin.taskParser.taskStatusCompare(
				lineTask,
				savedTask,
			);
			//due date 是否修改
			const dueDateModified =
				!(await this.plugin.taskParser.compareTaskDueDate(
					lineTask,
					savedTask,
				));
			//parent id 是否修改
			const parentIdModified = !(
				lineTask.parentId === savedTask.parentId
			);
			//check priority
			const priorityModified = !(
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
				if (contentModified) {
					console.log(
						`Content modified for task ${lineTask_todoist_id}`,
					);
					updatedContent.content = lineTaskContent;
					contentChanged = true;
				}

				if (tagsModified) {
					console.log(
						`Tags modified for task ${lineTask_todoist_id}`,
					);
					updatedContent.labels = lineTask.labels;
					tagsChanged = true;
				}

				if (dueDateModified) {
					console.log(
						`Due date modified for task ${lineTask_todoist_id}`,
					);
					console.log(lineTask.dueDate);
					//console.log(savedTask.due.date)
					if (lineTask.dueDate === "") {
						updatedContent.dueString = "no date";
					} else {
						updatedContent.dueDate = lineTask.dueDate;
					}

					dueDateChanged = true;
				}

				//todoist Rest api 没有 move task to new project的功能
				if (projectModified) {
					//console.log(`Project id modified for task ${lineTask_todoist_id}`)
					//updatedContent.projectId = lineTask.projectId
					//projectChanged = false;
				}

				//todoist Rest api 没有修改 parent id 的借口
				if (parentIdModified) {
					//console.log(`Parnet id modified for task ${lineTask_todoist_id}`)
					//updatedContent.parentId = lineTask.parentId
					//parentIdChanged = false;
				}

				if (priorityModified) {
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
					const updatedTask =
						await this.plugin.todoistAPI.updateTask(
							lineTask.todoistId.toString(),
							updatedContent,
						);
					updatedTask.path = filepath;
					this.plugin.cacheOperation.updateTaskToCacheByID(
						updatedTask,
					);
				}

				if (statusModified) {
					console.log(
						`Status modified for task ${lineTask_todoist_id}`,
					);
					if (lineTask.isCompleted === true) {
						console.log(`task completed`);
						this.plugin.todoistAPI.closeTask(
							lineTask.todoistId.toString(),
						);
						this.plugin.cacheOperation.closeTaskToCacheByID(
							lineTask.todoistId.toString(),
						);
					} else {
						console.log(`task umcompleted`);
						this.plugin.todoistAPI.openTask(
							lineTask.todoistId.toString(),
						);
						this.plugin.cacheOperation.reopenTaskToCacheByID(
							lineTask.todoistId.toString(),
						);
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
					console.log(lineTask);
					console.log(savedTask);
					//`Task ${lastLineTaskTodoistId} was modified`
					this.plugin.saveSettings();
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
		let file;
		let currentFileValue;
		let view;
		let filepath;

		console.log("ENTER fullTextModifiedTaskCheck")

		try {
			if (file_path) {
				file = this.app.vault.getAbstractFileByPath(file_path);
				filepath = file_path;
				currentFileValue = await this.app.vault.read(file);
			} else {
				view = this.app.workspace.getActiveViewOfType(MarkdownView);
				file = this.app.workspace.getActiveFile();
				filepath = file?.path;
				currentFileValue = view?.data;
			}

			const content = currentFileValue;

			let hasModifiedTask = false;
			const lines = content.split("\n");

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				if (
					this.plugin.taskParser.hasTodoistId(line) &&
					this.plugin.taskParser.hasTodoistTag(line)
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
						continue;
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
			await this.plugin.todoistAPI.closeTask(taskId);
			await this.plugin.fileOperation.completeTaskInFile(taskId);
			this.plugin.cacheOperation.closeTaskToCacheByID(taskId);
			this.plugin.saveSettings();
			new Notice(`Task "${taskId}" closed.`);
		} catch (error) {
			console.error("Error closing task:", error);
			throw error;
		}
	}

	//open task
	async reopenTask(taskId: string): Promise<void> {
		try {
			await this.plugin.todoistAPI.openTask(taskId);
			await this.plugin.fileOperation.uncompleteTaskInFile(taskId);
			this.plugin.cacheOperation.reopenTaskToCacheByID(taskId);
			this.plugin.saveSettings();
			new Notice(`Task "${taskId}" reopened.`);
		} catch (error) {
			console.error("Error while reopening task:", error);
			throw error;
		}
	}

	/**
	 * 从任务列表中删除指定 ID 的任务并更新 JSON 文件
	 * @param taskIds 要删除的任务 ID 数组
	 * @returns 返回被成功删除的任务 ID 数组
	 */
	async deleteTasksByIds(taskIds: string[]): Promise<string[]> {
		const deletedTaskIds = [];

		for (const taskId of taskIds) {
			const api = await this.plugin.todoistRestAPI.initializeAPI();
			try {
				const response = await api.deleteTask(taskId);
				console.log(`response is ${response}`);

				if (response) {
					//console.log(`Task ${taskId} 删除成功`);
					new Notice(`Task ${taskId} is deleted.`);
					deletedTaskIds.push(taskId); // 将被删除的任务 ID 加入数组
				}
			} catch (error) {
				console.error(`Failed to delete task ${taskId}: ${error}`);
				// 可以添加更好的错误处理方式，比如在这里抛出异常或者记录日志等
			}
		}

		if (!deletedTaskIds.length) {
			console.log("没有删除任务");
			return [];
		}

		await this.plugin.cacheOperation.deleteTaskFromCacheByIDs(
			deletedTaskIds,
		); // 更新 JSON 文件
		this.plugin.saveSettings();
		//console.log(`共删除了 ${deletedTaskIds.length} 条 task`);

		return deletedTaskIds;
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
				await this.plugin.fileOperation.completeTaskInFile(evt.objectId);
				this.plugin.cacheOperation.closeTaskToCacheByID(evt.objectId);
				new Notice(`Task ${evt.objectId} is closed.`);
				processedEvents.push(evt);
			}

			// Save processed events to cache
			this.plugin.cacheOperation.appendEventsToCache(processedEvents);
			await this.plugin.saveSettings();
		} catch (error) {
			throw new Error("Error while processing unsyncedCompletedItems：" + error);
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
				await this.plugin.fileOperation.uncompleteTaskInFile(evt.objectId);
				this.plugin.cacheOperation.reopenTaskToCacheByID(evt.objectId);
				new Notice(`Task ${evt.objectId} is reopened.`);
				processedEvents.push(evt);
			}

			this.plugin.cacheOperation.appendEventsToCache(processedEvents);
			await this.plugin.saveSettings();
		} catch (error) {
			throw new Error("Error while processing unsyncedUncompletedItems：" + error);
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

			this.plugin.cacheOperation.appendEventsToCache(processedEvents);
			await this.plugin.saveSettings();
		} catch (error) {
			throw new Error("Error while processing unsyncedUpdatedItems：" + error);
		}
	}

	async syncUpdatedTaskContentToObsidian(e: ActivityEvent) {
		await this.plugin.fileOperation.syncUpdatedTaskContentToTheFile(e);
		const content: string = e.extraData?.content ?? "";
		this.plugin.cacheOperation.modifyTaskToCacheByID(e.objectId, {
			content,
		});
		new Notice(
			`The content of Task ${e.parent_item_id} has been modified.`,
		);
	}

	async syncUpdatedTaskDueDateToObsidian(e: ActivityEvent) {
		await this.plugin.fileOperation.syncUpdatedTaskDueDateToFile(e);
		
		const task: Task = await this.plugin.todoistAPI.getTaskById(e.objectId);
		const due = task.due ?? null;

		this.plugin.cacheOperation.modifyTaskToCacheByID(e.objectId, { due });
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
				await this.plugin.fileOperation.syncAddedTaskNoteToTheFile(e);
				new Notice(`Task ${e.parentItemId} note is added.`);
				processedEvents.push(e);
			}
			this.plugin.cacheOperation.appendEventsToCache(processedEvents);
			await this.plugin.saveSettings();
		} catch (error) {
			console.error("Error while syncing tasks notes to obsidian：", error);
		}
	}

    async syncTodoistToObsidian() {
        try {
            const unsyncedEvents = await this.getUnsyncedEvents();
			console.log(`Events to synchronize: ${unsyncedEvents.length}`);

            const syncedTasks = await this.plugin.cacheOperation.loadTasksFromCache();

            const eventsForTrackedTasks = this.filterEventsForTrackedTasks(unsyncedEvents, syncedTasks);
            const eventsByType = this.categorizeEventsByType(eventsForTrackedTasks, unsyncedEvents, syncedTasks);

            this.logEventCategories(eventsByType);
            await this.syncEventCategoriesToObsidian(eventsByType);
            await this.handleProjectEvents(eventsByType.projectEvents);
            await this.finalizeSync();
        } catch (err) {
            console.error("An error occurred while synchronizing:", err);
        }
    }

    private async getUnsyncedEvents(): Promise<ActivityEvent[]> {
        const allEvents = await this.plugin.todoistAPI.getNonObsidianActivities();
        const syncedEvents = await this.plugin.cacheOperation.loadEventsFromCache();

		return allEvents.filter((event: ActivityEvent): boolean =>
			!syncedEvents.some((syncedEvent) => syncedEvent.id === event.id)
		);
    }

    private filterEventsForTrackedTasks(unsyncedEvents: ActivityEvent[], syncedTasks: any[]): ActivityEvent[] {
		return unsyncedEvents.filter((event: ActivityEvent): boolean =>
			syncedTasks.some((task) => task.id === event.objectId)
		);
    }

    private categorizeEventsByType(eventsForTrackedTasks: ActivityEvent[], unsyncedEvents: ActivityEvent[], syncedTasks: any[]) {
        const eventsForUntrackedNotes = unsyncedEvents.filter((event: ActivityEvent): boolean =>
            !syncedTasks.some((task) => task.id === event.parentItemId)
        );

        return {
            completedItems: filterActivityEvents(eventsForTrackedTasks, {eventType: "completed", objectType: "task"}),
            uncompletedItems: filterActivityEvents(eventsForTrackedTasks, {
                eventType: "uncompleted",
                objectType: "task"
            }),
            updatedItems: filterActivityEvents(eventsForTrackedTasks, {eventType: "updated", objectType: "task"}),
            addedNotes: filterActivityEvents(eventsForUntrackedNotes, {eventType: "added", objectType: "note"}),
            projectEvents: filterActivityEvents(unsyncedEvents, {objectType: "project"})
        };
    }

    private logEventCategories(eventsByType: ReturnType<typeof this.categorizeEventsByType>) {
        if (eventsByType.projectEvents.length > 0) console.log("unsyncedProjectEvents", eventsByType.projectEvents);
        if (eventsByType.completedItems.length > 0) console.log("unsyncedItemCompletedEvents", eventsByType.completedItems);
		if (eventsByType.uncompletedItems.length > 0) console.log("unsyncedItemUncompletedEvents", eventsByType.uncompletedItems);
		if (eventsByType.updatedItems.length > 0) console.log("unsyncedItemUpdatedEvents", eventsByType.updatedItems);
		if (eventsByType.addedNotes.length > 0) console.log("unsyncedNotesAddedEvents", eventsByType.addedNotes);
    }

    private async syncEventCategoriesToObsidian(eventsByType: ReturnType<typeof this.categorizeEventsByType>) {
        await this.syncCompletedItemsToObsidian(eventsByType.completedItems);
        await this.syncUncompletedItemsToObsidian(eventsByType.uncompletedItems);
        await this.syncUpdatedItemsToObsidian(eventsByType.updatedItems);
        await this.syncAddedTaskNoteToObsidian(eventsByType.addedNotes);
    }

    private async handleProjectEvents(projectEvents: ActivityEvent[]) {
        if (projectEvents.length > 0) {
            console.log("New project event");
            await this.plugin.cacheOperation.saveProjectsToCache();
            this.plugin.cacheOperation.appendEventsToCache(projectEvents);
        }
    }

    private async finalizeSync() {
        this.plugin.cacheOperation.updateLastSyncTime(new Date());
        await this.plugin.saveSettings();
    }

    async backupTodoistAllResources() {
        try {
            const resources = await this.plugin.todoistAPI.getAllResources();
            const filename = this.generateBackupFilename();

            await this.app.vault.create(filename, JSON.stringify(resources, null, 2));

            new Notice(`Todoist backup saved: ${filename}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error("Failed to create Todoist backup:", message);
            new Notice(`Backup failed: ${message}`);
        }
    }

    private generateBackupFilename(): string {
        const now = new Date();
        const timestamp = now
            .toISOString()
            .replace(/[-:]/g, '')
            .replace(/\.\d{3}Z$/, '')
            .replace('T', '-');

        return `todoist-backup-${timestamp}.json`;
    }

	//After renaming the file, check all tasks in the file and update all links.
	async updateTaskDescription(filepath: string) {
		const metadata =
			await this.plugin.cacheOperation.getFileMetadata(filepath);
		if (!metadata || !metadata.todoistTasks) {
			return;
		}
		const description =
			this.plugin.taskParser.getObsidianUrlFromFilepath(filepath);
		let updatedContent = {};
		updatedContent.description = description;
		try {
			metadata.todoistTasks.forEach(async (taskId: string) => {
				const updatedTask = await this.plugin.todoistAPI.updateTask(
					taskId,
					updatedContent,
				);
				updatedTask.path = filepath;
				this.plugin.cacheOperation.updateTaskToCacheByID(updatedTask);
			});
		} catch (error) {
			console.error("An error occurred in updateTaskDescription:", error);
		}
	}
}
