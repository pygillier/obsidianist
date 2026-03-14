import { App, Notice, PluginSettingTab, Setting, SettingGroup } from "obsidian";
import Obsidianist from "../main";
import { TodoistTaskData, FileMetadata } from "./interfaces";

interface MyProject {
	id: string;
	name: string;
}

type SettingGroupLike = {
	addSetting(cb: (setting: Setting) => void): void;
};

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

		const generalGroup = this.createSettingGroup("");

		this.addAPIKeySetting(generalGroup);
		this.addDefaultProjectSetting(generalGroup);
		this.addDesktopLinkSetting(generalGroup);

		const syncGroup = this.createSettingGroup("Synchronization");
		this.addSyncIntervalSetting(syncGroup);
		this.addFullSyncSetting(syncGroup);
		this.addManualSyncSetting(syncGroup);

		const toolsGroup = this.createSettingGroup("Advanced");
		this.addDBCheckSetting(toolsGroup);
		this.addDataBackupSetting(toolsGroup);
		this.addDebugModeSetting(toolsGroup);
	}

	private createSettingGroup(
		heading: string,
		className?: string,
	): SettingGroupLike {
		if (typeof SettingGroup === "function") {
			const group = new SettingGroup(this.containerEl).setHeading(
				heading,
			);
			if (className) group.addClass(className);
			return group;
		}

		const headingSetting = new Setting(this.containerEl)
			.setName(heading)
			.setHeading();
		if (className) headingSetting.settingEl.addClass(className);

		return {
			addSetting: (cb) => {
				cb(new Setting(this.containerEl));
			},
		};
	}

	private addSyncIntervalSetting(group: SettingGroupLike) {
		group.addSetting((setting) => {
			setting.setName("Update interval");
			setting.setDesc(
				"Interval, in seconds, between two updates from Todoist API (default: 300, min: 20)",
			);
			setting.addText((text) => {
				text.setPlaceholder("Interval")
					.setValue(
						this.plugin.settings.automaticSynchronizationInterval.toString(),
					)
					.onChange(async (value) => {
						const intervalNum = Number(value);
						if (Number.isInteger(intervalNum)) {
							if (intervalNum < 20) {
								new Notice(
									`The update interval cannot be less than 20 seconds.`,
								);
								return;
							} else {
								this.plugin.settings.automaticSynchronizationInterval =
									intervalNum;
								void this.plugin.saveSettings();
								new Notice("Settings have been updated.");
							}
						} else {
							new Notice(`Please type a number.`);
						}
					});
			});
		});
	}

	private addFullSyncSetting(group: SettingGroupLike) {
		group.addSetting((setting) => {
			setting
				.setName("Full vault synchronization")
				.setDesc(
					// eslint-disable-next-line obsidianmd/ui/sentence-case
					"Enable to synchronize all tasks in the vault, regardless of the #todoist tag.",
				)
				.addToggle((component) =>
					component
						.setValue(this.plugin.settings.enableFullVaultSync)
						.onChange((value) => {
							this.plugin.settings.enableFullVaultSync = value;
							void this.plugin.saveSettings();
							new Notice("Full vault sync is enabled.");
						}),
				);
		});
	}

	private addManualSyncSetting(group: SettingGroupLike) {
		group.addSetting((setting) => {
			setting
				.setName("Manual synchronization")
				.setDesc("Manually perform a synchronization task.")
				.addButton((button) =>
					button.setButtonText("Sync").onClick(async () => {
						// Add code here to handle exporting Todoist data
						if (!this.plugin.settings.apiInitialized) {
							new Notice(`Please set the Todoist API key first`);
							return;
						}
						try {
							await this.plugin.scheduledSynchronization();
							this.plugin.releaseSyncLock();
							new Notice(`Sync completed..`);
						} catch (error) {
							new Notice(
								`An error occurred while syncing.:${error}`,
							);
							this.plugin.releaseSyncLock();
						}
					}),
				);
		});
	}

	private addAPIKeySetting(group: SettingGroupLike) {
		group.addSetting((setting) => {
			setting
				.setName("API key")
				.addText((text) =>
					text
						.setPlaceholder("API key")
						.setValue(this.plugin.settings.todoistAPIToken)
						.onChange(async (value) => {
							this.plugin.settings.todoistAPIToken = value;
							this.plugin.settings.apiInitialized = false;
							//
						}),
				)
				.addExtraButton((button) => {
					button.setIcon("send").onClick(async () => {
						await this.plugin.modifyTodoistAPI();
						this.display();
					});
				});
		});
	}

	private addDefaultProjectSetting(group: SettingGroupLike) {
		const myProjectsOptions: MyProject =
			this.plugin.settings.todoistTasksData.projects.reduce(
				(obj, item) => {
					obj[item.id.toString()] = item.name;
					return obj;
				},
				{},
			);
		group.addSetting((setting) => {
			setting
				.setName("Default project")
				.setDesc(
					"Unless specified in note, new tasks will be added to selected project.",
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
							void this.plugin.saveSettings();
						}),
				);
		});
	}

	private addDesktopLinkSetting(group: SettingGroupLike) {
		group.addSetting((setting) => {
			setting
				.setName("Use desktop links")
				.setDesc(
					"Enable to open tasks in desktop app, if installed, instead of web app.",
				)
				.addToggle((component) =>
					component
						.setValue(this.plugin.settings.useAppURI)
						.onChange((value) => {
							this.plugin.settings.useAppURI = value;
							void this.plugin.saveSettings();
						}),
				);
		});
	}

	private addDBCheckSetting(group: SettingGroupLike) {
		group.addSetting((setting) => {
			setting
				.setName("Integrity checks")
				.setDesc(
					"Check for possible issues: sync error, file renaming not updated, or missed tasks not synchronized.",
				)
				.addButton((button) =>
					button.setButtonText("Run checks").onClick(async () => {
						// Add code here to handle exporting Todoist data
						if (!this.plugin.settings.apiInitialized) {
							new Notice(
								`Please ensure you defined the Todoist API key.`,
							);
							return;
						}

						//reinstall plugin

						//check file metadata
						console.debug("checking file metadata");
						await this.plugin.cacheOperation.checkFileMetadata();
						void this.plugin.saveSettings();
						const metadatas =
							this.plugin.cacheOperation.getAllFileMetadata();
						// check default project task amounts
						try {
							const projectId =
								this.plugin.settings.defaultProjectId;
							const tasks =
								await this.plugin.todoistAPI.getActiveTasks({
									projectId: projectId,
								});
							const length = Array.isArray(tasks)
								? tasks.length
								: 0;
							if (length >= 300) {
								new Notice(
									`The number of tasks in the default project exceeds 300, reaching the upper limit. It is not possible to add more tasks. Please modify the default project.`,
								);
							}
							//console.log(tasks)
						} catch (error) {
							console.error(
								`An error occurred while get tasks from todoist: ${
									(error as Error).message
								}`,
							);
						}

						if (!(await this.plugin.checkAndHandleSyncLock()))
							return;

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
										this.plugin.cacheOperation.loadTaskByID(
											taskId,
										);
								} catch (error) {
									console.error(
										`An error occurred while loading task cache: ${
											(error as Error).message
										}`,
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
										if (
											(error as Error).message.includes(
												"404",
											)
										) {
											// 处理404错误
											console.warn(
												`Task ${taskId} seems to not exist.`,
											);
											await this.plugin.cacheOperation.deleteTaskFromFileMetadata(
												key,
												taskId,
											);
										} else {
											// 处理其他错误
											console.error(error);
										}
									}
								}
							}
						}
						void this.plugin.saveSettings();

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
											this.plugin.cacheOperation.loadTaskByID(
												taskId,
											);
									} catch (error) {
										console.error(
											`An error occurred while loading task ${taskId} from cache: ${
												(error as Error).message
											}`,
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
												`An error occurred while updating task discription: ${
													(error as Error).message
												}`,
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
							for (const v of files) {
								if (v.extension == "md") {
									try {
										//console.log(`Scanning file ${v.path}`)
										await this.plugin.fileOperation.addTodoistLinkToFile(
											v.path,
										);
										if (
											this.plugin.settings
												.enableFullVaultSync
										) {
											await this.plugin.fileOperation.addTodoistTagToFile(
												v.path,
											);
										}
									} catch (error) {
										console.error(
											`An error occurred while check new tasks in the file: ${
												v.path
											}, ${(error as Error).message}`,
										);
									}
								}
							}
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
		});
	}

	private addDataBackupSetting(group: SettingGroupLike) {
		group.addSetting((setting) => {
			setting
				.setName("Backup Todoist data")
				.setDesc(
					"Backup your Todoist account in a dedicated file. File will be stored in the root of current vault.",
				)
				.addButton((button) =>
					button.setButtonText("Backup").onClick(() => {
						if (!this.plugin.settings.apiInitialized) {
							new Notice(`Please set the Todoist API key first`);
							return;
						}
						void this.plugin.todoistSync.backupTodoistAllResources();
					}),
				);
		});
	}

	private addDebugModeSetting(group: SettingGroupLike) {
		group.addSetting((setting) => {
			setting.setName("Debug mode").addToggle((component) =>
				component
					.setValue(this.plugin.settings.debugMode)
					.onChange((value) => {
						this.plugin.settings.debugMode = value;
						void this.plugin.saveSettings();
					}),
			);
		});
	}
}
