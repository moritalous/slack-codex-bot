import type { App, SlackEventMiddlewareArgs } from "@slack/bolt";
import type { MessageEvent } from "@slack/types";
import type { WebClient } from "@slack/web-api";
import {
	type CodexConversationInput,
	CodexSessionRunner,
} from "./codex-session-runner";
import { repoRoot, threadStateFilePath, workspacesRoot } from "./paths";
import { fetchSlackTranscript } from "./slack-transcript";
import { ThreadStateStore } from "./thread-state-store";

const placeholderText = "考え中です...";
const failureText =
	"応答の生成に失敗しました。少し待ってからもう一度試してください。";

type AppMentionEvent = SlackEventMiddlewareArgs<"app_mention">["event"];

type ConversationContext = {
	channel: string;
	rootThreadTs: string;
	messageTs: string;
	userId: string;
	text: string;
};

type BotIdentity = {
	userId: string;
};

const stateStore = new ThreadStateStore(threadStateFilePath);
const codexRunner = new CodexSessionRunner({
	repoRoot,
	workspacesRoot,
});

export async function registerSlackBot(app: App): Promise<void> {
	const botIdentity = await fetchBotIdentity(app.client);

	app.message(async ({ message, client }) => {
		const context = getDmContext(message);
		if (!context) {
			return;
		}

		await handleConversation(app, client, botIdentity, context);
	});

	app.event("app_mention", async ({ event, client }) => {
		const context = getMentionContext(event);
		if (!context) {
			return;
		}

		await handleConversation(app, client, botIdentity, context);
	});
}

async function fetchBotIdentity(client: WebClient): Promise<BotIdentity> {
	const auth = await client.auth.test();

	if (!auth.user_id) {
		throw new Error("Unable to determine Slack bot user ID");
	}

	return {
		userId: auth.user_id,
	};
}

function getDmContext(message: MessageEvent): ConversationContext | null {
	if (message.channel_type !== "im") {
		return null;
	}

	if (message.subtype !== undefined) {
		return null;
	}

	if (
		typeof message.text !== "string" ||
		message.text.trim().length === 0 ||
		typeof message.user !== "string"
	) {
		return null;
	}

	return {
		channel: message.channel,
		rootThreadTs: message.thread_ts ?? message.ts,
		messageTs: message.ts,
		userId: message.user,
		text: message.text.trim(),
	};
}

function getMentionContext(event: AppMentionEvent): ConversationContext | null {
	const sanitizedText = event.text.replace(/<@[^>]+>/g, "").trim();
	if (sanitizedText.length === 0 || typeof event.user !== "string") {
		return null;
	}

	return {
		channel: event.channel,
		rootThreadTs: event.thread_ts ?? event.ts,
		messageTs: event.ts,
		userId: event.user,
		text: sanitizedText,
	};
}

async function handleConversation(
	app: App,
	client: WebClient,
	botIdentity: BotIdentity,
	context: ConversationContext,
): Promise<void> {
	const conversationKey = getConversationKey(
		context.channel,
		context.rootThreadTs,
	);

	let placeholderTs: string | undefined;

	try {
		const placeholder = await client.chat.postMessage({
			channel: context.channel,
			thread_ts: context.rootThreadTs,
			text: placeholderText,
		});
		if (typeof placeholder.ts !== "string") {
			throw new Error("Slack placeholder message ts was missing");
		}
		placeholderTs = placeholder.ts;

		const result = await resolveCodexResponse(
			client,
			botIdentity,
			conversationKey,
			context,
		);

		await client.chat.update({
			channel: context.channel,
			ts: placeholderTs,
			text:
				result.responseText || "空の応答は返せないため、回答を省略しました。",
		});
	} catch (error) {
		app.logger.error("Failed to handle Slack conversation", error);

		if (placeholderTs) {
			await client.chat
				.update({
					channel: context.channel,
					ts: placeholderTs,
					text: failureText,
				})
				.catch((updateError: unknown) => {
					app.logger.error(
						"Failed to update Slack placeholder message",
						updateError,
					);
				});
			return;
		}

		await client.chat
			.postMessage({
				channel: context.channel,
				thread_ts: context.rootThreadTs,
				text: failureText,
			})
			.catch((postError: unknown) => {
				app.logger.error("Failed to post Slack failure message", postError);
			});
	}
}

async function resolveCodexResponse(
	client: WebClient,
	botIdentity: BotIdentity,
	conversationKey: string,
	context: ConversationContext,
) {
	const storedState = await stateStore.get(conversationKey);
	const codexInput: CodexConversationInput = {
		channel: context.channel,
		rootThreadTs: context.rootThreadTs,
		messageTs: context.messageTs,
		userId: context.userId,
		text: context.text,
	};

	if (!storedState) {
		if (context.rootThreadTs !== context.messageTs) {
			return await rebuildFromSlackTranscript(
				client,
				botIdentity,
				conversationKey,
				codexInput,
			);
		}

		const result = await codexRunner.runNewConversation(codexInput);
		await persistState(
			conversationKey,
			result.codexThreadId,
			result.workspacePath,
			context,
		);

		return result;
	}

	try {
		const result = await codexRunner.runExistingConversation(
			storedState.codexThreadId,
			storedState.workspacePath,
			codexInput,
		);
		await persistState(
			conversationKey,
			result.codexThreadId,
			result.workspacePath,
			context,
		);

		return result;
	} catch {
		return await rebuildFromSlackTranscript(
			client,
			botIdentity,
			conversationKey,
			codexInput,
		);
	}
}

async function rebuildFromSlackTranscript(
	client: WebClient,
	botIdentity: BotIdentity,
	conversationKey: string,
	input: CodexConversationInput,
) {
	const transcript = await fetchSlackTranscript(
		client,
		input.channel,
		input.rootThreadTs,
		botIdentity.userId,
	);
	const result = await codexRunner.rebuildConversationFromTranscript(
		input,
		transcript,
	);
	await persistState(
		conversationKey,
		result.codexThreadId,
		result.workspacePath,
		input,
	);

	return result;
}

async function persistState(
	conversationKey: string,
	codexThreadId: string,
	workspacePath: string,
	context: Pick<ConversationContext, "channel" | "rootThreadTs">,
): Promise<void> {
	const now = new Date().toISOString();
	const existing = await stateStore.get(conversationKey);

	await stateStore.set(conversationKey, {
		channel: context.channel,
		rootThreadTs: context.rootThreadTs,
		codexThreadId,
		workspacePath,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
	});
}

function getConversationKey(channel: string, rootThreadTs: string): string {
	return `${channel}:${rootThreadTs}`;
}
