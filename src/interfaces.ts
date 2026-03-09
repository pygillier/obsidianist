import {
	ActivityEvent,
	PersonalProject,
	Task,
	WorkspaceProject,
} from "@doist/todoist-api-typescript";

export type Project = PersonalProject | WorkspaceProject;

export default interface TaskObject {
	content: string;
	description?: string;
	projectId?: string;
	sectionId?: string;
	order?: number | null;
	labels?: string[];
	priority?: number | null;
	dueString?: string;
	dueDate?: string | null;
	dueDatetime?: string;
	dueLang?: string;
	assigneeId?: string;
	isCompleted?: boolean;
	todoistId?: string | null;
	parentId: string | null;
	hasParent: boolean;
}

export interface TodoistTaskData {
	projects: Project[];
	tasks: LocalTask[];
	events: ActivityEvent[];
}

export interface FileMetadata {
	todoistTasks: string[];
	todoistCount: number;
	defaultProjectId?: string;
}

export interface ConversionArguments {
	lineContent: string;
	lineNumber: number;
	fileContent: string;
	filePath: string;
}

// Enriched todoist task with obsidianist resources
export type LocalTask = Task & {
	path?: string;
	isCompleted?: boolean;
};
