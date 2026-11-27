import { randomInt } from "node:crypto";

const WORDS = [
  "amber", "apple", "birch", "bridge", "cabin", "cedar", "cliff", "cloud",
  "copper", "coral", "daisy", "dune", "fern", "field", "finch", "forest",
  "frost", "garden", "harbor", "hazel", "island", "lake", "maple", "meadow",
  "moon", "olive", "pebble", "pine", "river", "robin", "stone", "willow",
];
const SEAT_MATCHED = "seat-metadata-matched";

// Retain one comparison for this navigation. The launcher keeps this on
// its own side and reads it again when checking the same window after restart.
export function prepareSeatWindow({ listener, binding, recheck }) {
  if (recheck() !== SEAT_MATCHED) return null;
  const phrase = Array.from({ length: 5 }, () => WORDS[randomInt(WORDS.length)]).join(" ");
  const selected = listener.mintWindowNavigation(binding, { windowPhrase: phrase });
  const comparison = Object.freeze({ phrase, captureVersion: binding.captureVersion });
  let shown = false;
  return Object.freeze({
    navigation: Object.freeze({
      url: selected.url,
      takeView() {
        const observed = selected.takeView();
        shown ||= observed;
        return observed;
      },
    }),
    comparison() {
      return shown && recheck() === SEAT_MATCHED && selected.isCurrent() ? comparison : null;
    },
  });
}
