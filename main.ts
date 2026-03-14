import { MarkdownView, Notice, Plugin, Editor } from "obsidian";

//settings
import {
	ObsidianistSettings,
	DEFAULT_SETTINGS,
	ObsidianistSettingTab,
} from "./src/settings";
//todoist  api
import { TodoistAPI } from "src/todoistAPI";
//task parser
import { TaskParser } from "./src/taskParser";
//cache task read and write
import { CacheOperation } from "./src/cacheOperation";
//file operation
import { FileOperation } from "./src/fileOperation";

//sync module
import { TodoistSync } from "./src/syncModule";

//import modal
import { DefaultProjectModal } from "src/modal";

export default class Obsidianist extends Plugin {
	settings: ObsidianistSettings;
	todoistAPI: TodoistAPI;
	taskParser: TaskParser;
	cacheOperation: CacheOperation;
	fileOperation: FileOperation;
	todoistSync: TodoistSync;
	lastLines: Map<string, number>;
	statusBar: HTMLElement;
	syncLock: boolean = false;
	private syncLockQueue: Array<() => void> = [];

	async onload() {
		const isSettingsLoaded = await this.loadSettings();

		if (!isSettingsLoaded) {
			new Notice(
				"Could not load obsidianist settings, please reload the plugin.",
			);
			return;
		}
		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new ObsidianistSettingTab(this.app, this));

		await this.initializePlugin();
		if (!this.settings.apiInitialized) {
			// Some error happened during initialization, stop loading the plugin
			console.error(
				`Plugin initialization failed, stopping plugin load.`,
			);
			new Notice(
				`Plugin initialization failed, please check logs and try again.`,
			);
			return;
		}

		//lastLine 对象 {path:line}保存在lastLines map中
		this.lastLines = new Map();

		//key 事件监听，判断换行和删除
		this.registerDomEvent(document, "keyup", async (evt: KeyboardEvent) => {
			const trackedKeys = [
				"ArrowUp",
				"ArrowDown",
				"ArrowLeft",
				"ArrowRight",
				"PageUp",
				"PageDown",
			];

			// Track only if the editor has focus, to avoid unnecessary check when user is typing in other input box, such as setting input box
			if (this.app.workspace.activeEditor?.editor?.hasFocus()) {
				// If the key is one of the tracked keys, check line changes to trigger modified task check
				if (trackedKeys.includes(evt.key)) {
					void this.checkLineChanges();
				}

				// Line editing keys Backspace and Delete, will trigger modified task check and deleted task check
				if (["Delete", "Backspace"].includes(evt.key)) {
					console.debug(
						`Delete or Backspace key detected, checking line changes and deleted tasks...`,
					);
					try {
						await this.acquireSyncLock();
						await this.todoistSync.deletedTaskCheck();
						await this.saveSettings();
					} catch (error) {
						console.error(
							`An error occurred while deleting tasks: ${error}`,
						);
					} finally {
						this.releaseSyncLock();
					}
				}
			}
		});

		// If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
		// Using this function will automatically remove the event listener when this plugin is disabled.
		this.registerDomEvent(document, "click", async (evt: MouseEvent) => {
			const target = evt.target as HTMLInputElement;

			if (target.type === "checkbox") {
				void this.checkboxEventhandle(evt);
			} else if (this.app.workspace.activeEditor?.editor?.hasFocus()) {
				// User cliecked somewhere in the editor, check if line number changed to trigger modified task check
				void this.checkLineChanges();
			} else {
				// Not in editor, do nothing
			}
			return;
		});

		/**
		 * Event raised each time editor content change.
		 * Fail fast (checking settings & mode) to speed up.
		 * Try to create a new task.
		 */
		this.registerEvent(
			this.app.workspace.on(
				"editor-change",
				async (editor: Editor, view: MarkdownView) => {
					const cursor = editor.getCursor();
					const line = cursor.line;
					const linetxt = editor.getLine(line);

					// Fast fail
					if (this.settings.enableFullVaultSync) return;

					// Is this a new task ?
					if (!this.taskParser.isNewTask(linetxt)) return;

					console.debug(`New task detected: ${linetxt}`);
					try {
						await this.acquireSyncLock();
						await this.todoistSync.addTaskFromLine(editor, view);

						await this.saveSettings();
					} catch (error) {
						console.error(
							`An error occurred while check new task in line: ${
								(error as Error).message
							}`,
						);
					} finally {
						// Release sync lock
						this.releaseSyncLock();
					}
				},
			),
		);

		//监听 rename 事件,更新 task data 中的 path
		this.registerEvent(
			this.app.vault.on("rename", async (file, oldpath) => {
				if (!this.settings.apiInitialized) {
					return;
				}
				console.debug(`${oldpath} is renamed`);
				//读取frontMatter
				//const frontMatter = await this.fileOperation.getFrontMatter(file)
				const frontMatter =
					this.cacheOperation.getFileMetadata(oldpath);
				console.debug(frontMatter);
				if (
					frontMatter === null ||
					frontMatter.todoistTasks === undefined
				) {
					//console.log('删除的文件中没有task')
					return;
				}
				if (!this.checkModuleClass()) {
					return;
				}
				await this.cacheOperation.updateRenamedFilePath(
					oldpath,
					file.path,
				);
				void this.saveSettings();

				//update task description
				if (!(await this.checkAndHandleSyncLock())) return;
				try {
					await this.todoistSync.updateTaskDescription(file.path);
				} catch (error) {
					console.error(
						"An error occurred in updateTaskDescription:",
						error,
					);
				}
				this.releaseSyncLock();
			}),
		);

		//Listen for file modified events and execute fullTextNewTaskCheck
		this.registerEvent(
			this.app.vault.on("modify", async (file) => {
				try {
					if (!this.settings.apiInitialized) {
						return;
					}
					const filepath = file.path;
					console.debug(`${filepath} is modified`);

					//get current view

					const activateFile = this.app.workspace.getActiveFile();

					console.debug(activateFile?.path);

					//To avoid conflicts, Do not check files being edited
					if (activateFile?.path == filepath) {
						return;
					}

					if (!(await this.checkAndHandleSyncLock())) return;

					await this.todoistSync.fullTextNewTaskCheck(filepath);
					this.releaseSyncLock();
				} catch (error) {
					console.error(
						`An error occurred while modifying the file: ${
							(error as Error).message
						}`,
					);
					this.releaseSyncLock();
					// You can add further error handling logic here. For example, you may want to
					// revert certain operations, or alert the user about the error.
				}
			}),
		);

		/**
		 * Scheduled synchronization task
		 */
		this.registerInterval(
			window.setInterval(
				() => {
					void this.scheduledSynchronization();
				},
				Number(this.settings.automaticSynchronizationInterval) * 1000,
			),
		);

		this.app.workspace.on("active-leaf-change", (leaf) => {
			this.setStatusBarText();
		});

		// set the default project for a todoist task in the current file
		// This adds an editor command that can perform some operation on the current editor instance
		this.addCommand({
			id: "set-default-project-for-todoist-task-in-the-current-file",
			name: "Set default project for current file",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				if (!view) {
					return;
				}
				const filepath = view.file?.path ?? null;
				new DefaultProjectModal(this.app, { plugin: this, filepath });
			},
		});

		//display default project for the current file on status bar
		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		this.statusBar = this.addStatusBarItem();
	}

	onunload(): void {
		console.warn(`Unloading obsidianist, saving settings.`);
		void this.saveSettings();
	}

	async loadSettings(): Promise<boolean> {
		try {
			const data =
				(await this.loadData()) as Partial<ObsidianistSettings> | null;
			this.settings = Object.assign(
				{},
				DEFAULT_SETTINGS,
				data,
			) as ObsidianistSettings;
			return true;
		} catch (error) {
			console.error("Failed to load settings:", error);
			return false;
		}
	}

	async saveSettings(): Promise<void> {
		try {
			// 验证设置是否存在且不为空
			if (this.settings && Object.keys(this.settings).length > 0) {
				await this.saveData(this.settings);
			} else {
				console.error(
					"Settings are empty or invalid, not saving to avoid data loss.",
				);
			}
		} catch (error) {
			// 打印或处理错误
			console.error("Error saving settings:", error);
		}
	}

	async modifyTodoistAPI() {
		await this.initializePlugin();
	}

	/**
	 * Initialize the plugin, including:
	 * 1. initialize todoist api module
	 * 2. initialize data read and write module, and save projects and labels data to cache
	 * 3. if first time to initialize, create backup of all todoist data, and initialize settings
	 * @returns boolean
	 */
	async initializePlugin(): Promise<void> {
		if (!this.settings.todoistAPIToken) {
			new Notice("Please enter your Todoist API token in the settings.");
			return;
		}
		this.todoistAPI = new TodoistAPI(this.app, this);

		//initialize data read and write object
		this.cacheOperation = new CacheOperation({
			app: this.app,
			plugin: this,
		});
		const isProjectsSaved = await this.cacheOperation.saveProjectsToCache();

		if (!isProjectsSaved) {
			new Notice(
				"Todoistian initialization failed, check Todoist API key",
			);
			return;
		}

		this.taskParser = new TaskParser(this.app, this);
		this.fileOperation = new FileOperation(this.app, this);
		this.todoistSync = new TodoistSync(this.app, this);

		this.settings.apiInitialized = true;
		new Notice(`Obsidianist started successfully.`);
		return;
	}

	initializeModuleClass() {
		this.todoistAPI = new TodoistAPI(this.app, this);

		//initialize data read and write object
		this.cacheOperation = new CacheOperation({
			app: this.app,
			plugin: this,
		});
		this.taskParser = new TaskParser(this.app, this);

		//initialize file operation
		this.fileOperation = new FileOperation(this.app, this);

		//initialize todoist sync module
		this.todoistSync = new TodoistSync(this.app, this);
	}

	/**
	 * Check if the line number has changed, if changed, trigger modified task check for the line text.
	 * This is used to detect task modification that can not be detected by checkbox click or file modify, such as task description modification, task move, etc.
	 * The modified task check will compare the line text before and after modification, if the line text is different, it will trigger the modified task check.
	 * @returns
	 */
	async checkLineChanges() {
		this.debugLog(`Checking line changes...`);
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view) {
			const cursor = view.editor.getCursor();
			const line = cursor.line;
			const fileContent = view.data;
			const fileName = view.file?.name;
			const filepath = view.file?.path;
			if (!fileName || !filepath) return;
			if (
				typeof this.lastLines === "undefined" ||
				typeof this.lastLines.get(fileName) === "undefined"
			) {
				this.lastLines.set(fileName, line);
				return;
			}

			if (
				this.lastLines.has(fileName) &&
				line !== this.lastLines.get(fileName)
			) {
				const lastLine = this.lastLines.get(fileName);
				this.debugLog(
					`Line changed! current line is ${line}, last line is ${lastLine}`,
				);

				const lastLineText = view.editor.getLine(lastLine ?? 0);

				this.lastLines.set(fileName, line);
				try {
					if (!(await this.checkAndHandleSyncLock())) return;
					await this.todoistSync.lineModifiedTaskCheck(
						filepath,
						lastLineText,
						lastLine ?? 0,
						fileContent,
					);
					this.releaseSyncLock();
				} catch (error) {
					console.error(
						`An error occurred while check modified task in line text: ${error}`,
					);
					this.releaseSyncLock();
				}
			}
		}
	}

	async checkboxEventhandle(evt: MouseEvent) {
		const target = evt.target as HTMLInputElement;

		// Look for the surrounding div that contains the checkbox, which should also contain the task text
		const taskElement = target.closest("div");

		if (taskElement) {
			console.debug("Task element found:", taskElement.textContent);

			const taskId = this.taskParser.extractTodoistIdFromText(
				taskElement.textContent || "",
			);
			if (taskId) {
				if (target.checked) {
					await this.todoistSync.closeTask(taskId);
				} else {
					await this.todoistSync.reopenTask(taskId);
				}
			}
		}
	}

	//return true
	checkModuleClass(): boolean {
		if (this.settings.apiInitialized) {
			if (
				this.cacheOperation === undefined ||
				this.fileOperation === undefined ||
				this.todoistSync === undefined ||
				this.taskParser === undefined
			) {
				this.initializeModuleClass();
			}
			return true;
		} else {
			new Notice(`Please enter the correct Todoist API token"`);
			return false;
		}
	}

	setStatusBarText() {
		if (!this.checkModuleClass()) {
			return;
		}
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			this.statusBar.setText("");
		} else {
			const filepath = view.file?.path;
			if (filepath === undefined) {
				console.warn(`file path undefined`);
				return;
			}

			const project = this.cacheOperation.getProjectForFile(filepath);
			if (project?.projectName === undefined) {
				console.warn(`projectName undefined`);
				return;
			}
			this.statusBar.setText(project?.projectName);
		}
	}

	/**
	 * Sync todoist data to obsidian, including tasks, projects, labels, sections, and comments.
	 * @returns
	 */
	async scheduledSynchronization(): Promise<void> {
		console.debug(
			"Todoist scheduled synchronization task started at",
			new Date().toLocaleString(),
		);
		try {
			// Sync todoist data to obsidian, including tasks, projects, labels, sections and comments.
			await this.acquireSyncLock();
			await this.todoistSync.syncTodoistToObsidian();

			this.releaseSyncLock();
			await this.saveSettings();
		} catch (error) {
			console.error("An error occurred:", error);
			new Notice(`An error occurred: ${String(error)}`);
			this.releaseSyncLock();
		} finally {
			console.debug(
				"Todoist scheduled synchronization task completed at",
				new Date().toLocaleString(),
			);
		}
	}

	async acquireSyncLock(): Promise<void> {
		if (!this.syncLock) {
			this.syncLock = true;
			this.debugLog("Acquiring sync lock");
			return;
		}
		this.debugLog("Waiting for sync lock to release...");
		return new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				const idx = this.syncLockQueue.indexOf(resolve);
				if (idx !== -1) this.syncLockQueue.splice(idx, 1);
				reject(new Error("Unable to acquire sync lock: timeout"));
			}, 10000);
			this.syncLockQueue.push(() => {
				clearTimeout(timeout);
				this.debugLog("Acquiring sync lock");
				resolve();
			});
		});
	}

	releaseSyncLock(): void {
		this.debugLog("Releasing sync lock");
		if (this.syncLockQueue.length > 0) {
			const next = this.syncLockQueue.shift()!;
			next();
		} else {
			this.syncLock = false;
		}
	}

	async checkAndHandleSyncLock(): Promise<boolean> {
		try {
			await this.acquireSyncLock();
			return true;
		} catch {
			return false;
		}
	}

	debugLog(message: string) {
		if (this.settings.debugMode) {
			console.debug(message);
		}
	}
}
