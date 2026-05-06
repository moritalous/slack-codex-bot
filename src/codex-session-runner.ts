import { mkdir } from "node:fs/promises";
import { Codex } from "@openai/codex-sdk";
import codexConfig from "../.codex/config.toml";
import {
	formatTranscript,
	type SlackTranscriptMessage,
} from "./slack-transcript";

export type CodexConversationInput = {
	channel: string;
	rootThreadTs: string;
	messageTs: string;
	userId: string;
	text: string;
};

export type CodexSessionResult = {
	responseText: string;
	codexThreadId: string;
	workspacePath: string;
};

type CodexSessionRunnerOptions = {
	repoRoot: string;
	workspacesRoot: string;
};

export class CodexSessionRunner {
	private readonly codex: Codex;

	constructor(private readonly options: CodexSessionRunnerOptions) {
		this.codex = new Codex({
			env: process.env as Record<string, string>,
			config: codexConfig,
		});
	}

	async runNewConversation(
		input: CodexConversationInput,
	): Promise<CodexSessionResult> {
		const workspacePath = await ensureWorkspace(this.options.workspacesRoot);
		const result = await this.runCodexSdk({
			prompt: buildTurnPrompt(input),
			repoRoot: this.options.repoRoot,
			workingDirectory: workspacePath,
		});

		return {
			responseText: result.responseText,
			codexThreadId: result.codexThreadId,
			workspacePath,
		};
	}

	async runExistingConversation(
		threadId: string,
		workspacePath: string,
		input: CodexConversationInput,
	): Promise<CodexSessionResult> {
		const result = await this.runCodexSdk({
			prompt: buildTurnPrompt(input),
			repoRoot: this.options.repoRoot,
			workingDirectory: workspacePath,
			threadId,
		});

		return {
			responseText: result.responseText,
			codexThreadId: result.codexThreadId,
			workspacePath,
		};
	}

	async rebuildConversationFromTranscript(
		input: CodexConversationInput,
		transcript: SlackTranscriptMessage[],
	): Promise<CodexSessionResult> {
		const workspacePath = await ensureWorkspace(this.options.workspacesRoot);
		const result = await this.runCodexSdk({
			prompt: buildHydrationPrompt(input, transcript),
			repoRoot: this.options.repoRoot,
			workingDirectory: workspacePath,
		});

		return {
			responseText: result.responseText,
			codexThreadId: result.codexThreadId,
			workspacePath,
		};
	}

	private async runCodexSdk(options: {
		prompt: string;
		repoRoot: string;
		workingDirectory: string;
		threadId?: string;
	}): Promise<{ codexThreadId: string; responseText: string }> {
		const threadOptions = {
			workingDirectory: options.workingDirectory,
			skipGitRepoCheck: true,
			sandboxMode: "danger-full-access" as const,
			approvalPolicy: "never" as const,
		};

		console.error(
			`[codex] ${options.threadId ? "Resuming" : "Starting"} thread in ${options.workingDirectory}`,
		);

		const thread = options.threadId
			? this.codex.resumeThread(options.threadId, threadOptions)
			: this.codex.startThread(threadOptions);

		console.error(`[codex] Running prompt...`);
		const { events } = await thread.runStreamed(options.prompt);

		let responseText = "";
		let turnFailedMessage: string | null = null;

		for await (const event of events) {
			console.error(`[codex] Event: ${event.type}`);

			if (event.type === "turn.failed") {
				turnFailedMessage = event.error.message;
				console.error(`[codex] Turn failed: ${turnFailedMessage}`);
			}
			if (
				event.type === "item.completed" &&
				event.item.type === "agent_message" &&
				"text" in event.item
			) {
				responseText = event.item.text;
				console.error(
					`[codex] Got response: ${responseText.substring(0, 100)}...`,
				);
			}
		}

		if (turnFailedMessage) {
			throw new Error(turnFailedMessage);
		}

		const codexThreadId = thread.id;
		if (!codexThreadId) {
			throw new Error("Codex did not produce a thread id");
		}

		console.error(`[codex] Thread ID: ${codexThreadId}`);
		console.error(`[codex] Response length: ${responseText.length}`);

		return { codexThreadId, responseText: responseText.trim() };
	}
}

async function ensureWorkspace(workspacesRoot: string): Promise<string> {
	await mkdir(workspacesRoot, { recursive: true });
	return workspacesRoot;
}

function buildTurnPrompt(input: CodexConversationInput): string {
	return [
		"You are a Slack assistant replying inside an existing Slack thread.",
		"Use the prior Codex conversation context when available.",
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
	input: CodexConversationInput,
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
