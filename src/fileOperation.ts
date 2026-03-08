import {App, TFile} from "obsidian";
import Obsidianist from "../main";
import {ActivityEvent, Task} from "@doist/todoist-api-typescript";


export class FileOperation {
	app: App;
	plugin: Obsidianist;

	constructor(app: App, plugin: Obsidianist) {
		this.app = app;
		this.plugin = plugin;
	}

	/**
	 * Mark a task as completed (checkbox checked) in related file.
	 *
	 * @param taskId
	 */
	async completeTaskInFile(taskId: string) {

		const currentTask: Task = this.plugin.cacheOperation.loadTaskByID(taskId);

		const content = await this.readContentFromFilePath(currentTask.path)

		// File exists with content
		if (typeof content === "string") {
			const lines = content.split("\n");
			let modified = false;

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				if (
					line.includes(taskId) &&
					this.plugin.taskParser.hasTodoistTag(line)
				) {
					lines[i] = line.replace("[ ]", "[x]");
					modified = true;
					break;
				}
			}

			if (modified) {
				const newContent = lines.join("\n");
				await this.writeContentToFile(currentTask.path, newContent)
			}
		}
	}

	async uncompleteTaskInFile(taskId: string) {
		// 获取任务文件路径
		const currentTask =
			await this.plugin.cacheOperation.loadTaskByID(taskId);
		const filepath = currentTask.path;

		const content = await this.readContentFromFilePath(filepath);

		// File exists with content
		if (typeof content === "string") {
			const lines = content.split("\n");
			let modified = false;

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				if (
					line.includes(taskId) &&
					this.plugin.taskParser.hasTodoistTag(line)
				) {
					lines[i] = line.replace(/- \[(x|X)\]/g, "- [ ]");
					modified = true;
					break;
				}
			}

			if (modified) {
				const newContent = lines.join("\n");
				await this.writeContentToFile(currentTask.path, newContent);
			}
		}
	}

	//add #todoist at the end of task line, if full vault sync enabled
	async addTodoistTagToFile(filepath: string) {
		// 获取文件对象并更新内容
		const file = this.app.vault.getAbstractFileByPath(filepath);
		const content = await this.app.vault.read(file);

		const lines = content.split("\n");
		let modified = false;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!this.plugin.taskParser.isMarkdownTask(line)) {
				//console.log(line)
				//console.log("It is not a markdown task.")
				continue;
			}
			//if content is empty
			if (this.plugin.taskParser.getTaskContentFromLineText(line) == "") {
				//console.log("Line content is empty")
				continue;
			}
			if (
				!this.plugin.taskParser.hasTodoistId(line) &&
				!this.plugin.taskParser.hasTodoistTag(line)
			) {
				//console.log(line)
				//console.log('prepare to add todoist tag')
				const newLine = this.plugin.taskParser.addTodoistTag(line);
				//console.log(newLine)
				lines[i] = newLine;
				modified = true;
			}
		}

		if (modified) {
			console.log(`New task found in files ${filepath}`);
			const newContent = lines.join("\n");
			//console.log(newContent)
			await this.app.vault.modify(file, newContent);

			//update filemetadate
			const metadata =
				await this.plugin.cacheOperation.getFileMetadata(filepath);
			if (!metadata) {
				await this.plugin.cacheOperation.newEmptyFileMetadata(filepath);
			}
		}
	}

	//add todoist at the line
	async addTodoistLinkToFile(filepath: string) {
		// 获取文件对象并更新内容
		const file = this.app.vault.getAbstractFileByPath(filepath);
		const content = await this.app.vault.read(file);

		const lines = content.split("\n");
		let modified = false;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (
				this.plugin.taskParser.hasTodoistId(line) &&
				this.plugin.taskParser.hasTodoistTag(line)
			) {
				if (this.plugin.taskParser.hasTodoistLink(line)) {
					return;
				}
				console.log(line);
				//console.log('prepare to add todoist link')
				const taskID =
					this.plugin.taskParser.extractTodoistIdFromText(line);
				const taskObject =
					this.plugin.cacheOperation.loadTaskByID(taskID);
				const todoistLink = taskObject.url;
				const link = `[link](${todoistLink})`;
				const newLine = this.plugin.taskParser.addTodoistLink(
					line,
					link,
				);
				console.log(newLine);
				lines[i] = newLine;
				modified = true;
			} else {
				continue;
			}
		}

		if (modified) {
			const newContent = lines.join("\n");
			//console.log(newContent)
			await this.app.vault.modify(file, newContent);
		}
	}

	//add #todoist at the end of task line, if full vault sync enabled
	async addTodoistTagToLine(
		filepath: string,
		lineText: string,
		lineNumber: number,
		fileContent: string,
	) {
		// 获取文件对象并更新内容
		const file = this.app.vault.getAbstractFileByPath(filepath);
		const content = fileContent;

		const lines = content.split("\n");
		let modified = false;

		const line = lineText;
		if (!this.plugin.taskParser.isMarkdownTask(line)) {
			//console.log(line)
			//console.log("It is not a markdown task.")
			return;
		}
		//if content is empty
		if (this.plugin.taskParser.getTaskContentFromLineText(line) == "") {
			//console.log("Line content is empty")
			return;
		}
		if (
			!this.plugin.taskParser.hasTodoistId(line) &&
			!this.plugin.taskParser.hasTodoistTag(line)
		) {
			//console.log(line)
			//console.log('prepare to add todoist tag')
			const newLine = this.plugin.taskParser.addTodoistTag(line);
			//console.log(newLine)
			lines[lineNumber] = newLine;
			modified = true;
		}

		if (modified) {
			console.log(`New task found in files ${filepath}`);
			const newContent = lines.join("\n");
			console.log(newContent);
			await this.app.vault.modify(file, newContent);

			//update filemetadate
			const metadata =
				await this.plugin.cacheOperation.getFileMetadata(filepath);
			if (!metadata) {
				await this.plugin.cacheOperation.newEmptyFileMetadata(filepath);
			}
		}
	}

	// sync updated task content  to file
	async syncUpdatedTaskContentToTheFile(evt: ActivityEvent) {

		const currentTask = await this.plugin.cacheOperation.loadTaskByID(evt.objectId);
		const filepath = currentTask.path;

		const content = await this.readContentFromFilePath(filepath);

		if (typeof content === "string") {
			const lines = content.split("\n");
			let modified = false;

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				if (
					line.includes(evt.objectId) &&
					this.plugin.taskParser.hasTodoistTag(line)
				) {
					const oldTaskContent =
						this.plugin.taskParser.getTaskContentFromLineText(line);
					const newTaskContent = evt.extraData?.content ?? "";

					lines[i] = line.replace(oldTaskContent, newTaskContent);
					modified = true;
					break;
				}
			}
			if (modified) {
				const newContent = lines.join("\n");
				await this.writeContentToFile(filepath, newContent);
			}
		}
	}

	/**
	 * Sync updated due date to related file
	 * @param evt
	 */
	async syncUpdatedTaskDueDateToFile(evt: ActivityEvent) {

		const currentTask = await this.plugin.cacheOperation.loadTaskByID(evt.objectId);
		const filepath: string = currentTask.path;

		const content = await this.readContentFromFilePath(filepath);

		// File exists with content
		if (typeof content === "string") {
			const lines = content.split("\n");
			let modified = false;

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				if (
					line.includes(evt.objectId) &&
					this.plugin.taskParser.hasTodoistTag(line)
				) {
					const oldTaskDueDate =
						this.plugin.taskParser.getDueDateFromLineText(line) || "";
					const newTaskDueDate =
						this.plugin.taskParser.ISOStringToLocalDateString(
							evt.extraData?.dueDate,
						) || "";

					//console.log(`${evt.objectId} duedate is updated`)
					console.log(oldTaskDueDate);
					console.log(newTaskDueDate);
					if (oldTaskDueDate === "") {
						//console.log(this.plugin.taskParser.insertDueDateBeforeTodoist(line,newTaskDueDate))
						lines[i] =
							this.plugin.taskParser.insertDueDateBeforeTodoist(
								line,
								newTaskDueDate,
							);
						modified = true;
					} else if (newTaskDueDate === "") {
						//remove 日期from text
						const regexRemoveDate = /(🗓️|📅|📆|🗓)\s?\d{4}-\d{2}-\d{2}/; //匹配日期🗓️2023-03-07"
						lines[i] = line.replace(regexRemoveDate, "");
						modified = true;
					} else {
						lines[i] = line.replace(oldTaskDueDate, newTaskDueDate);
						modified = true;
					}
					break;
				}
			}

			if (modified) {
				const newContent = lines.join("\n");
				await this.writeContentToFile(filepath, newContent);
			}
		}

	}

	// sync new task note to file
	async syncAddedTaskNoteToTheFile(evt: ActivityEvent) {
		const taskId = evt.parentItemId ?? "";
		const note: string = evt.extraData?.content;
		const datetime = this.plugin.taskParser.ISOStringToLocalDatetimeString(
			evt.eventDate,
		);

		const currentTask = await this.plugin.cacheOperation.loadTaskByID(taskId);
		const filepath = currentTask.path;

		const content = await this.readContentFromFilePath(filepath);

		// File exists with content
		if (typeof content === "string") {
			const lines = content.split("\n");
			let modified = false;

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				if (
					line.includes(taskId) &&
					this.plugin.taskParser.hasTodoistTag(line)
				) {
					const indent = "\t".repeat(
						line.length - line.trimStart().length + 1,
					);
					const noteLine = `${indent}- ${datetime} ${note}`;
					lines.splice(i + 1, 0, noteLine);
					modified = true;
					break;
				}
			}

			if (modified) {
				const newContent = lines.join("\n");
				await this.writeContentToFile(filepath, newContent);
			}
		}
	}

	async readContentFromFilePath(filepath: string): Promise<string|boolean> {
		try {
			const file = this.app.vault.getAbstractFileByPath(filepath);
			if (file !== null) {
				return await this.app.vault.read(file as TFile);
			}
			return "";
		} catch (error) {
			console.error(`Error loading content from ${filepath}: ${error}`);
			return false;
		}
	}

	async writeContentToFile(filepath: string, newContent: string): Promise<void> {
		try {
			this.plugin.debugLog(`Writing content to ${filepath}`);
			const file = this.app.vault.getAbstractFileByPath(filepath);
			if (file !== null) {
				await this.app.vault.modify(file as TFile, newContent);
			}
		} catch (error) {
			throw new Error(`Error writing content to ${filepath}: ${error}`);
		}
	}

	//get line text from file path
	//请使用 view.editor.getLine，read 方法有延迟
	async getLineTextFromFilePath(filepath: string, lineNumber: string) {
		const file = this.app.vault.getAbstractFileByPath(filepath);
		const content = await this.app.vault.read(file);

		const lines = content.split("\n");
		return lines[lineNumber];
	}

	//search todoist_id by content
	async searchTodoistIdFromFilePath(
		filepath: string,
		searchTerm: string,
	): string | null {
		const file = this.app.vault.getAbstractFileByPath(filepath);
		const fileContent = await this.app.vault.read(file);
		const fileLines = fileContent.split("\n");
		let todoistId: string | null = null;

		for (let i = 0; i < fileLines.length; i++) {
			const line = fileLines[i];

			if (line.includes(searchTerm)) {
				const regexResult = /\[todoist_id::\s*(\w+)\]/.exec(line);

				if (regexResult) {
					todoistId = regexResult[1];
				}

				break;
			}
		}

		return todoistId;
	}

	//get all files in the vault
	async getAllFilesInTheVault() {
		const files = this.app.vault.getFiles();
		return files;
	}

	//search filepath by taskid in vault
	async searchFilepathsByTaskidInVault(taskId: string) {
		console.log(`preprare to search task ${taskId}`);
		const files = await this.getAllFilesInTheVault();
		//console.log(files)
		const tasks = files.map(async (file) => {
			if (!this.isMarkdownFile(file.path)) {
				return;
			}
			const fileContent = await this.app.vault.cachedRead(file);
			if (fileContent.includes(taskId)) {
				return file.path;
			}
		});

		const results = await Promise.all(tasks);
		const filePaths = results.filter((filePath) => filePath !== undefined);
		return filePaths[0] || null;
		//return filePaths || null
	}

	isMarkdownFile(filename: string) {
		// 获取文件名的扩展名
		let extension = filename.split(".").pop();

		// 将扩展名转换为小写（Markdown文件的扩展名通常是.md）
		extension = extension.toLowerCase();

		// 判断扩展名是否为.md
		if (extension === "md") {
			return true;
		} else {
			return false;
		}
	}
}
