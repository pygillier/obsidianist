import { App, Modal, Setting } from "obsidian";
import Obsidianist from "../main";

export class DefaultProjectModal extends Modal {
	defaultProjectId: string;
	defaultProjectName: string;
	filepath: string | null;
	plugin: Obsidianist;

	constructor(
		app: App,
		{
			plugin,
			filepath = null,
		}: { plugin: Obsidianist; filepath?: string | null },
	) {
		super(app);
		this.filepath = filepath;
		this.plugin = plugin;
		this.open();
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h5", {
			text: "Set default project for todoist tasks in the current file",
		});

		if (!this.filepath) {
			contentEl.createEl("p", { text: "No file is currently open." });
			return;
		}

		const project = this.plugin.cacheOperation.getProjectForFile(
			this.filepath,
		);

		this.defaultProjectId = project.projectId;
		this.defaultProjectName = project.projectName;

		const filepath = this.filepath;
		const myProjectsOptions: Record<string, string> =
			this.plugin.settings.todoistTasksData?.projects?.reduce(
				(
					obj: Record<string, string>,
					item: { id: string | number; name: string },
				) => {
					obj[item.id.toString()] = item.name;
					return obj;
				},
				{},
			) ?? {};

		new Setting(contentEl)
			.setName("Default project")
			//.setDesc('Set default project for todoist tasks in the current file')
			.addDropdown((component) =>
				component
					.addOption(this.defaultProjectId, this.defaultProjectName)
					.addOptions(myProjectsOptions)
					.onChange((value) => {
						console.debug(`project id  is ${value}`);
						this.plugin.cacheOperation.setDefaultProjectForFile(
							filepath,
							value,
						);
						this.plugin.setStatusBarText();
						this.close();
					}),
			);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
