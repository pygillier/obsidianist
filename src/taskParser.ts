import { App } from "obsidian";
import Todoistian from "../main";
import TaskObject, { ConversionArguments, LocalTask } from "./interfaces";

const keywords = {
	TODOIST_TAG: "#todoist",
	DUE_DATE: "🗓️|📅|📆|🗓",
};

const REGEX = {
	TODOIST_TAG: new RegExp(
		`^[\\s]*[-] \\[[x ]\\] [\\s\\S]*${keywords.TODOIST_TAG}[\\s\\S]*$`,
		"i",
	),
	TODOIST_ID: /\[todoist_id::\s*\w+\]/,
	TODOIST_ID_NUM: /\[todoist_id::\s*(.*?)\]/,
	TODOIST_LINK: /\[link\]\(.*?\)/,
	DUE_DATE_WITH_EMOJ: new RegExp(
		`(${keywords.DUE_DATE})\\s?\\d{4}-\\d{2}-\\d{2}`,
	),
	DUE_DATE: new RegExp(`(?:${keywords.DUE_DATE})\\s?(\\d{4}-\\d{2}-\\d{2})`),
	PROJECT_NAME: /\[project::\s*(.*?)\]/,
	TASK_CONTENT: {
		REMOVE_PRIORITY: /\s!!([1-4])\s/,
		REMOVE_TAGS: /(^|\s)(#[a-zA-Z\d\u4e00-\u9fa5-]+)/g,
		REMOVE_SPACE: /^\s+|\s+$/g,
		REMOVE_DATE: new RegExp(
			`(${keywords.DUE_DATE})\\s?\\d{4}-\\d{2}-\\d{2}`,
		),
		REMOVE_INLINE_METADATA: /%%\[\w+::\s*\w+\]%%/,
		REMOVE_CHECKBOX: /^(-|\*)\s+\[(x|X| )\]\s/,
		REMOVE_CHECKBOX_WITH_INDENTATION: /^([ \t]*)?(-|\*)\s+\[(x|X| )\]\s/,
		REMOVE_TODOIST_LINK: /\[link\]\(.*?\)/,
	},
	ALL_TAGS: /#[\w\u4e00-\u9fa5-]+/g,
	TASK_CHECKBOX_CHECKED: /- \[(x|X)\] /,
	TASK_INDENTATION: /^(\s{2,}|\t)(-|\*)\s+\[(x|X| )\]/,
	TAB_INDENTATION: /^(\t+)/,
	TASK_PRIORITY: /\s!!([1-4])\s/,
	BLANK_LINE: /^\s*$/,
	TODOIST_EVENT_DATE: /(\d{4})-(\d{2})-(\d{2})/,
};

export class TaskParser {
	app: App;
	plugin: Todoistian;

	constructor(app: App, plugin: Todoistian) {
		//super(app,settings);
		this.app = app;
		this.plugin = plugin;
	}

	convertLineToTask(args: ConversionArguments): TaskObject {
		/**
		 * Convert a line from the note to a TaskObject.
		 */

		console.debug(`Line to parse: ${args.lineContent}`);

		// Clean out text
		const cleanedText = this.removeTaskIndentation(args.lineContent);

		const task = {
			hasParent: false,
			content: this.getTaskContentFromLineText(cleanedText),
			dueDate: this.getDueDateFromLineText(cleanedText),
			labels: this.getAllTagsFromLineText(cleanedText),
			priority: this.getTaskPriority(cleanedText),
			isCompleted: this.isTaskCheckboxChecked(cleanedText),
			todoistId: this.extractTodoistIdFromText(cleanedText),
		} as TaskObject;

		// Config
		const project = this.plugin.cacheOperation.getProjectForFile(
			args.filePath,
		);
		task.projectId = project.projectId;

		if (args.filePath != "") {
			const url = encodeURI(
				`obsidian://open?vault=${this.app.vault.getName()}&file=${
					args.filePath
				}`,
			);
			task.description = `[${args.filePath}](${url})`;
		}

		/**
		 * Line is indented, need to find parent task:
		 * 1. check previous lines until find a line with less indentation
		 * 2. if the line has todoist id, then get parent id and parent task object from cache
		 */
		if (this.isIndentedTask(args.lineContent)) {
			const lines = args.fileContent.split("\n") ?? [];

			// Check each line, in reverse, until a line with less indentation or reach the top of the file
			for (let i = args.lineNumber - 1; i >= 0; i--) {
				const line = lines[i];

				// Break if the line is blank, no possible parent task above
				if (this.isLineBlank(line)) {
					break;
				}

				// Same or higher indentation, continue searching
				if (
					this.getIndentation(line) >=
					this.getIndentation(args.lineContent)
				) {
					continue;
				}

				// Lower indentation found, check if it has todoist id
				if (
					this.getIndentation(line) <
					this.getIndentation(args.lineContent)
				) {
					if (this.hasTodoistId(line)) {
						task.parentId = this.extractTodoistIdFromText(line);
						task.hasParent = true;
						console.debug(
							`Found parent task with id ${task.parentId} for task ${task.content}`,
						);
						break;
					} else {
						break;
					}
				}
			}
		}
		if (task.hasParent && task.parentId) {
			// Remap the task project to parent one.
			const parentTask = this.plugin.cacheOperation?.loadTaskByID(
				task.parentId,
			);
			if (parentTask) {
				task.projectId = parentTask.projectId;
			}
		} else {
			// Check if any of the tags in the task content matches a project in the cache, if so, assign the project id to the task.
			for (const label of task.labels ?? []) {
				const labelName = label.replace(/#/g, "");
				const project =
					this.plugin.cacheOperation?.getProjectIdByNameFromCache(
						labelName,
					);
				if (project) {
					task.projectId = project;
					break;
				}
			}
		}
		return task;
	}

	/**
	 * Check whether the todoist tag is present in line
	 *
	 * @param text string
	 * @returns boolean
	 */
	hasTodoistTag(text: string): boolean {
		return REGEX.TODOIST_TAG.test(text);
	}

	hasTodoistId(text: string): boolean {
		return REGEX.TODOIST_ID.test(text);
	}

	hasDueDate(text: string): boolean {
		return REGEX.DUE_DATE_WITH_EMOJ.test(text);
	}

	getDueDateFromLineText(text: string): string | null {
		return text.match(REGEX.DUE_DATE)?.[1] ?? null;
	}

	getProjectNameFromLineText(text: string): string | null {
		return text.match(REGEX.PROJECT_NAME)?.[1] ?? null;
	}

	extractTodoistIdFromText(text: string): string | null {
		return text.match(REGEX.TODOIST_ID_NUM)?.[1] ?? null;
	}

	getTaskContentFromLineText(lineText: string) {
		const TaskContent = lineText
			.replace(REGEX.TASK_CONTENT.REMOVE_INLINE_METADATA, "")
			.replace(REGEX.TASK_CONTENT.REMOVE_TODOIST_LINK, "")
			.replace(REGEX.TASK_CONTENT.REMOVE_PRIORITY, " ") //priority 前后必须都有空格，
			.replace(REGEX.TASK_CONTENT.REMOVE_TAGS, "")
			.replace(REGEX.TASK_CONTENT.REMOVE_DATE, "")
			.replace(REGEX.TASK_CONTENT.REMOVE_CHECKBOX, "")
			.replace(REGEX.TASK_CONTENT.REMOVE_CHECKBOX_WITH_INDENTATION, "")
			.replace(REGEX.TASK_CONTENT.REMOVE_SPACE, "");
		return TaskContent;
	}

	getAllTagsFromLineText(lineText: string): string[] {
		let tags = lineText.match(REGEX.ALL_TAGS);

		if (tags) {
			// Remove '#' from each tag
			return tags.map((tag) => tag.replace("#", ""));
		}
		return [];
	}

	isNewTask(lineText: string): boolean {
		return this.hasTodoistTag(lineText) && !this.hasTodoistId(lineText);
	}

	isTaskCheckboxChecked(lineText: string): boolean {
		return REGEX.TASK_CHECKBOX_CHECKED.test(lineText);
	}

	//task content compare
	taskContentCompare(lineTask: TaskObject, todoistTask: LocalTask): boolean {
		const lineTaskContent = lineTask.content;
		//console.log(dataviewTaskContent)

		const todoistTaskContent = todoistTask.content;
		//console.log(todoistTask.content)

		//content 是否修改
		const contentModified = lineTaskContent === todoistTaskContent;
		return contentModified;
	}

	//tag compare
	taskTagCompare(lineTask: TaskObject, todoistTask: LocalTask): boolean {
		const lineTaskTags = lineTask.labels;
		//console.log(dataviewTaskTags)

		const todoistTaskTags = todoistTask.labels;
		//console.log(todoistTaskTags)

		//content 是否修改
		const tagsModified =
			lineTaskTags.length === todoistTaskTags.length &&
			lineTaskTags
				.sort()
				.every((val, index) => val === todoistTaskTags.sort()[index]);
		return tagsModified;
	}

	//task status compare
	taskStatusCompare(lineTask: TaskObject, todoistTask: LocalTask): boolean {
		//status 是否修改
		const statusModified = lineTask.isCompleted === todoistTask.isCompleted;
		//console.log(lineTask)
		//console.log(todoistTask)
		return statusModified;
	}

	//task due date compare
	compareTaskDueDate(lineTask: TaskObject, todoistTask: LocalTask): boolean {
		const lineTaskDue = lineTask.dueDate;
		const todoistTaskDue = todoistTask.due ?? "";
		//console.log(dataviewTaskDue)
		//console.log(todoistTaskDue)
		if (lineTaskDue === "" && todoistTaskDue === "") {
			//console.log('没有due date')
			return true;
		}

		if ((lineTaskDue || todoistTaskDue) === "") {
			return false;
		}

		const oldDueDateUTCString =
			this.localDateStringToUTCDateString(lineTaskDue);
		if (oldDueDateUTCString === todoistTaskDue.date) {
			return true;
		} else if (
			lineTaskDue.toString() === "Invalid Date" ||
			(typeof todoistTaskDue === "string"
				? todoistTaskDue
				: todoistTaskDue.date ?? ""
			).toString() === "Invalid Date"
		) {
			console.warn("invalid date");
			return false;
		} else {
			//console.log(lineTaskDue);
			//console.log(todoistTaskDue.date)
			return false;
		}
	}

	//task project id compare
	taskProjectCompare(lineTask: TaskObject, todoistTask: LocalTask): boolean {
		return lineTask.projectId === todoistTask.projectId;
	}

	isIndentedTask(text: string): boolean {
		return REGEX.TASK_INDENTATION.test(text);
	}

	getIndentation(lineText: string): number {
		const match = REGEX.TAB_INDENTATION.exec(lineText);
		return match ? match[1].length : 0;
	}

	getTaskPriority(lineText: string): number {
		const match = REGEX.TASK_PRIORITY.exec(lineText);
		return match ? Number(match[1]) : 1;
	}

	removeTaskIndentation(text: string): string {
		const regex = /^([ \t]*)?- \[(x| )\] /;
		return text.replace(regex, "- [$2] ");
	}

	isLineBlank(lineText: string): boolean {
		return REGEX.BLANK_LINE.test(lineText);
	}

	//在linetext中插入日期
	insertDueDateBeforeTodoist(text: string, dueDate: string): string {
		const regex = new RegExp(`(${keywords.TODOIST_TAG})`);
		return text.replace(regex, `📅 ${dueDate} $1`);
	}

	ISOStringToLocalDateString(utcTimeString: string) {
		try {
			if (utcTimeString === null) {
				return null;
			}
			let utcDateString = utcTimeString;
			let dateObj = new Date(utcDateString); // 将UTC格式字符串转换为Date对象
			let year = dateObj.getFullYear();
			let month = (dateObj.getMonth() + 1).toString().padStart(2, "0");
			let date = dateObj.getDate().toString().padStart(2, "0");
			let localDateString = `${year}-${month}-${date}`;
			return localDateString;
		} catch (error) {
			console.error(
				`Error extracting date from string '${utcTimeString}': ${error}`,
			);
			return null;
		}
	}

	ISOStringToLocalDatetimeString(utcTimeString: string) {
		try {
			if (utcTimeString === null) {
				return null;
			}
			let utcDateString = utcTimeString;
			let dateObj = new Date(utcDateString); // 将UTC格式字符串转换为Date对象
			let result = dateObj.toString();
			return result;
		} catch (error) {
			console.error(
				`Error extracting date from string '${utcTimeString}': ${error}`,
			);
			return null;
		}
	}

	//convert date from obsidian event
	// 使用示例
	//const str = "2023-03-27";
	//const utcStr = localDateStringToUTCDateString(str);
	//console.log(dateStr); // 输出 2023-03-27
	localDateStringToUTCDateString(localDateString: string) {
		try {
			if (localDateString === null) {
				return null;
			}
			localDateString = localDateString + "T08:00";
			let localDateObj = new Date(localDateString);
			let ISOString = localDateObj.toISOString();
			let utcDateString = ISOString.slice(0, 10);
			return utcDateString;
		} catch (error) {
			console.error(
				`Error extracting date from string '${localDateString}': ${error}`,
			);
			return null;
		}
	}

	isMarkdownTask(str: string): boolean {
		const taskRegex = /^\s*-\s+\[([x ])\]/;
		return taskRegex.test(str);
	}

	addTodoistTag(str: string): string {
		return str + ` ${keywords.TODOIST_TAG}`;
	}

	getObsidianUrlFromFilepath(filepath: string): string {
		const url = encodeURI(
			`obsidian://open?vault=${this.app.vault.getName()}&file=${filepath}`,
		);
		const obsidianUrl = `[${filepath}](${url})`;
		return obsidianUrl;
	}

	addTodoistLink(linetext: string, todoistLink: string): string {
		const regex = new RegExp(`${keywords.TODOIST_TAG}`, "g");
		return linetext.replace(regex, todoistLink + " " + "$&");
	}

	hasTodoistLink(lineText: string): boolean {
		return REGEX.TODOIST_LINK.test(lineText);
	}
}
