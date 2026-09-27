import type { Chapter } from "./types.js";

// EVD-1 evidence helpers: video chapters (one per step) as WebVTT, and the
// console errors the failure classifier reads.

const pad = (n: number, width = 2) => String(Math.floor(n)).padStart(width, "0");

function timestamp(ms: number): string {
  const clamped = Math.max(0, ms);
  const hours = clamped / 3_600_000;
  const minutes = (clamped % 3_600_000) / 60_000;
  const seconds = (clamped % 60_000) / 1000;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(clamped % 1000, 3)}`;
}

/**
 * WebVTT chapters for the attempt's video: one cue per step, timed from when
 * the attempt started (the video starts with the browser context, so a step's
 * cue may begin a little before it shows).
 */
export function chaptersVtt(chapters: readonly Chapter[], offsetMs = 0): string {
  const lines = ["WEBVTT", "Kind: chapters", ""];
  for (const chapter of chapters) {
    const start = chapter.startMs + offsetMs;
    const end = Math.max(chapter.endMs + offsetMs, start + 1);
    lines.push(
      `step-${chapter.index + 1}`,
      `${timestamp(start)} --> ${timestamp(end)}`,
      `${chapter.index + 1}. ${chapter.title.replace(/\s*-->\s*/g, " → ").replace(/\n+/g, " ")}`,
      "",
    );
  }
  return lines.join("\n");
}

/** Error lines of a harness console log (one message per line: "<time> [type] text"). */
export function consoleErrors(log: string): string[] {
  return log
    .split("\n")
    .filter((line) => /\[(error|pageerror)\]/i.test(line))
    .map((line) => line.slice(0, 500))
    .slice(0, 20);
}
