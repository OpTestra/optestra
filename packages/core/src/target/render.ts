import { renderForModel as renderAndroid } from "@testament/android";
import {
  renderForModel as renderWeb,
  type Observation as WebObservation,
} from "@testament/browser";
import type { HarnessObservation } from "./harness.js";

/**
 * An observation as untrusted text for a model (SAF-3): a web page between PAGE
 * CONTENT markers, an app screen between SCREEN CONTENT markers.
 */
export function renderForModel(
  observation: HarnessObservation,
  options: { nonce?: string } = {},
): string {
  return isScreen(observation)
    ? renderAndroid(observation as never, options)
    : renderWeb(observation as WebObservation, options);
}

/** An Android screen (its URL is android-app://…), not a web page. */
export function isScreen(observation: { url: string }): boolean {
  return observation.url.startsWith("android-app://");
}
