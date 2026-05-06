import type { WebClient } from "@slack/web-api";

export type SlackTranscriptMessage = {
	ts: string;
	threadTs: string;
	userId: string | null;
	role: "user" | "assistant";
	text: string;
};

type SlackMessage = {
	ts?: string;
	thread_ts?: string;
	text?: string;
	user?: string;
	bot_id?: string;
	subtype?: string;
};

export async function fetchSlackTranscript(
	client: WebClient,
	channel: string,
	rootThreadTs: string,
	botUserId: string,
): Promise<SlackTranscriptMessage[]> {
	const messages: SlackMessage[] = [];
	let cursor: string | undefined;

	do {
		const response = await client.conversations.replies({
			channel,
			ts: rootThreadTs,
			cursor,
			limit: 200,
		});

		for (const message of response.messages ?? []) {
			messages.push(message as SlackMessage);
		}

		cursor = response.response_metadata?.next_cursor || undefined;
	} while (cursor);

	return messages
		.filter((message) => {
			if (!message.ts || !message.text) {
				return false;
			}

			if (
				message.subtype === "message_changed" ||
				message.subtype === "message_deleted"
			) {
				return false;
			}

			return true;
		})
		.sort((left, right) => Number(left.ts) - Number(right.ts))
		.map((message) => ({
			ts: message.ts ?? "",
			threadTs: message.thread_ts ?? message.ts ?? "",
			userId: message.user ?? null,
			role: message.user === botUserId || message.bot_id ? "assistant" : "user",
			text: message.text ?? "",
		}));
}

export function formatTranscript(messages: SlackTranscriptMessage[]): string {
	return messages
		.map((message, index) => {
			const speaker = message.role === "assistant" ? "assistant" : "user";
			const userSuffix = message.userId ? ` (${message.userId})` : "";

			return `${index + 1}. ${speaker}${userSuffix} [ts=${message.ts}]\n${message.text}`;
		})
		.join("\n\n");
}
