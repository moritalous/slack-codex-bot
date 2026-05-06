import { App } from "@slack/bolt";

const app = new App({
	token: process.env.BOT_TOKEN,
	socketMode: true,
	appToken: process.env.APP_TOKEN,
});

await app.start();
app.logger.info("Bolt app started");
