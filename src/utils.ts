import { ActivityEvent } from "@doist/todoist-api-typescript";

type FilterArgs = {
	eventType?: string;
	objectType?: string;
};

export function filterActivityEvents(
	events: ActivityEvent[],
	args: FilterArgs,
): ActivityEvent[] {
	return events.filter(
		(event: ActivityEvent): boolean =>
			(args.eventType ? event.eventType === args.eventType : true) &&
			(args.objectType ? event.objectType === args.objectType : true),
	);
}

export function localDateStringToUTCDatetimeString(localDateString: string) {
	try {
		if (localDateString === null) {
			return null;
		}
		localDateString = localDateString + "T08:00";
		const localDateObj = new Date(localDateString);
		return localDateObj.toISOString();
	} catch (error) {
		console.error(
			`Error extracting date from string '${localDateString}': ${error}`,
		);
		return null;
	}
}
