import { readdir } from "node:fs/promises";
import path from "node:path";
import type { App, SlackEventMiddlewareArgs } from "@slack/bolt";
import type { MessageEvent } from "@slack/types";
import type { WebClient } from "@slack/web-api";
import {
	type ClaudeConversationInput,
	ClaudeSessionRunner,
} from "./claude-session-runner";
import { repoRoot, threadStateFilePath, workspacesRoot } from "./paths";
import {
	type SlackFile,
	downloadSlackFiles,
	fetchSlackTranscript,
} from "./slack-transcript";
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
	files?: SlackFile[];
};

type BotIdentity = {
	userId: string;
};

const stateStore = new ThreadStateStore(threadStateFilePath);
const claudeRunner = new ClaudeSessionRunner({
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
		files: extractFiles(message),
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
		files: extractFiles(event),
	};
}

function extractFiles(event: object): SlackFile[] | undefined {
	const raw = (event as { files?: unknown[] }).files;
	if (!raw?.length) return undefined;

	const result = (raw as Array<Record<string, unknown>>)
		.filter(
			(f): f is Record<string, unknown> & { id: string; url_private: string } =>
				typeof f.id === "string" && typeof f.url_private === "string",
		)
		.map((f) => ({
			id: f.id,
			name: typeof f.name === "string" ? f.name : null,
			mimetype:
				typeof f.mimetype === "string"
					? f.mimetype
					: "application/octet-stream",
			urlPrivate: f.url_private,
		}));

	return result.length ? result : undefined;
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
		console.error(
			`[slack] Handling conversation: ${context.channel} / ${context.rootThreadTs}`,
		);

		const placeholder = await client.chat.postMessage({
			channel: context.channel,
			thread_ts: context.rootThreadTs,
			text: placeholderText,
		});
		if (typeof placeholder.ts !== "string") {
			throw new Error("Slack placeholder message ts was missing");
		}
		placeholderTs = placeholder.ts;
		console.error(`[slack] Placeholder posted: ${placeholderTs}`);

		const claudeInput = await buildClaudeInput(context);

		console.error(`[slack] Calling resolveClaudeResponse...`);
		const result = await resolveClaudeResponse(
			client,
			botIdentity,
			conversationKey,
			claudeInput,
		);
		console.error(
			`[slack] Got response: ${result.responseText.substring(0, 100)}...`,
		);

		await client.chat.update({
			channel: context.channel,
			ts: placeholderTs,
			text:
				result.responseText || "空の応答は返せないため、回答を省略しました。",
		});
		console.error(`[slack] Response posted`);

		if (claudeInput.outputDir) {
			await sendOutputFiles(
				client,
				context.channel,
				context.rootThreadTs,
				claudeInput.outputDir,
			);
		}
	} catch (error) {
		console.error(`[slack] Error:`, error);
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

async function buildClaudeInput(
	context: ConversationContext,
): Promise<ClaudeConversationInput> {
	const base: ClaudeConversationInput = {
		channel: context.channel,
		rootThreadTs: context.rootThreadTs,
		messageTs: context.messageTs,
		userId: context.userId,
		text: context.text,
	};

	if (!context.files?.length) {
		return base;
	}

	const token = process.env.SLACK_BOT_TOKEN;
	if (!token) {
		console.error("[slack] SLACK_BOT_TOKEN not set; skipping file download");
		return base;
	}

	const baseDir = path.join(workspacesRoot, context.messageTs);
	const inputDir = path.join(baseDir, "input");
	const outputDir = path.join(baseDir, "output");

	const [attachmentFiles] = await Promise.all([
		downloadSlackFiles(context.files, inputDir, token),
		import("node:fs/promises").then((fs) =>
			fs.mkdir(outputDir, { recursive: true }),
		),
	]);

	return attachmentFiles.length
		? { ...base, inputDir, outputDir, attachmentFiles }
		: base;
}

async function sendOutputFiles(
	client: WebClient,
	channel: string,
	threadTs: string,
	outputDir: string,
): Promise<void> {
	let filenames: string[];
	try {
		filenames = await readdir(outputDir);
	} catch {
		return;
	}

	if (!filenames.length) return;

	console.error(`[slack] Uploading ${filenames.length} output file(s)`);

	for (const filename of filenames) {
		const filePath = path.join(outputDir, filename);
		try {
			await client.filesUploadV2({
				channel_id: channel,
				thread_ts: threadTs,
				file: filePath,
				filename,
			});
			console.error(`[slack] Uploaded: ${filename}`);
		} catch (err) {
			console.error(`[slack] Failed to upload ${filename}:`, err);
		}
	}
}

async function resolveClaudeResponse(
	client: WebClient,
	botIdentity: BotIdentity,
	conversationKey: string,
	context: ClaudeConversationInput,
) {
	const storedState = await stateStore.get(conversationKey);

	if (!storedState) {
		if (context.rootThreadTs !== context.messageTs) {
			return await rebuildFromSlackTranscript(
				client,
				botIdentity,
				conversationKey,
				context,
			);
		}

		const result = await claudeRunner.runNewConversation(context);
		await persistState(
			conversationKey,
			result.claudeSessionId,
			result.workspacePath,
			context,
		);

		return result;
	}

	try {
		const result = await claudeRunner.runExistingConversation(
			storedState.claudeSessionId,
			storedState.workspacePath,
			context,
		);
		await persistState(
			conversationKey,
			result.claudeSessionId,
			result.workspacePath,
			context,
		);

		return result;
	} catch {
		return await rebuildFromSlackTranscript(
			client,
			botIdentity,
			conversationKey,
			context,
		);
	}
}

async function rebuildFromSlackTranscript(
	client: WebClient,
	botIdentity: BotIdentity,
	conversationKey: string,
	input: ClaudeConversationInput,
) {
	const transcript = await fetchSlackTranscript(
		client,
		input.channel,
		input.rootThreadTs,
		botIdentity.userId,
	);
	const result = await claudeRunner.rebuildConversationFromTranscript(
		input,
		transcript,
	);
	await persistState(
		conversationKey,
		result.claudeSessionId,
		result.workspacePath,
		input,
	);

	return result;
}

async function persistState(
	conversationKey: string,
	claudeSessionId: string,
	workspacePath: string,
	context: Pick<ClaudeConversationInput, "channel" | "rootThreadTs">,
): Promise<void> {
	const now = new Date().toISOString();
	const existing = await stateStore.get(conversationKey);

	await stateStore.set(conversationKey, {
		channel: context.channel,
		rootThreadTs: context.rootThreadTs,
		claudeSessionId,
		workspacePath,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
	});
}

function getConversationKey(channel: string, rootThreadTs: string): string {
	return `${channel}:${rootThreadTs}`;
}
