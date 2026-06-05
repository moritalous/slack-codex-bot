import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { repoRoot } from "./paths";
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
	claudeSessionId: string;
	workspacePath: string;
};

type CodexSessionRunnerOptions = {
	repoRoot: string;
	workspacesRoot: string;
};

const claudeBin = path.join(repoRoot, "node_modules", ".bin", "claude");

export class CodexSessionRunner {
	constructor(private readonly options: CodexSessionRunnerOptions) {}

	async runNewConversation(
		input: CodexConversationInput,
	): Promise<CodexSessionResult> {
		const workspacePath = await ensureWorkspace(this.options.workspacesRoot);
		const result = await this.runClaudeSdk({
			prompt: buildTurnPrompt(input),
			workingDirectory: workspacePath,
		});

		return {
			responseText: result.responseText,
			claudeSessionId: result.claudeSessionId,
			workspacePath,
		};
	}

	async runExistingConversation(
		sessionId: string,
		workspacePath: string,
		input: CodexConversationInput,
	): Promise<CodexSessionResult> {
		const result = await this.runClaudeSdk({
			prompt: buildTurnPrompt(input),
			workingDirectory: workspacePath,
			sessionId,
		});

		return {
			responseText: result.responseText,
			claudeSessionId: result.claudeSessionId,
			workspacePath,
		};
	}

	async rebuildConversationFromTranscript(
		input: CodexConversationInput,
		transcript: SlackTranscriptMessage[],
	): Promise<CodexSessionResult> {
		const workspacePath = await ensureWorkspace(this.options.workspacesRoot);
		const result = await this.runClaudeSdk({
			prompt: buildHydrationPrompt(input, transcript),
			workingDirectory: workspacePath,
		});

		return {
			responseText: result.responseText,
			claudeSessionId: result.claudeSessionId,
			workspacePath,
		};
	}

	private runClaudeSdk(options: {
		prompt: string;
		workingDirectory: string;
		sessionId?: string;
	}): Promise<{ claudeSessionId: string; responseText: string }> {
		console.error(
			`[claude] ${options.sessionId ? "Resuming" : "Starting"} session in ${options.workingDirectory}`,
		);

		const args = [
			"--print",
			"--output-format",
			"stream-json",
			"--dangerously-skip-permissions",
			"--input-format",
			"text",
		];

		if (options.sessionId) {
			args.push("--resume", options.sessionId);
		}

		return new Promise((resolve, reject) => {
			const proc = spawn(claudeBin, args, {
				cwd: options.workingDirectory,
				env: process.env,
			});

			proc.stdin.write(options.prompt);
			proc.stdin.end();

			let buffer = "";
			let claudeSessionId = "";
			let responseText = "";
			let rejected = false;

			proc.stdout.on("data", (chunk: Buffer) => {
				buffer += chunk.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";

				for (const line of lines) {
					if (!line.trim()) continue;
					let msg: Record<string, unknown>;
					try {
						msg = JSON.parse(line) as Record<string, unknown>;
					} catch {
						continue;
					}

					console.error(`[claude] Message: ${msg.type}`);

					if (msg.type === "system" && msg.subtype === "init") {
						claudeSessionId = msg.session_id as string;
						console.error(`[claude] Session ID: ${claudeSessionId}`);
					}

					if (msg.type === "assistant") {
						const message = msg.message as {
							content: Array<{ type: string; text?: string }>;
						};
						for (const block of message.content) {
							if (block.type === "text" && block.text) {
								responseText = block.text;
							}
						}
					}

					if (msg.type === "result") {
						if (msg.subtype !== "success") {
							rejected = true;
							reject(
								new Error(`Claude session ended with error: ${msg.subtype}`),
							);
							return;
						}
						if (msg.result) {
							responseText = msg.result as string;
						}
					}
				}
			});

			proc.stderr.on("data", (chunk: Buffer) => {
				console.error(`[claude stderr] ${chunk.toString().trimEnd()}`);
			});

			proc.on("error", (err) => {
				if (!rejected) {
					rejected = true;
					reject(err);
				}
			});

			proc.on("close", (code) => {
				if (rejected) return;

				if (code !== 0) {
					reject(new Error(`Claude process exited with code ${code}`));
					return;
				}

				if (!claudeSessionId) {
					reject(new Error("Claude did not produce a session id"));
					return;
				}

				console.error(`[claude] Response length: ${responseText.trim().length}`);
				resolve({ claudeSessionId, responseText: responseText.trim() });
			});
		});
	}
}

async function ensureWorkspace(workspacesRoot: string): Promise<string> {
	await mkdir(workspacesRoot, { recursive: true });
	return workspacesRoot;
}

function buildTurnPrompt(input: CodexConversationInput): string {
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
