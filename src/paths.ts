import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(__dirname, "..");
export const workspacesRoot = path.join(repoRoot, "workspaces");
export const localStateRoot = path.join(repoRoot, ".local", "state");
export const threadStateFilePath = path.join(
	localStateRoot,
	"slack-claude-threads.json",
);
