import { mkdir } from "node:fs/promises";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources";
import type { SlackTranscriptMessage } from "./slack-transcript";

export type ClaudeConversationInput = {
	channel: string;
	rootThreadTs: string;
	messageTs: string;
	userId: string;
	text: string;
	inputDir?: string;
	outputDir: string;
	attachmentFiles?: string[];
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

const SYSTEM_PROMPT = [
	"You are a Slack assistant replying inside a Slack thread.",
	"Reply with only the message body to be posted back to Slack.",
	"When the user provides an output directory path, save any files you want to return there instead of displaying their contents inline.",
].join("\n");

export class ClaudeSessionRunner {
	constructor(private readonly options: ClaudeSessionRunnerOptions) {}

	async runNewConversation(
		input: ClaudeConversationInput,
	): Promise<ClaudeSessionResult> {
		const workspacePath = await ensureWorkspace(this.options.workspacesRoot);
		const result = await runQuery({
			prompt: singleTurnMessages(input),
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
			prompt: singleTurnMessages(input),
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
			prompt: transcriptMessages(input, transcript),
			workspacePath,
		});
		return { ...result, workspacePath };
	}
}

async function runQuery(options: {
	prompt: AsyncIterable<SDKUserMessage>;
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
			systemPrompt: {
				type: "preset",
				preset: "claude_code",
				append: SYSTEM_PROMPT,
			},
			tools: { type: "preset", preset: "claude_code" },
			...(options.sessionId ? { resume: options.sessionId } : {}),
		},
	})) {
		let msgInfo: string = message.type;
		if ("subtype" in message) {
			msgInfo = `${message.type}(${message.subtype})`;
			if (message.type === "system" && message.subtype === "thinking_tokens") {
				msgInfo += ` tokens=${message.estimated_tokens}`;
			}
		}
		if (message.type === "result") {
			msgInfo += ` duration=${message.duration_ms}ms`;
		}
		console.error(`[claude] Message: ${msgInfo}`);

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

// For new conversations and session resumes: yields a single user message.
async function* singleTurnMessages(
	input: ClaudeConversationInput,
): AsyncGenerator<SDKUserMessage> {
	yield {
		type: "user",
		message: buildUserMessageParam(input),
		parent_tool_use_id: null,
	};
}

// For transcript rebuilds: injects conversation history then the current message.
async function* transcriptMessages(
	input: ClaudeConversationInput,
	transcript: SlackTranscriptMessage[],
): AsyncGenerator<SDKUserMessage> {
	let firstUserEmitted = false;
	let latestFound = false;

	for (const msg of transcript) {
		const isLatest = msg.ts === input.messageTs;

		if (msg.role === "assistant") {
			// Anthropic API requires a user message before any assistant message.
			if (!firstUserEmitted) {
				yield historyMessage({
					role: "user",
					content: "(beginning of conversation)",
				});
				firstUserEmitted = true;
			}
			yield historyMessage({
				role: "assistant",
				content: [{ type: "text", text: msg.text }],
			});
		} else {
			firstUserEmitted = true;
			if (isLatest) {
				latestFound = true;
				yield {
					type: "user",
					message: buildUserMessageParam(input),
					parent_tool_use_id: null,
				};
			} else {
				yield historyMessage({
					role: "user",
					content: [{ type: "text", text: msg.text }],
				});
			}
		}
	}

	// Fallback: current message was not found in transcript.
	if (!latestFound) {
		if (!firstUserEmitted) {
			yield historyMessage({
				role: "user",
				content: "(beginning of conversation)",
			});
		}
		yield {
			type: "user",
			message: buildUserMessageParam(input),
			parent_tool_use_id: null,
		};
	}
}

function historyMessage(message: MessageParam): SDKUserMessage {
	return {
		type: "user",
		message,
		parent_tool_use_id: null,
		isSynthetic: true,
		shouldQuery: false,
	};
}

function buildUserMessageParam(input: ClaudeConversationInput): MessageParam {
	const blocks: Array<{ type: "text"; text: string }> = [
		{
			type: "text",
			text: [
				"source=slack",
				`channel=${input.channel}`,
				`thread_ts=${input.rootThreadTs}`,
				`message_ts=${input.messageTs}`,
				`user_id=${input.userId}`,
			].join("\n"),
		},
		{
			type: "text",
			text: input.text,
		},
	];

	if (input.inputDir && input.attachmentFiles?.length) {
		blocks.push({
			type: "text",
			text: [
				`Input files are in: ${input.inputDir}`,
				...input.attachmentFiles.map((f) => `- ${f}`),
			].join("\n"),
		});
	}

	if (input.outputDir) {
		blocks.push({
			type: "text",
			text: `Output directory (save files here to send them back via Slack): ${input.outputDir}`,
		});
	}

	return { role: "user", content: blocks };
}

async function ensureWorkspace(workspacesRoot: string): Promise<string> {
	await mkdir(workspacesRoot, { recursive: true });
	return workspacesRoot;
}
