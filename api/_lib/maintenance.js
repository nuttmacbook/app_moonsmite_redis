// Maintenance pause: while the flag is set, every action that changes progress is refused with a
// message the player can read; reading still works. The admin sets it before moving data between
// formats, so nothing is written in the old format after it was copied.
//
// Each server instance remembers the answer for a few seconds, so this costs about one Redis
// command per instance every 5 seconds, not one per request. The admin script waits longer than
// that (plus the lock time) before it starts copying.

import { cmd } from "./redis.js";
import { keys } from "./keys.js";
import { refuse } from "./http.js";

const CACHE_MS = 5000;
const FLAG_SEC = 2 * 60 * 60;   // never stays on by accident for more than 2 hours

let cached = { at: 0, isOn: false };

async function isMaintenance({ fresh = false } = {}) {
    if (!fresh && Date.now() - cached.at < CACHE_MS) return cached.isOn;
    const value = await cmd("GET", keys.maintenance());
    cached = { at: Date.now(), isOn: Boolean(value) };
    return cached.isOn;
}

async function setMaintenance(isOn) {
    if (isOn) await cmd("SET", keys.maintenance(), String(Date.now()), "EX", FLAG_SEC);
    else await cmd("DEL", keys.maintenance());
    cached = { at: Date.now(), isOn: Boolean(isOn) };
}

/** Refuses the request while the game is being updated */
async function assertOpen() {
    if (await isMaintenance()) refuse("The game is being updated. Try again in a few minutes. Your progress is safe.", 503);
}

export { isMaintenance, setMaintenance, assertOpen, CACHE_MS, FLAG_SEC };
