import { App } from "@slack/bolt";
import type { GenericMessageEvent } from "@slack/types";

const app = new App({
	token: process.env.BOT_TOKEN,
	socketMode: true,
	appToken: process.env.APP_TOKEN,
});

app.message(async ({ message, say }) => {
	if (message.channel_type !== "im") {
		return;
	}

	if ("subtype" in message && message.subtype !== undefined) {
		return;
	}

	const dmMessage = message as GenericMessageEvent;
	const { text } = dmMessage;

	if (typeof text !== "string" || text.length === 0) {
		return;
	}

	await say(text);
});

app.event("app_mention", async ({ event, say }) => {
	const text = event.text.replace(/<@[^>]+>/, "").trim();

	await say(text || event.text);
});

await app.start();
app.logger.info("Bolt app started");
