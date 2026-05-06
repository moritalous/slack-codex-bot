---
name: "slack-message"
description: "Send messages to Slack channels. Use when you need to post a message to a specific Slack channel."
---

# Slack Message Sender

Send messages to Slack channels using the Slack API.

## Requirements

- `BOT_TOKEN` environment variable must be set
- Channel ID (e.g., C12345678) or channel name

## Usage

### Send a message to a channel

```bash
mise exec -- bun .agents/skills/slack-message/scripts/send-message.ts --channel <CHANNEL_ID> --text <MESSAGE_TEXT>
```

### Examples

Send to a channel ID:
```bash
mise exec -- bun .agents/skills/slack-message/scripts/send-message.ts --channel C12345678 --text "Hello from Codex!"
```

Send to a channel name (will be converted to ID):
```bash
mise exec -- bun .agents/skills/slack-message/scripts/send-message.ts --channel general --text "Good morning!"
```

Send with thread reply:
```bash
mise exec -- bun .agents/skills/slack-message/scripts/send-message.ts --channel C12345678 --text "Reply in thread" --thread-ts 1234567890.123456
```

Send with mentions:
```bash
mise exec -- bun .agents/skills/slack-message/scripts/send-message.ts --channel C12345678 --text "Hey <@U12345678>!"
```

## Parameters

- `--channel` (required): Slack channel ID or name
- `--text` (required): Message text to send
- `--thread-ts` (optional): Thread timestamp for replies
- `--blocks` (optional): JSON blocks for rich formatting

## Error Handling

- If `BOT_TOKEN` is not set, the script will exit with an error message
- If the channel is invalid, Slack API will return an error
- Check the error message for details and retry with valid parameters
