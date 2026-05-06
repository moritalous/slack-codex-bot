import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
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

type CodexEvent =
	| {
			type: "thread.started";
			thread_id: string;
	  }
	| {
			type: "item.completed";
			item: {
				type: string;
				text?: string;
			};
	  }
	| {
			type: "turn.completed";
	  }
	| {
			type: "turn.failed";
			error: {
				message: string;
			};
	  };

export class CodexSessionRunner {
	constructor(private readonly options: CodexSessionRunnerOptions) {}

	async runNewConversation(
		input: CodexConversationInput,
	): Promise<CodexSessionResult> {
		const workspacePath = await ensureWorkspace(
			this.options.workspacesRoot,
			input.channel,
			input.rootThreadTs,
		);
		const result = await runCodexCli({
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
		const result = await runCodexCli({
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
		const workspacePath = await ensureWorkspace(
			this.options.workspacesRoot,
			input.channel,
			input.rootThreadTs,
		);
		const result = await runCodexCli({
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
}

async function ensureWorkspace(
	workspacesRoot: string,
	channel: string,
	rootThreadTs: string,
): Promise<string> {
	const workspaceName = `${sanitizeForPath(channel)}-${sanitizeForPath(rootThreadTs)}`;
	const workspacePath = path.join(workspacesRoot, workspaceName);

	await mkdir(workspacePath, { recursive: true });

	return workspacePath;
}

function sanitizeForPath(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, "_");
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

async function runCodexCli(options: {
	prompt: string;
	repoRoot: string;
	workingDirectory: string;
	threadId?: string;
}): Promise<{ codexThreadId: string; responseText: string }> {
	const args = [
		"exec",
		"--json",
		"--skip-git-repo-check",
		"--sandbox",
		"workspace-write",
		"--cd",
		options.workingDirectory,
		"--add-dir",
		options.repoRoot,
		"--config",
		'approval_policy="never"',
	] as string[];

	if (options.threadId) {
		args.push("resume", options.threadId);
	}

	const child = spawn("codex", args, {
		stdio: ["pipe", "pipe", "pipe"],
		env: process.env,
	});

	child.stdin.write(options.prompt);
	child.stdin.end();

	if (!child.stdout || !child.stderr) {
		child.kill();
		throw new Error("Failed to access Codex process streams");
	}

	const stderrChunks: Buffer[] = [];
	child.stderr.on("data", (chunk: Buffer) => {
		stderrChunks.push(chunk);
	});

	let codexThreadId: string | null = null;
	let responseText = "";
	let turnFailedMessage: string | null = null;

	const rl = readline.createInterface({
		input: child.stdout,
		crlfDelay: Infinity,
	});

	for await (const line of rl) {
		const event = tryParseCodexEvent(line);
		if (!event) {
			continue;
		}

		if (event.type === "thread.started") {
			codexThreadId = event.thread_id;
			continue;
		}

		if (
			event.type === "item.completed" &&
			event.item.type === "agent_message" &&
			typeof event.item.text === "string"
		) {
			responseText = event.item.text;
			continue;
		}

		if (event.type === "turn.failed") {
			turnFailedMessage = event.error.message;
		}
	}

	const exitCode = await new Promise<number | null>((resolve) => {
		child.once("exit", (code) => resolve(code));
	});

	if (turnFailedMessage) {
		throw new Error(turnFailedMessage);
	}

	if (!codexThreadId) {
		const stderr = Buffer.concat(stderrChunks).toString("utf8");
		throw new Error(
			`Codex did not produce a thread id${stderr ? `: ${stderr}` : ""}`,
		);
	}

	if (exitCode !== 0) {
		const stderr = Buffer.concat(stderrChunks).toString("utf8");
		throw new Error(`Codex exited with code ${exitCode ?? -1}: ${stderr}`);
	}

	return {
		codexThreadId,
		responseText: responseText.trim(),
	};
}

function tryParseCodexEvent(line: string): CodexEvent | null {
	const trimmed = line.trim();
	if (!trimmed.startsWith("{")) {
		return null;
	}

	try {
		return JSON.parse(trimmed) as CodexEvent;
	} catch {
		return null;
	}
}
