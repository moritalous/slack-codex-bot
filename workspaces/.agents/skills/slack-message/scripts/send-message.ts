import { WebClient } from "@slack/web-api";

const botToken = process.env.BOT_TOKEN;

if (!botToken) {
	console.error("Error: BOT_TOKEN environment variable is not set");
	process.exit(1);
}

const client = new WebClient(botToken);

interface SendMessageOptions {
	channel: string;
	text: string;
	threadTs?: string;
	blocks?: unknown[];
}

async function sendMessage(options: SendMessageOptions): Promise<void> {
	const { channel, text, threadTs, blocks } = options;

	try {
		const result = await client.chat.postMessage({
			channel,
			text,
			thread_ts: threadTs,
			blocks,
		});

		console.log(`Message sent successfully to ${channel}`);
		console.log(`Timestamp: ${result.ts}`);
	} catch (error) {
		if (error instanceof Error) {
			console.error(`Error sending message: ${error.message}`);
		} else {
			console.error("Unknown error occurred");
		}
		process.exit(1);
	}
}

// Parse command line arguments
function parseArgs(): SendMessageOptions {
	const args = process.argv.slice(2);
	const options: SendMessageOptions = {
		channel: "",
		text: "",
	};

	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case "--channel":
				options.channel = args[i + 1];
				i++;
				break;
			case "--text":
				options.text = args[i + 1];
				i++;
				break;
			case "--thread-ts":
				options.threadTs = args[i + 1];
				i++;
				break;
			case "--blocks":
				try {
					options.blocks = JSON.parse(args[i + 1]);
				} catch {
					console.error("Error parsing --blocks JSON");
					process.exit(1);
				}
				i++;
				break;
		}
	}

	if (!options.channel || !options.text) {
		console.error(
			"Error: --channel and --text are required arguments\n" +
				"Usage: bun send-message.ts --channel <CHANNEL> --text <TEXT>",
		);
		process.exit(1);
	}

	return options;
}

const options = parseArgs();
console.error(
	`[skill:slack-message] channel=${options.channel} text="${options.text}"`,
);
await sendMessage(options);
