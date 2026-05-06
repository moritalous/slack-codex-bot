import { App } from "@slack/bolt";
import { registerSlackBot } from "./slack-bot";

const app = new App({
	token: process.env.BOT_TOKEN,
	socketMode: true,
	appToken: process.env.APP_TOKEN,
});

await registerSlackBot(app);
await app.start();
app.logger.info("Bolt app started");
