/**
 * Broadcast system for cross-session notifications.
 *
 * Uses a shared `.pi/broadcasts/` directory. Each event is a JSON file
 * with a timestamp-based name. Sessions poll via fs.watch for new events.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import crypto from "node:crypto";

const BROADCAST_DIR = ".pi/broadcasts";
const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const MAX_EVENTS = 100;

export interface BroadcastEvent {
	type: "todo:claimed" | "todo:completed" | "agent:started" | "agent:finished" | "merge:conflict" | "merge:success" | "dispatch:started" | "dispatch:complete" | "message";
	sessionId: string;
	sessionName?: string;
	todoId?: string;
	todoTitle?: string;
	message?: string;
	timestamp: string;
	details?: Record<string, unknown>;
}

function getBroadcastDir(cwd: string): string {
	return path.resolve(cwd, BROADCAST_DIR);
}

function ensureBroadcastDir(cwd: string): string {
	const dir = getBroadcastDir(cwd);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/** Emit a broadcast event */
export function broadcast(cwd: string, event: Omit<BroadcastEvent, "timestamp">): void {
	const dir = ensureBroadcastDir(cwd);
	const timestamp = new Date().toISOString();
	const id = crypto.randomBytes(4).toString("hex");
	const filename = `${Date.now()}-${id}.json`;
	const fullEvent: BroadcastEvent = { ...event, timestamp };

	try {
		fs.writeFileSync(path.join(dir, filename), JSON.stringify(fullEvent, null, 2), "utf8");
	} catch {
		// ignore write errors
	}
}

/** Read recent broadcast events */
export function readBroadcasts(cwd: string, sinceMs?: number): BroadcastEvent[] {
	const dir = getBroadcastDir(cwd);
	if (!fs.existsSync(dir)) return [];

	const cutoff = sinceMs ?? Date.now() - MAX_AGE_MS;
	const events: BroadcastEvent[] = [];

	try {
		const files = fs.readdirSync(dir)
			.filter((f) => f.endsWith(".json"))
			.sort();

		for (const file of files) {
			const tsStr = file.split("-")[0];
			const ts = parseInt(tsStr, 10);
			if (isNaN(ts) || ts < cutoff) continue;

			try {
				const content = fs.readFileSync(path.join(dir, file), "utf8");
				const event = JSON.parse(content) as BroadcastEvent;
				events.push(event);
			} catch {
				// ignore malformed events
			}
		}
	} catch {
		return [];
	}

	return events.slice(-MAX_EVENTS);
}

/** Garbage collect old broadcast events */
export function gcBroadcasts(cwd: string): number {
	const dir = getBroadcastDir(cwd);
	if (!fs.existsSync(dir)) return 0;

	const cutoff = Date.now() - MAX_AGE_MS;
	let removed = 0;

	try {
		const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
		for (const file of files) {
			const tsStr = file.split("-")[0];
			const ts = parseInt(tsStr, 10);
			if (isNaN(ts) || ts < cutoff) {
				try {
					fs.unlinkSync(path.join(dir, file));
					removed++;
				} catch {
					// ignore
				}
			}
		}
	} catch {
		// ignore
	}

	return removed;
}

export type BroadcastCallback = (event: BroadcastEvent) => void;

/**
 * Watch for new broadcast events via filesystem polling.
 * Returns a cleanup function.
 */
export function watchBroadcasts(
	cwd: string,
	sessionId: string,
	callback: BroadcastCallback,
): () => void {
	const dir = ensureBroadcastDir(cwd);
	let lastSeenTimestamp = Date.now();
	let closed = false;

	const pollInterval = setInterval(() => {
		if (closed) return;
		const events = readBroadcasts(cwd, lastSeenTimestamp);
		for (const event of events) {
			// Don't notify ourselves
			if (event.sessionId === sessionId) continue;
			const eventTs = new Date(event.timestamp).getTime();
			if (eventTs > lastSeenTimestamp) {
				lastSeenTimestamp = eventTs;
				callback(event);
			}
		}
	}, 2000);

	return () => {
		closed = true;
		clearInterval(pollInterval);
	};
}

/** Format a broadcast event for display */
export function formatBroadcastEvent(event: BroadcastEvent): string {
	const time = new Date(event.timestamp).toLocaleTimeString("en-US", {
		hour12: false,
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	const session = event.sessionName || event.sessionId.slice(0, 8);
	const todoRef = event.todoId ? ` TODO-${event.todoId}` : "";
	const title = event.todoTitle ? ` "${event.todoTitle}"` : "";

	switch (event.type) {
		case "todo:claimed":
			return `${time}${todoRef}${title} claimed by ${session}`;
		case "todo:completed":
			return `${time}${todoRef}${title} completed by ${session}`;
		case "agent:started":
			return `${time}  Agent started on${todoRef}${title} (${session})`;
		case "agent:finished":
			return `${time}  Agent finished${todoRef}${title} (${session})`;
		case "merge:conflict":
			return `${time}  ⚠ Merge conflict${todoRef} (${session})`;
		case "merge:success":
			return `${time}  ✓ Merged${todoRef} (${session})`;
		case "dispatch:started":
			return `${time}  Dispatch started (${session})`;
		case "dispatch:complete":
			return `${time}  ✓ Dispatch complete (${session})`;
		case "message":
			return `${time}  [${session}] ${event.message ?? ""}`;
		default:
			return `${time}  ${event.type}${todoRef} (${session})`;
	}
}
