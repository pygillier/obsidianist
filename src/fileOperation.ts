import { App, Notice, TFile } from "obsidian";
import Obsidianist from "../main";
import { ActivityEvent } from "@doist/todoist-api-typescript";

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
		try {
			const currentTask = this.plugin.cacheOperation.loadTaskByID(taskId);

			if (currentTask.path) {
				const content = await this.readContentFromFilePath(
					currentTask.path,
				);

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
						await this.writeContentToFile(
							currentTask.path,
							newContent,
						);
					}
				}
			} else {
				console.warn(
					`LocalTask ${taskId} does not have path defined. Can't update the file`,
				);
				new Notice(
					`Unable to mark task ${taskId} as completed, please check logs.`,
				);
			}
		} catch (error) {
			console.error(
				`Error while completing task ${taskId} in file: ${error}`,
			);
			new Notice(
				`Unable to mark task ${taskId} as completed, please check logs.`,
			);
		}
	}

	async uncompleteTaskInFile(taskId: string) {
		try {
			const currentTask = this.plugin.cacheOperation.loadTaskByID(taskId);

			if (currentTask.path) {
				const content = await this.readContentFromFilePath(
					currentTask.path,
				);

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
							lines[i] = line.replace(/- \[([xX])\]/g, "- [ ]");
							modified = true;
							break;
						}
					}

					if (modified) {
						const newContent = lines.join("\n");
						await this.writeContentToFile(
							currentTask.path,
							newContent,
						);
					}
				}
			} else {
				console.warn(
					`LocalTask ${taskId} does not have path defined. Can't update the file`,
				);
				new Notice(
					`Unable to mark task ${taskId} as not completed, please check logs.`,
				);
			}
		} catch (error) {
			console.error(
				`Error while completing task ${taskId} in file: ${error}`,
			);
			new Notice(
				`Unable to mark task ${taskId} as not completed, please check logs.`,
			);
		}
	}

	//add #todoist at the end of task line, if full vault sync enabled
	async addTodoistTagToFile(filepath: string) {
		const content = await this.readContentFromFilePath(filepath);
		if (typeof content !== "string") return;

		const lines = content.split("\n");
		let modified = false;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!this.plugin.taskParser.isMarkdownTask(line)) continue;
			if (this.plugin.taskParser.getTaskContentFromLineText(line) === "")
				continue;
			if (
				!this.plugin.taskParser.hasTodoistId(line) &&
				!this.plugin.taskParser.hasTodoistTag(line)
			) {
				lines[i] = this.plugin.taskParser.addTodoistTag(line);
				modified = true;
			}
		}

		if (modified) {
			console.debug(`New task found in files ${filepath}`);
			await this.writeContentToFile(filepath, lines.join("\n"));

			const metadata =
				await this.plugin.cacheOperation.getFileMetadata(filepath);
			if (!metadata) {
				await this.plugin.cacheOperation.newEmptyFileMetadata(filepath);
			}
		}
	}

	async addTodoistLinkToFile(filepath: string) {
		const content = await this.readContentFromFilePath(filepath);
		if (typeof content !== "string") return;

		const lines = content.split("\n");
		let modified = false;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (
				!this.plugin.taskParser.hasTodoistId(line) ||
				!this.plugin.taskParser.hasTodoistTag(line)
			)
				continue;
			if (this.plugin.taskParser.hasTodoistLink(line)) continue;

			const taskID =
				this.plugin.taskParser.extractTodoistIdFromText(line);
			if (!taskID) continue;
			const taskObject = this.plugin.cacheOperation.loadTaskByID(taskID);
			const link = `[link](${taskObject.url})`;
			lines[i] = this.plugin.taskParser.addTodoistLink(line, link);
			modified = true;
		}

		if (modified) {
			await this.writeContentToFile(filepath, lines.join("\n"));
		}
	}

	// sync updated task content  to file
	async syncUpdatedTaskContentToTheFile(evt: ActivityEvent) {
		const currentTask = this.plugin.cacheOperation.loadTaskByID(
			evt.objectId,
		);
		const filepath = currentTask.path;
		if (!filepath) return;

		const content = await this.readContentFromFilePath(filepath);
		if (typeof content !== "string") return;

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
			await this.writeContentToFile(filepath, lines.join("\n"));
		}
	}

	/**
	 * Sync updated due date to related file
	 * @param evt
	 */
	async syncUpdatedTaskDueDateToFile(evt: ActivityEvent) {
		const currentTask = this.plugin.cacheOperation.loadTaskByID(
			evt.objectId,
		);
		const filepath = currentTask.path;
		if (!filepath) return;

		const content = await this.readContentFromFilePath(filepath);
		if (typeof content !== "string") return;

		const lines = content.split("\n");
		let modified = false;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (
				!line.includes(evt.objectId) ||
				!this.plugin.taskParser.hasTodoistTag(line)
			)
				continue;

			const oldTaskDueDate =
				this.plugin.taskParser.getDueDateFromLineText(line) || "";
			const newTaskDueDate =
				this.plugin.taskParser.ISOStringToLocalDateString(
					evt.extraData?.dueDate,
				) || "";

			if (oldTaskDueDate === "") {
				lines[i] = this.plugin.taskParser.insertDueDateBeforeTodoist(
					line,
					newTaskDueDate,
				);
			} else if (newTaskDueDate === "") {
				const regexRemoveDate = /(🗓️|📅|📆|🗓)\s?\d{4}-\d{2}-\d{2}/;
				lines[i] = line.replace(regexRemoveDate, "");
			} else {
				lines[i] = line.replace(oldTaskDueDate, newTaskDueDate);
			}
			modified = true;
			break;
		}

		if (modified) {
			await this.writeContentToFile(filepath, lines.join("\n"));
		}
	}

	// sync new task note to file
	async syncAddedTaskNoteToTheFile(evt: ActivityEvent) {
		const taskId = evt.parentItemId;
		if (!taskId) return;

		const note = evt.extraData?.content ?? "";
		const datetime = this.plugin.taskParser.ISOStringToLocalDatetimeString(
			evt.eventDate,
		);

		const currentTask = this.plugin.cacheOperation.loadTaskByID(taskId);
		const filepath = currentTask.path;
		if (!filepath) return;

		const content = await this.readContentFromFilePath(filepath);
		if (typeof content !== "string") return;

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
				lines.splice(i + 1, 0, `${indent}- ${datetime} ${note}`);
				modified = true;
				break;
			}
		}

		if (modified) {
			await this.writeContentToFile(filepath, lines.join("\n"));
		}
	}

	async readContentFromFilePath(filepath: string): Promise<string | null> {
		try {
			const file = this.app.vault.getAbstractFileByPath(filepath);
			if (file !== null) {
				return await this.app.vault.read(file as TFile);
			}
			return "";
		} catch (error) {
			console.error(`Error loading content from ${filepath}: ${error}`);
			return null;
		}
	}

	async writeContentToFile(
		filepath: string,
		newContent: string,
	): Promise<void> {
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

	//get all files in the vault
	getAllFilesInTheVault(): Promise<TFile[]> {
		return this.app.vault.getFiles();
	}

	//search filepath by taskid in vault
	async searchFilepathsByTaskidInVault(taskId: string) {
		console.debug(`preprare to search task ${taskId}`);
		const files = await this.getAllFilesInTheVault();
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
		return filename.split(".").pop()?.toLowerCase() === "md";
	}
}
