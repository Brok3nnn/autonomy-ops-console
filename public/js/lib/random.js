// Randomness helpers. Every function takes the random source as a parameter
// so tests can pass a deterministic one.

/** Integer in [min, max], both inclusive. */
export function randomInt(min, max, random = Math.random) {
  return Math.floor(random() * (max - min + 1)) + min;
}

/** Random element of a non-empty array. */
export function pickRandom(items, random = Math.random) {
  return items[Math.floor(random() * items.length)];
}

/** Fisher-Yates shuffle into a new array. */
export function shuffle(items, random = Math.random) {
  const values = [...items];
  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}
