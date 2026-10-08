import { fileURLToPath } from "node:url";

// Executable resources belong to the package; user data belongs to getAgentDir().
export const runtimeRoot = fileURLToPath(new URL("..", import.meta.url));
export const PACKAGE_DIRECTORY = "packages/pi-agent-config";
