import { itemArt, itemName, itemOf } from "./itemArt";
import { BUTTON, coins, money } from "./ui";
import { mountRing } from "./minigames/ring";
import { mountBurn } from "./minigames/burn";
import { mountRune } from "./minigames/rune";
import { LEVELS } from "./minigames/kit";
import { sound } from "./sound";

// The minigames a strike can roll (see MINIGAME.games in game/rules.js)
const GAMES = {
    ring: {
        title: "Hammer strike",
        how: "Tap anywhere when a ring lands on its glowing target. Targets keep coming.",
        mount: mountRing,
    },
    burn: {
        title: "Flame burn",
        how: "Hold to blow fire on the weapon. Let go when it matches the target heat on the bar.",
        mount: mountBurn,
    },
    rune: {
        title: "Rune memory",
        how: "Remember each rune's color. When they turn blue, tap every rune of the color asked.",
        mount: mountRune,
    },
};

const root = () => document.querySelector("#strike-root");

let cleanup = () => {};
let unlockZoom = () => {};

/**
 * While a strike is open, nothing may zoom the page: iOS Safari ignores user-scalable=no for
 * pinches and can still zoom on a fast double tap over text, which made players lose a round.
 * @returns {() => void} undoes it
 */
const lockZoom = () => {
    const stop = (e) => e.preventDefault();
    let lastTouch = 0;
    const onTouchEnd = (e) => {
        const now = e.timeStamp;
        // Second tap within 350ms on anything but a button is a zoom gesture: drop it
        if (now - lastTouch < 350 && !e.target.closest?.("button, a, input, select, textarea")) e.preventDefault();
        lastTouch = now;
    };
    const el = root();
    document.addEventListener("gesturestart", stop, { passive: false });
    document.addEventListener("dblclick", stop, { passive: false });
    el?.addEventListener("touchend", onTouchEnd, { passive: false });
    return () => {
        document.removeEventListener("gesturestart", stop);
        document.removeEventListener("dblclick", stop);
        el?.removeEventListener("touchend", onTouchEnd);
    };
};

/** Header line for a real strike (NFT and value), a practice round, or a labelled one (exam, smith job) */
const heading = (sword, isPractice) => sword?.label ? /*html*/`
    <p class="truncate text-xs text-slate-400">${sword.sublabel ?? ""}</p>
    <p class="font-mono text-sm font-semibold text-amber-200">${sword.label}</p>
` : isPractice ? /*html*/`
    <p class="truncate text-xs text-slate-400">${itemName(sword?.seed)}</p>
    <p class="font-mono text-sm font-semibold text-amber-200">Practice · no points used</p>
` : /*html*/`
    <p class="truncate text-xs text-slate-500">NFT #${sword?.tokenId ?? ""}, ${itemName(sword?.seed)}</p>
    <p data-strike-value class="font-mono text-sm font-semibold tabular-nums text-emerald-300">${money(sword?.value, 4)}</p>
`;

const shell = (sword, inner, isPractice = false) => /*html*/`
    <div class="fixed inset-0 z-40 flex items-end justify-center overflow-y-auto bg-slate-950/60 backdrop-blur-md sm:items-center sm:p-4">
        <div data-strike-panel class="w-full max-w-lg hud hud-plasma p-5 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.9)] pb-[calc(1.25rem+env(safe-area-inset-bottom,0px))] sm:p-6" role="dialog" aria-modal="true" aria-labelledby="strike-title">
            <div class="mb-5 flex items-center gap-3">
                <div class="grid h-14 w-14 shrink-0 place-items-center">${itemArt(sword?.seed, { heat: 0.4, className: "h-14 w-14" })}</div>
                <div class="min-w-0 flex-1">${heading(sword, isPractice)}</div>
                <button type="button" onclick="closeStrike()" class="${BUTTON.small}" aria-label="Close">Close</button>
            </div>
            ${inner}
        </div>
    </div>
`;

/**
 * Opens the modal and starts the ring minigame with this strike's roll.
 * @param {{ difficulty: string, closeMs: number, seed: number }} session  roll from forge.startStrike
 * @param {object} sword  merged chain + game data, needs seed, tokenId, value
 * @param {(score: number, log: object) => void} onScore  the score shown and the input log the server replays
 */
const showGame = (session, sword, onScore) => {
    const level = LEVELS[session?.difficulty] ?? LEVELS.normal;
    const game = GAMES[session?.game] ?? GAMES.ring;
    const el = root();
    if (!el) return;

    cleanup();
    unlockZoom();
    unlockZoom = lockZoom();
    sound.music("battle", session?.difficulty);
    el.innerHTML = shell(sword, /*html*/`
        <div class="flex items-center justify-between gap-3">
            <h2 id="strike-title" class="font-display text-base font-semibold uppercase tracking-wide text-amber-50">${session?.isPractice ? `Practice · ${game.title}` : game.title}</h2>
            <span class="cut shrink-0 px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wider ring-1 ring-inset ${level.tone}">${level.label}</span>
        </div>
        <p class="mt-1 text-sm text-slate-400">${game.how}</p>
        <div data-game-stage class="mt-4"></div>
    `, session?.isPractice);

    cleanup = game.mount(el.querySelector("[data-game-stage]"), { ...session, image: itemOf(sword?.seed).image }, (score, log) => {
        cleanup = () => {};
        onScore(score, log);
    }) ?? (() => {});
};

const showScoring = () => {
    const stage = document.querySelector("[data-game-stage]");
    if (stage) stage.innerHTML = `<p class="py-8 text-center text-sm text-slate-400">Calibrating the edge…</p>`;
};

/** Shows what this strike did; offers another while points remain */
const showResult = (result, sword) => {
    const el = root();
    if (!el) return;
    const points = Number(result?.points ?? 0);
    const score = Number(result?.score ?? 0);
    const verdict = score >= 95 ? "Perfect strike" : score >= 75 ? "Clean strike" : score >= 40 ? "Rough strike" : "Glancing blow";
    sound.music("menu");
    sound.sfx.result(score);

    el.innerHTML = shell({ ...sword, value: result?.value }, /*html*/`
        <h2 id="strike-title" class="font-display text-lg font-semibold uppercase tracking-wide text-white">${verdict}</h2>
        <div class="mt-5 grid grid-cols-3 gap-3 bg-slate-950/60 p-4 text-center ring-1 ring-inset ring-cyan-300/15">
            <div>
                <p class="text-[11px] text-slate-500">Quality</p>
                <p class="font-mono text-2xl font-bold tabular-nums text-fuchsia-200">${score}</p>
            </div>
            <div>
                <p class="text-[11px] text-slate-500">Value added</p>
                <p class="font-mono text-lg font-semibold tabular-nums text-emerald-300">+${(Number(result?.increase ?? 0) / 1e18).toFixed(6)}</p>
            </div>
            <div>
                <p class="text-[11px] text-slate-500">Points left</p>
                <p class="font-mono text-2xl font-bold tabular-nums text-white">${points}</p>
            </div>
        </div>
        <div class="mt-5 flex justify-end gap-2">
            <button type="button" onclick="closeStrike()" class="${BUTTON.ghost}">Done</button>
            ${points > 0 ? `<button type="button" onclick="openStrike('${sword?.tokenId}')" class="${BUTTON.heat}">Strike again</button>` : ""}
        </div>
    `);
    el.querySelector("[onclick^='openStrike']")?.focus();
};

/** Practice result: the score only, nothing changed */
const showPracticeResult = (score, sword) => {
    const el = root();
    if (!el) return;
    const verdict = score >= 95 ? "Perfect strike" : score >= 75 ? "Clean strike" : score >= 40 ? "Rough strike" : "Glancing blow";
    sound.music("menu");
    sound.sfx.result(score);

    el.innerHTML = shell(sword, /*html*/`
        <h2 id="strike-title" class="font-display text-lg font-semibold uppercase tracking-wide text-white">${verdict}</h2>
        <div class="mt-5 bg-slate-950/60 p-4 text-center ring-1 ring-inset ring-cyan-300/15">
            <p class="text-[11px] text-slate-500">Quality</p>
            <p class="font-mono text-3xl font-bold tabular-nums text-fuchsia-200">${score}</p>
            <p class="mt-2 text-xs text-slate-400">Practice only: no points used, no value added.</p>
        </div>
        <div class="mt-5 flex justify-end gap-2">
            <button type="button" onclick="closeStrike()" class="${BUTTON.ghost}">Done</button>
            <button type="button" onclick="openPractice()" class="${BUTTON.heat}">Practice again</button>
        </div>
    `, true);
    el.querySelector("[onclick^='openPractice']")?.focus();
};

const verdictOf = (score) => (score >= 95 ? "Perfect strike" : score >= 75 ? "Clean strike" : score >= 40 ? "Rough strike" : "Glancing blow");

/** A smith's strike on someone else's weapon: the score, what it added, and the wage it earned */
const showHireResult = (result, sword) => {
    const el = root();
    if (!el) return;
    const points = Number(result?.points ?? 0);
    const score = Number(result?.score ?? 0);
    const canGoOn = points > 0 && !result?.isJobOver;
    sound.music("menu");
    sound.sfx.result(score);

    el.innerHTML = shell({ ...sword, value: result?.value }, /*html*/`
        <h2 id="strike-title" class="font-display text-lg font-semibold uppercase tracking-wide text-white">${verdictOf(score)}</h2>
        <div class="mt-5 grid grid-cols-3 gap-3 bg-slate-950/60 p-4 text-center ring-1 ring-inset ring-cyan-300/15">
            <div>
                <p class="text-[11px] text-slate-500">Quality</p>
                <p class="font-mono text-2xl font-bold tabular-nums text-fuchsia-200">${score}</p>
            </div>
            <div>
                <p class="text-[11px] text-slate-500">Your wage</p>
                <p class="font-mono text-lg font-semibold tabular-nums text-emerald-300">+${coins(result?.wage, 6)}</p>
                <p class="text-[10px] text-slate-500">${Number(result?.share ?? 0)}% of +${coins(result?.increase, 6)}</p>
            </div>
            <div>
                <p class="text-[11px] text-slate-500">Points left</p>
                <p class="font-mono text-2xl font-bold tabular-nums text-white">${points}</p>
            </div>
        </div>
        ${result?.isJobOver ? `<p class="mt-3 text-xs text-amber-200">That was the weapon's last point. The job is done; your wage waits for the owner to pay.</p>` : ""}
        <div class="mt-5 flex justify-end gap-2">
            <button type="button" onclick="closeStrike()" class="${BUTTON.ghost}">Done</button>
            ${canGoOn ? `<button type="button" onclick="openHireStrike()" class="${BUTTON.heat}">Strike again</button>` : ""}
        </div>
    `);
    el.querySelector("[onclick^='openHireStrike']")?.focus();
};

/** End of the licensing exam: the license score and every round's score */
const showExamResult = (result) => {
    const el = root();
    if (!el) return;
    const score = Number(result?.score ?? 0);
    const isBest = score >= Number(result?.best ?? 0);
    sound.music("menu");
    sound.sfx.result(score);

    el.innerHTML = shell({ seed: 1, label: "Licensing exam", sublabel: "Smith license" }, /*html*/`
        <h2 id="strike-title" class="font-display text-lg font-semibold uppercase tracking-wide text-white">Exam complete</h2>
        <div class="mt-5 bg-slate-950/60 p-4 text-center ring-1 ring-inset ring-cyan-300/15">
            <p class="text-[11px] text-slate-500">License score</p>
            <p class="font-mono text-4xl font-bold tabular-nums text-amber-200">${score}</p>
            <p class="mt-1 text-xs ${isBest ? "text-emerald-300" : "text-slate-400"}">${isBest ? "New best score" : `Your best stays ${Number(result?.best ?? 0)}`}</p>
        </div>
        <div class="mt-3 grid grid-cols-6 gap-1.5 font-mono text-xs tabular-nums">
            ${(result?.scores ?? []).map((x) => `<span class="bg-white/[0.05] py-1 text-center ${x >= 75 ? "text-emerald-300" : x >= 40 ? "text-amber-100" : "text-rose-300"}">${x}</span>`).join("")}
        </div>
        <div class="mt-5 flex justify-end gap-2">
            <button type="button" onclick="closeStrike()" class="${BUTTON.primary}">Find jobs</button>
        </div>
    `);
};

const hideStrike = () => {
    cleanup();
    cleanup = () => {};
    unlockZoom();
    unlockZoom = () => {};
    sound.sfx.flameStop();
    sound.music("menu");
    const el = root();
    if (el) el.innerHTML = "";
};

export { showGame, showScoring, showResult, showPracticeResult, showHireResult, showExamResult, hideStrike };
