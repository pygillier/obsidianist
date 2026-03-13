import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import Obsidianist from "../main";
import { TodoistTaskData, FileMetadata } from "./interfaces";

interface MyProject {
	id: string;
	name: string;
}

export interface ObsidianistSettings {
	initialized: boolean;
	todoistAPIToken: string;
	apiInitialized: boolean;
	defaultProjectName: string;
	defaultProjectId: string;
	automaticSynchronizationInterval: number;
	todoistTasksData: TodoistTaskData;
	fileMetadata: Record<string, FileMetadata>;
	enableFullVaultSync: boolean;
	statistics: Record<string, unknown>;
	debugMode: boolean;
	useAppURI: boolean;
	lastSyncTime: number;
}

export const DEFAULT_SETTINGS: ObsidianistSettings = {
	initialized: false,
	apiInitialized: false,
	defaultProjectName: "Inbox",
	automaticSynchronizationInterval: 300, //default aync interval 300s
	todoistTasksData: { projects: [], tasks: [], events: [] },
	fileMetadata: {},
	enableFullVaultSync: false,
	statistics: {},
	debugMode: false,
	useAppURI: true,
	lastSyncTime: new Date(
		new Date().setDate(new Date().getDate() - 7),
	).getTime(),
};

export class ObsidianistSettingTab extends PluginSettingTab {
	plugin: Obsidianist;

	constructor(app: App, plugin: Obsidianist) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		const myProjectsOptions: MyProject | undefined =
			this.plugin.settings.todoistTasksData?.projects?.reduce(
				(obj, item) => {
					obj[item.id.toString()] = item.name;
					return obj;
				},
				{},
			);

		new Setting(containerEl)
			.setName("Todoist API")
			.setDesc(
				"Please enter todoist api token and click the paper airplane button to submit.",
			)
			.addText((text) =>
				text
					.setPlaceholder("Enter your API")
					.setValue(this.plugin.settings.todoistAPIToken)
					.onChange(async (value) => {
						this.plugin.settings.todoistAPIToken = value;
						this.plugin.settings.apiInitialized = false;
						//
					}),
			)
			.addExtraButton((button) => {
				button.setIcon("send").onClick(async () => {
					await this.plugin.modifyTodoistAPI(
						this.plugin.settings.todoistAPIToken,
					);
					this.display();
				});
			});

		new Setting(containerEl)
			.setName("Automatic Sync Interval Time")
			.setDesc(
				"Please specify the desired interval time, with seconds as the default unit. The default setting is 300 seconds, which corresponds to syncing once every 5 minutes. You can customize it, but it cannot be lower than 20 seconds.",
			)
			.addText((text) =>
				text
					.setPlaceholder("Sync interval")
					.setValue(
						this.plugin.settings.automaticSynchronizationInterval.toString(),
					)
					.onChange(async (value) => {
						const intervalNum = Number(value);
						if (isNaN(intervalNum)) {
							new Notice(`Wrong type,please enter a number.`);
							return;
						}
						if (intervalNum < 20) {
							new Notice(
								`The synchronization interval time cannot be less than 20 seconds.`,
							);
							return;
						}
						if (!Number.isInteger(intervalNum)) {
							new Notice(
								"The synchronization interval must be an integer.",
							);
							return;
						}
						this.plugin.settings.automaticSynchronizationInterval =
							intervalNum;
						this.plugin.saveSettings();
						new Notice("Settings have been updated.");
						//
					}),
			);

		/*
		new Setting(containerEl)
			.setName('The default project for new tasks')
			.setDesc('New tasks are automatically synced to the Inbox. You can modify the project here.')
			.addText((text) =>
				text
					.setPlaceholder('Enter default project name:')
					.setValue(this.plugin.settings.defaultProjectName)
					.onChange(async (value) => {
						try{
							//this.plugin.cacheOperation.saveProjectsToCache()
							const newProjectId = this.plugin.cacheOperation.getProjectIdByNameFromCache(value)
							if(!newProjectId){
								new Notice(`This project seems to not exist.`)
								return
							}
						}catch(error){
							new Notice(`Invalid project name `)
							return
						}
						this.plugin.settings.defaultProjectName = value;
						this.plugin.saveSettings()
						new Notice(`The default project has been modified successfully.`)

					})

		);
		*/

		new Setting(containerEl)
			.setName("Default Project")
			.setDesc(
				"New tasks are automatically synced to the default project. You can modify the project here.",
			)
			.addDropdown((component) =>
				component
					.addOption(
						this.plugin.settings.defaultProjectId,
						this.plugin.settings.defaultProjectName,
					)
					.addOptions(myProjectsOptions)
					.onChange((value) => {
						this.plugin.settings.defaultProjectId = value;
						this.plugin.settings.defaultProjectName =
							this.plugin.cacheOperation.getProjectNameByIdFromCache(
								value,
							);
						this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Full Vault Sync")
			.setDesc(
				"By default, only tasks marked with #todoist are synchronized. If this option is turned on, all tasks in the vault will be synchronized.",
			)
			.addToggle((component) =>
				component
					.setValue(this.plugin.settings.enableFullVaultSync)
					.onChange((value) => {
						this.plugin.settings.enableFullVaultSync = value;
						this.plugin.saveSettings();
						new Notice("Full vault sync is enabled.");
					}),
			);

		new Setting(containerEl)
			.setName("Manual Sync")
			.setDesc("Manually perform a synchronization task.")
			.addButton((button) =>
				button.setButtonText("Sync").onClick(async () => {
					// Add code here to handle exporting Todoist data
					if (!this.plugin.settings.apiInitialized) {
						new Notice(`Please set the todoist api first`);
						return;
					}
					try {
						await this.plugin.scheduledSynchronization();
						this.plugin.releaseSyncLock();
						new Notice(`Sync completed..`);
					} catch (error) {
						new Notice(`An error occurred while syncing.:${error}`);
						this.plugin.releaseSyncLock();
					}
				}),
			);

		new Setting(containerEl)
			.setName("Check Database")
			.setDesc(
				"Check for possible issues: sync error, file renaming not updated, or missed tasks not synchronized.",
			)
			.addButton((button) =>
				button.setButtonText("Check Database").onClick(async () => {
					// Add code here to handle exporting Todoist data
					if (!this.plugin.settings.apiInitialized) {
						new Notice(`Please set the todoist api first`);
						return;
					}

					//reinstall plugin

					//check file metadata
					console.debug("checking file metadata");
					await this.plugin.cacheOperation.checkFileMetadata();
					this.plugin.saveSettings();
					const metadatas =
						await this.plugin.cacheOperation.getAllFileMetadata();
					// check default project task amounts
					try {
						const projectId = this.plugin.settings.defaultProjectId;
						let options = {};
						options.projectId = projectId;
						const tasks =
							await this.plugin.todoistAPI.getActiveTasks(
								options,
							);
						let length = tasks.length;
						if (length >= 300) {
							new Notice(
								`The number of tasks in the default project exceeds 300, reaching the upper limit. It is not possible to add more tasks. Please modify the default project.`,
							);
						}
						//console.log(tasks)
					} catch (error) {
						console.error(
							`An error occurred while get tasks from todoist: ${error.message}`,
						);
					}

					if (!(await this.plugin.checkAndHandleSyncLock())) return;

					console.debug("checking deleted tasks");
					//check empty task
					for (const key in metadatas) {
						const value = metadatas[key];
						//console.log(value)
						for (const taskId of value.todoistTasks) {
							//console.log(`${taskId}`)
							let taskObject;

							try {
								taskObject =
									await this.plugin.cacheOperation.loadTaskByID(
										taskId,
									);
							} catch (error) {
								console.error(
									`An error occurred while loading task cache: ${error.message}`,
								);
							}

							if (!taskObject) {
								console.warn(
									`The task data of the ${taskId} is empty.`,
								);
								//get from todoist
								try {
									taskObject =
										await this.plugin.todoistAPI.getTaskById(
											taskId,
										);
								} catch (error) {
									if (error.message.includes("404")) {
										// 处理404错误
										console.warn(
											`Task ${taskId} seems to not exist.`,
										);
										await this.plugin.cacheOperation.deleteTaskFromFileMetadata(
											key,
											taskId,
										);
										continue;
									} else {
										// 处理其他错误
										console.error(error);
										continue;
									}
								}
							}
						}
					}
					this.plugin.saveSettings();

					console.debug("checking renamed files");
					try {
						//check renamed files
						for (const key in metadatas) {
							const value = metadatas[key];
							//console.log(value)
							const newDescription =
								this.plugin.taskParser.getObsidianUrlFromFilepath(
									key,
								);
							for (const taskId of value.todoistTasks) {
								//console.log(`${taskId}`)
								let taskObject;
								try {
									taskObject =
										await this.plugin.cacheOperation.loadTaskByID(
											taskId,
										);
								} catch (error) {
									console.error(
										`An error occurred while loading task ${taskId} from cache: ${error.message}`,
									);
									console.debug(taskObject);
								}
								if (!taskObject) {
									console.warn(
										`Task ${taskId} seems to not exist.`,
									);
									continue;
								}
								if (!taskObject?.description) {
									console.warn(
										`The description of the task ${taskId} is empty.`,
									);
								}
								const oldDescription =
									taskObject?.description ?? "";
								if (newDescription != oldDescription) {
									console.debug(
										"Preparing to update description.",
									);
									console.debug(oldDescription);
									console.debug(newDescription);
									try {
										//await this.plugin.todoistSync.updateTaskDescription(key)
									} catch (error) {
										console.error(
											`An error occurred while updating task discription: ${error.message}`,
										);
									}
								}
							}
						}

						//check empty file metadata

						//check calendar format

						//check omitted tasks
						console.debug("checking unsynced tasks");
						const files = this.app.vault.getFiles();
						files.forEach(async (v, i) => {
							if (v.extension == "md") {
								try {
									//console.log(`Scanning file ${v.path}`)
									await this.plugin.fileOperation.addTodoistLinkToFile(
										v.path,
									);
									if (
										this.plugin.settings.enableFullVaultSync
									) {
										await this.plugin.fileOperation.addTodoistTagToFile(
											v.path,
										);
									}
								} catch (error) {
									console.error(
										`An error occurred while check new tasks in the file: ${v.path}, ${error.message}`,
									);
								}
							}
						});
						this.plugin.releaseSyncLock();
						new Notice(`All files have been scanned.`);
					} catch (error) {
						console.error(
							`An error occurred while scanning the vault.:${error}`,
						);
						this.plugin.releaseSyncLock();
					}
				}),
			);

		new Setting(containerEl)
			.setName("Debug Mode")
			.setDesc(
				"After enabling this option, all log information will be output to the console, which can help check for errors.",
			)
			.addToggle((component) =>
				component
					.setValue(this.plugin.settings.debugMode)
					.onChange((value) => {
						this.plugin.settings.debugMode = value;
						this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Backup Todoist Data")
			.setDesc(
				"Click to backup Todoist data, The backed-up files will be stored in the root directory of the Obsidian vault.",
			)
			.addButton((button) =>
				button.setButtonText("Backup").onClick(() => {
					// Add code here to handle exporting Todoist data
					if (!this.plugin.settings.apiInitialized) {
						new Notice(`Please set the todoist api first`);
						return;
					}
					this.plugin.todoistSync.backupTodoistAllResources();
				}),
			);

		new Setting(containerEl)
			.setName("Use Desktop URIs")
			.setDesc(
				"If enabled produces application URI links (todoist://...) instead of web urls (https://...), which open in the app instead of the browser",
			)
			.addToggle((component) =>
				component
					.setValue(this.plugin.settings.useAppURI)
					.onChange((value) => {
						this.plugin.settings.useAppURI = value;
						this.plugin.saveSettings();
					}),
			);
	}
}
