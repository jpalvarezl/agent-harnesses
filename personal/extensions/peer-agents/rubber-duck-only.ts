import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import peerAgents from "./index.ts";

/**
 * Explicit child-process entry point used by the subagent extension.
 * Global extension discovery stays disabled; workers receive rubber_duck but
 * cannot recursively invoke code_review or subagent.
 */
export default function rubberDuckOnly(pi: ExtensionAPI) {
  peerAgents(pi, { rubberDuckOnly: true });
}
