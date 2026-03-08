import { MarkdownView, Notice, Plugin, Editor } from "obsidian";

//settings
import {
	ObsidianistSettings,
	DEFAULT_SETTINGS,
	ObsidianistSettingTab,
} from "./src/settings";
//todoist  api
import { TodoistRestAPI } from "./src/todoistRestAPI";
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
import { SetDefalutProjectInTheFilepathModal } from "src/modal";

export default class Obsidianist extends Plugin {
	settings: ObsidianistSettings;
	todoistRestAPI: TodoistRestAPI;
	todoistAPI: TodoistAPI;
	taskParser: TaskParser;
	cacheOperation: CacheOperation;
	fileOperation: FileOperation;
	todoistSync: TodoistSync;
	lastLines: Map<string, number>;
	statusBar: HTMLElement;
	syncLock: boolean = false;

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
			console.log(`Plugin initialization failed, stopping plugin load.`);
			new Notice(`Plugin initialization failed, please check logs and try again.`);
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
				"PageDown"
			];
			
			// Track only if the editor has focus, to avoid unnecessary check when user is typing in other input box, such as setting input box
			if (this.app.workspace.activeEditor?.editor?.hasFocus()) {

				// If the key is one of the tracked keys, check line changes to trigger modified task check
				if (trackedKeys.includes(evt.key)) {
					this.checkLineChanges();
				}

				// Line editing keys Backspace and Delete, will trigger modified task check and deleted task check
				if (["Delete", "Backspace"].includes(evt.key)) {
					console.log(`Delete or Backspace key detected, checking line changes and deleted tasks...`);
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
				this.checkboxEventhandle(evt);
			} else if (this.app.workspace.activeEditor?.editor?.hasFocus()) {
				// User cliecked somewhere in the editor, check if line number changed to trigger modified task check
				this.checkLineChanges();
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
			this.app.workspace.on("editor-change", async (editor: Editor, view: MarkdownView) => {

					const cursor = editor.getCursor();
					const line = cursor.line;
					const linetxt = editor.getLine(line);


					// Fast fail
					if(this.settings.enableFullVaultSync) return;

					// Is this a new task ?
					if(!this.taskParser.isNewTask(linetxt)) return;
					
					console.log(`New task detected: ${linetxt}`)
					try {
						await this.acquireSyncLock();
						await this.todoistSync.addTaskFromLine(
							editor,
							view,
						);
						
						this.saveSettings();
					} catch (error) {
						console.error(
							`An error occurred while check new task in line: ${error.message}`,
						);
					} finally {
						// Release sync lock
						this.releaseSyncLock()
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
				console.log(`${oldpath} is renamed`);
				//读取frontMatter
				//const frontMatter = await this.fileOperation.getFrontMatter(file)
				const frontMatter =
					await this.cacheOperation.getFileMetadata(oldpath);
				console.log(frontMatter);
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
				this.saveSettings();

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
				this.syncLock = false;
			}),
		);

		//Listen for file modified events and execute fullTextNewTaskCheck
		this.registerEvent(
			this.app.vault.on("modify", async (file) => {
				console.log("MODIFU")
				try {
					if (!this.settings.apiInitialized) {
						return;
					}
					const filepath = file.path;
					console.log(`${filepath} is modified`);

					//get current view

					const activateFile = this.app.workspace.getActiveFile();

					console.log(activateFile?.path);

					//To avoid conflicts, Do not check files being edited
					if (activateFile?.path == filepath) {
						return;
					}

					if (!(await this.checkAndHandleSyncLock())) return;

					await this.todoistSync.fullTextNewTaskCheck(filepath);
					this.syncLock = false;
				} catch (error) {
					console.error(
						`An error occurred while modifying the file: ${error.message}`,
					);
					this.syncLock = false;
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
				async () => await this.scheduledSynchronization(),
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
			name: "Set default project for todoist task in the current file",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				if (!view) {
					return;
				}
				const filepath = view.file?.path;
				new SetDefalutProjectInTheFilepathModal(
					this.app,
					this,
					filepath,
				);
			},
		});

		//display default project for the current file on status bar
		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		this.statusBar = this.addStatusBarItem();
	}

	async onunload(): Promise<void> {
		console.warn(`Unloading obsidianist, saving settings.`);
		await this.saveSettings();
	}

	async loadSettings(): Promise<boolean> {
		try {
			const data = await this.loadData();
			this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
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
	 * INitialize the plugin, including:
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
		this.cacheOperation = new CacheOperation(this.app, this);
		const isProjectsSaved = await this.cacheOperation.saveProjectsToCache();

		if (!isProjectsSaved) {
			new Notice(
				`Obsidianist initialization failed, please check the todoist api`,
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

	async initializeModuleClass() {
		//initialize todoist restapi
		this.todoistRestAPI = new TodoistRestAPI(this.app, this);

		this.todoistAPI = new TodoistAPI(this.app, this);

		//initialize data read and write object
		this.cacheOperation = new CacheOperation(this.app, this);
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
			const cursor = view.app.workspace
				.getActiveViewOfType(MarkdownView)
				?.editor.getCursor();
			const line = cursor?.line;
			const fileContent = view.data;

			const fileName =
				view.app.workspace.getActiveViewOfType(MarkdownView)?.app
					.workspace.activeEditor?.file?.name;
			const filepath =
				view.app.workspace.getActiveViewOfType(MarkdownView)?.app
					.workspace.activeEditor?.file?.path;
			if (
				typeof this.lastLines === "undefined" ||
				typeof this.lastLines.get(fileName as string) === "undefined"
			) {
				this.lastLines.set(fileName as string, line as number);
				return;
			}

			if (
				this.lastLines.has(fileName as string) &&
				line !== this.lastLines.get(fileName as string)
			) {
				const lastLine = this.lastLines.get(fileName as string);
				this.debugLog(`Line changed! current line is ${line}, last line is ${lastLine}`);
				
				const lastLineText = view.editor.getLine(lastLine as number);

				this.lastLines.set(fileName as string, line as number);
				try {
					if (!(await this.checkAndHandleSyncLock())) return;
					await this.todoistSync.lineModifiedTaskCheck(
						filepath as string,
						lastLineText,
						lastLine as number,
						fileContent,
					);
					this.syncLock = false;
				} catch (error) {
					console.error(
						`An error occurred while check modified task in line text: ${error}`,
					);
					this.syncLock = false;
				}
			}
		}
	}

	async checkboxEventhandle(evt: MouseEvent) {

		const target = evt.target as HTMLInputElement;

		// Look for the surrounding div that contains the checkbox, which should also contain the task text
		const taskElement = target.closest("div"); 

		if (taskElement) {
			console.log('Task element found:', taskElement.textContent);

			const taskId = this.taskParser.extractTodoistIdFromText(taskElement.textContent || "");
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
				this.todoistRestAPI === undefined ||
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

	async setStatusBarText() {
		if (!this.checkModuleClass()) {
			return;
		}
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			this.statusBar.setText("");
		} else {
			const filepath =
				this.app.workspace.getActiveViewOfType(MarkdownView)?.file
					?.path;
			if (filepath === undefined) {
				console.log(`file path undefined`);
				return;
			}
			const defaultProjectName =
				await this.cacheOperation.getDefaultProjectNameForFilepath(
					filepath as string,
				);
			if (defaultProjectName === undefined) {
				console.log(`projectName undefined`);
				return;
			}
			this.statusBar.setText(defaultProjectName);
		}
	}

	/**
	 * Sync todoist data to obsidian, including tasks, projects, labels, sections, and comments.
	 * @returns
	 */
	async scheduledSynchronization(): Promise<void> {
		console.log(
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
			new Notice("An error occurred:", error);
			this.syncLock = false;
		} finally {
			console.log(
				"Todoist scheduled synchronization task completed at",
				new Date().toLocaleString(),
			);
		}

	}

	async checkSyncLock() {
		let checkCount = 0;
		while (this.syncLock && checkCount < 10) {
			await new Promise((resolve) => setTimeout(resolve, 1000));
			checkCount++;
		}
		return !this.syncLock;
	}

	async checkAndHandleSyncLock() {
		if (this.syncLock) {
			console.log("sync locked.");
			const isSyncLockChecked = await this.checkSyncLock();
			if (!isSyncLockChecked) {
				return false;
			}
			console.log("sync unlocked.");
		}
		this.syncLock = true;
		return true;
	}

	async acquireSyncLock() {
		if(this.syncLock)
		{
			// Lock is already set, wait for release
			this.debugLog("Waiting for SyncLock to release...")
			let counter = 0
			while (this.syncLock && counter < 10) {
				await new Promise((resolve) => setTimeout(resolve, 1000));
				counter++;
				this.debugLog(`${counter}/10`)
			}
			if(this.syncLock)
			{
				// Lock still isn't released
				throw new Error("Unable to acquire sync lock")
			}
			else
			{
				// Lock released from outside, take it
				this.debugLog("Acquiring sync lock")
				this.syncLock = true
			}
		}
		else
		{
			// Lock released from outside, take it
			this.debugLog("Acquiring sync lock")
			this.syncLock = true
		}
	}

	releaseSyncLock() {
		this.debugLog("Releasing sync lock")
		this.syncLock = false
	}

	debugLog(message: string) {
		if (this.settings.debugMode) {
			console.debug(message);
		}
	}
}
