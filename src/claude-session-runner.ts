import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdir } from "node:fs/promises";
import {
	formatTranscript,
	type SlackTranscriptMessage,
} from "./slack-transcript";

export type ClaudeConversationInput = {
	channel: string;
	rootThreadTs: string;
	messageTs: string;
	userId: string;
	text: string;
};

export type ClaudeSessionResult = {
	responseText: string;
	claudeSessionId: string;
	workspacePath: string;
};

type ClaudeSessionRunnerOptions = {
	repoRoot: string;
	workspacesRoot: string;
};

export class ClaudeSessionRunner {
	constructor(private readonly options: ClaudeSessionRunnerOptions) {}

	async runNewConversation(
		input: ClaudeConversationInput,
	): Promise<ClaudeSessionResult> {
		const workspacePath = await ensureWorkspace(this.options.workspacesRoot);
		const result = await runQuery({
			prompt: buildTurnPrompt(input),
			workspacePath,
		});

		return { ...result, workspacePath };
	}

	async runExistingConversation(
		sessionId: string,
		workspacePath: string,
		input: ClaudeConversationInput,
	): Promise<ClaudeSessionResult> {
		const result = await runQuery({
			prompt: buildTurnPrompt(input),
			workspacePath,
			sessionId,
		});

		return { ...result, workspacePath };
	}

	async rebuildConversationFromTranscript(
		input: ClaudeConversationInput,
		transcript: SlackTranscriptMessage[],
	): Promise<ClaudeSessionResult> {
		const workspacePath = await ensureWorkspace(this.options.workspacesRoot);
		const result = await runQuery({
			prompt: buildHydrationPrompt(input, transcript),
			workspacePath,
		});

		return { ...result, workspacePath };
	}
}

async function runQuery(options: {
	prompt: string;
	workspacePath: string;
	sessionId?: string;
}): Promise<{ claudeSessionId: string; responseText: string }> {
	console.error(
		`[claude] ${options.sessionId ? "Resuming" : "Starting"} session in ${options.workspacePath}`,
	);

	let claudeSessionId = "";
	let responseText = "";

	for await (const message of query({
		prompt: options.prompt,
		options: {
			cwd: options.workspacePath,
			permissionMode: "bypassPermissions",
			...(options.sessionId ? { resume: options.sessionId } : {}),
		},
	})) {
		console.error(`[claude] Message: ${message.type}`);

		if (message.type === "system" && message.subtype === "init") {
			claudeSessionId = message.session_id;
			console.error(`[claude] Session ID: ${claudeSessionId}`);
		}

		if (message.type === "result") {
			claudeSessionId = message.session_id;
			if (message.subtype === "success") {
				responseText = message.result;
			} else {
				throw new Error(
					`Claude session ended with error: ${message.subtype} — ${("errors" in message ? message.errors : []).join(", ")}`,
				);
			}
		}
	}

	if (!claudeSessionId) {
		throw new Error("Claude did not produce a session id");
	}

	console.error(`[claude] Response length: ${responseText.trim().length}`);
	return { claudeSessionId, responseText: responseText.trim() };
}

async function ensureWorkspace(workspacesRoot: string): Promise<string> {
	await mkdir(workspacesRoot, { recursive: true });
	return workspacesRoot;
}

function buildTurnPrompt(input: ClaudeConversationInput): string {
	return [
		"You are a Slack assistant replying inside an existing Slack thread.",
		"Use the prior conversation context when available.",
		"Reply with only the message body that should be posted back to Slack.",
		"",
		"source=slack",
		`channel=${input.channel}`,
		`root_thread_ts=${input.rootThreadTs}`,
		`message_ts=${input.messageTs}`,
		`user_id=${input.userId}`,
		"",
		"Latest user message:",
		input.text,
	].join("\n");
}

function buildHydrationPrompt(
	input: ClaudeConversationInput,
	transcript: SlackTranscriptMessage[],
): string {
	const formattedTranscript = formatTranscript(transcript);

	return [
		"You are restoring context for a Slack assistant conversation.",
		"Read the full Slack thread transcript below and answer the latest user message.",
		"Reply with only the message body that should be posted back to Slack.",
		"",
		"source=slack",
		`channel=${input.channel}`,
		`root_thread_ts=${input.rootThreadTs}`,
		`message_ts=${input.messageTs}`,
		`user_id=${input.userId}`,
		"",
		"Slack thread transcript:",
		formattedTranscript,
	].join("\n");
}
