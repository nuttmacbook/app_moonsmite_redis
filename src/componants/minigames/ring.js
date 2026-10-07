import { rng, countdown, buzz, chips, forgeSparks, shake, callout, verdict, weaponStage, setHeat } from "./kit";
import { sound } from "../sound";
import { average, ringPlan, ringScale, ringTapScore, RING_START_SCALE } from "../../game/scoring";

// The strike minigame: rings close in on glowing targets. Tap anywhere the moment a ring lands.
// Targets keep coming without waiting for the last one, so several can be on screen at once;
// a tap always strikes the oldest one (its ring is the closest to landing).
// The strike's level sets the ring speed; every target rolls its own size and position.
// Settings live in MINIGAME.ring and MINIGAME.levels at the top of game/rules.js.
//
// Targets and scoring come from game/scoring.js, the same code the game server replays the tap
// log with, so the score on screen is the score the server gives.

/**
 * @param {HTMLElement} el
 * @param {object} roll  from the strike: difficulty, closeMs, seed, ring (settings), image
 * @param {(score: number, log: { game: "ring", taps: number[] }) => void} onDone  average score 0-100 and the tap log
 */
const mountRing = (el, roll = {}, onDone) => {
    const plan = ringPlan(roll);
    const blows = plan.blows;
    // Screen positions use their own random stream, so screen size never changes the targets
    const rand = rng(((Number(roll.seed) >>> 0) ^ 0x5bd1e995) >>> 0);

    const scores = [];
    const taps = [];     // tap times, ms from go
    const active = [];   // targets on screen, oldest first
    let spawned = 0;
    let goAt = 0;
    let frame = 0;
    let isDone = false;
    let isLive = false;          // taps only count once the countdown is over

    el.innerHTML = /*html*/`
        <div class="flex flex-col gap-3">
            <div data-stage class="stage relative h-60 touch-none select-none overflow-hidden">
                ${weaponStage(roll.image)}
            </div>
            <div data-chips class="flex gap-1">${chips(blows, scores)}</div>
        </div>
    `;

    const stage = el.querySelector("[data-stage]");
    const heat = el.querySelector("[data-blade-heat]");
    const panel = el.closest("[data-strike-panel]") ?? stage;

    /** A spot on the stage with room for the full ring, kept clear of targets already showing */
    const pickSpot = (size) => {
        const box = stage.getBoundingClientRect();
        const margin = size / 2 + 6;
        let best = null;
        for (let i = 0; i < 8; i++) {
            const x = margin + rand() * Math.max(1, box.width - margin * 2);
            const y = margin + rand() * Math.max(1, box.height - margin * 2);
            const clear = active.every((t) => Math.hypot(t.x - x, t.y - y) > (t.size + size) / 2 + 12);
            best = { x, y };
            if (clear) break;
        }
        return best;
    };

    const spawn = () => {
        const target = plan.targets[spawned];
        const size = target.size;
        const { x, y } = pickSpot(size);
        const make = (cls) => {
            const node = document.createElement("div");
            node.className = cls;
            node.style.cssText = `width:${size}px;height:${size}px;left:${x}px;top:${y}px;`;
            stage.appendChild(node);
            return node;
        };
        const spot = make("absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-amber-200 bg-amber-300/25 shadow-[0_0_24px_rgba(252,211,77,0.9)]");
        const ring = make("absolute rounded-full border-2 border-cyan-200 shadow-[0_0_16px_rgba(103,232,249,0.9)]");
        ring.style.transform = `translate(-50%, -50%) scale(${RING_START_SCALE})`;
        active.push({ spot, ring, x, y, size, target });
        spawned++;
    };

    const finish = () => {
        isDone = true;
        cancelAnimationFrame(frame);
        setTimeout(() => onDone(average(scores), { game: "ring", taps }), 450);
    };

    /** Scores one target and clears it; isTap means the player struck it (sparks and a jolt) */
    const resolve = (target, score, isTap) => {
        active.splice(active.indexOf(target), 1);
        scores.push(score);
        el.querySelector("[data-chips]").innerHTML = chips(blows, scores);

        if (isTap) sound.sfx.hammer(score);
        else sound.sfx.miss();
        if (isTap) {
            forgeSparks(stage, target.x, target.y, score);
            shake(panel, score);
        }
        callout(stage, verdict(score), score >= 40);
        setHeat(heat, Math.min(0.85, scores.length / blows));
        buzz(score >= 90 ? [ 14, 30, 14 ] : 18);

        [ target.spot, target.ring ].forEach((n) => {
            n.animate?.([ { opacity: 1 }, { opacity: 0 } ], { duration: 160 }).finished?.then(() => n.remove()).catch(() => n.remove());
            if (!n.animate) n.remove();
        });

        if (scores.length >= blows) finish();
    };

    /** ms since go, rounded the way the log stores it */
    const sinceGo = (now = performance.now()) => Math.round((now - goAt) * 10) / 10;

    /** Rings that shrank past their target without a tap are misses (same rule as the replay) */
    const expire = (atMs) => {
        while (active.length && active[0].target.startMs + plan.missMs <= atMs) resolve(active[0], 0, false);
    };

    const tick = (now) => {
        if (isDone) return;
        const at = now - goAt;
        while (spawned < blows && plan.targets[spawned].startMs <= at) spawn();
        expire(at);
        active.forEach((t) => {
            t.ring.style.transform = `translate(-50%, -50%) scale(${Math.max(0, ringScale(plan, t.target, at))})`;
        });
        if (!isDone) frame = requestAnimationFrame(tick);
    };

    const hit = (e) => {
        e?.preventDefault?.();
        if (isDone || !isLive) return;
        const at = sinceGo();
        // A target that is due on screen but not drawn yet still counts, like in the replay
        while (spawned < blows && plan.targets[spawned].startMs <= at) spawn();
        expire(at);
        if (active.length === 0) return;
        taps.push(at);
        resolve(active[0], ringTapScore(plan, active[0].target, at), true);
    };

    const onKey = (e) => {
        if (e.code === "Space" || e.code === "Enter") hit(e);
    };

    stage.addEventListener("pointerdown", hit);
    window.addEventListener("keydown", onKey);
    const stopCountdown = countdown(stage, roll.difficulty, () => {
        if (isDone) return;
        isLive = true;
        goAt = performance.now();
        frame = requestAnimationFrame(tick);
    });

    return () => {
        isDone = true;
        cancelAnimationFrame(frame);
        stopCountdown();
        window.removeEventListener("keydown", onKey);
    };
};

export { mountRing };
