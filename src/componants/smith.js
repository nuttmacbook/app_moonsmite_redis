import { shortAddress } from "../web3/connect";
import { itemArt, itemName } from "./itemArt";
import { CARD, BUTTON, FOCUS, money, coins, stat, nftTag, timeAgo, connectPrompt, pageTitle } from "./ui";
import { MINIGAME, LEVEL_IDS, HIRE } from "../game/rules";

// The Smith tab: the licensing exam, the job a smith holds, wages, and the jobs board.
// Everything here draws what it is given (data.smith from /api/smith, data.wagesInfo from the
// Wages contract, the board from /api/jobs); the handlers live in main.js.

const GAME_LABELS = { ring: "Ring", burn: "Burn", rune: "Rune" };
const LEVEL_LABELS = { easy: "Easy", normal: "Normal", hard: "Hard", insane: "Insane" };

const sectionTitle = (text, extra = "") => /*html*/`
    <div class="flex items-baseline justify-between gap-3">
        <h2 class="font-display text-sm font-semibold uppercase tracking-wider text-amber-50">${text}</h2>
        ${extra}
    </div>
`;

const countdown = (target) => `<span data-countdown data-target="${Number(target ?? 0)}" class="font-mono tabular-nums">—</span>`;

/** The 12 exam rounds as a grid: games down, levels across, with scores once taken */
const examGrid = (scores = []) => {
    const games = MINIGAME.games.length ? MINIGAME.games : [ "ring" ];
    const cell = (i) => {
        const score = scores[i];
        const tone = score == null ? "text-slate-500" : score >= 75 ? "text-emerald-300" : score >= 40 ? "text-amber-100" : "text-rose-300";
        return `<div class="bg-white/[0.05] py-1.5 text-center font-mono text-[13px] font-semibold tabular-nums ${tone}">${score ?? "—"}</div>`;
    };
    return /*html*/`
        <div class="grid grid-cols-[64px_repeat(4,minmax(0,1fr))] gap-1.5">
            <div></div>
            ${LEVEL_IDS.map((l) => `<div class="text-center text-[11px] text-slate-400">${LEVEL_LABELS[l] ?? l}</div>`).join("")}
            ${games.map((g, gi) => /*html*/`
                <div class="py-1.5 text-xs font-semibold text-amber-200">${GAME_LABELS[g] ?? g}</div>
                ${LEVEL_IDS.map((_, li) => cell(gi * LEVEL_IDS.length + li)).join("")}
            `).join("")}
        </div>
    `;
};

const licenseCard = (page, now) => {
    const license = page?.license;
    const nextAt = Number(license?.nextAt ?? 0);
    const canRetake = !license || nextAt <= now;
    const examButton = canRetake
        ? `<button type="button" onclick="startExam()" class="${BUTTON.primary} w-full sm:w-auto">${license ? "Retake exam" : "Start exam"}</button>`
        : `<button type="button" class="${BUTTON.ghost} w-full sm:w-auto" disabled>Retake in ${countdown(nextAt)}</button>`;

    if (!license) {
        return /*html*/`
        <section class="${CARD} flex flex-col gap-4 p-4">
            ${sectionTitle("Licensing exam", `<span class="text-xs text-slate-400">${(MINIGAME.games.length || 1) * LEVEL_IDS.length} rounds · 5–8 min</span>`)}
            ${examGrid()}
            <p class="text-[13px] text-slate-300">Play every minigame at every level. Your license score is the average of all rounds. Your best score counts, and you can retake once a day. Free: no NFT, no gas.</p>
            ${examButton}
        </section>
        `;
    }

    return /*html*/`
    <section class="${CARD} flex flex-col gap-4 p-4">
        <div class="flex items-center gap-4">
            <div class="cut grid h-16 w-16 shrink-0 place-items-center bg-amber-300/10 shadow-[inset_0_0_0_1px_rgba(252,211,77,0.4)]">
                <span class="font-display text-2xl font-bold text-amber-200">${Number(license.best)}</span>
            </div>
            <div class="min-w-0 flex-1">
                <p class="text-[10px] font-semibold uppercase tracking-[0.24em] text-amber-200/80">Smith license</p>
                <p class="mt-1 text-[13px] text-slate-300">Work score <span class="font-mono font-semibold text-emerald-300">${page.workScore ?? "—"}</span> · last ${HIRE.workScoreOf} strikes</p>
                <p class="text-[13px] text-slate-300">${Number(page.stats?.strikes ?? 0).toLocaleString()} strikes · ${money(page.stats?.valueAdded, 4)} added for others</p>
            </div>
        </div>
        <details class="group">
            <summary class="cursor-pointer text-xs font-semibold text-amber-200 ${FOCUS}">Last exam: ${Number(license.last)} · ${timeAgo(now - Number(license.takenAt))}</summary>
            <div class="mt-3">${examGrid(license.scores ?? [])}</div>
        </details>
        ${examButton}
    </section>
    `;
};

/** Total earned = claimed + claimable (on the contract) + waiting on owners (game server) */
const wagesCard = (page, wagesInfo) => {
    const claimable = BigInt(wagesInfo?.claimable ?? wagesInfo?.[0] ?? 0);
    const claimed = BigInt(wagesInfo?.claimed ?? wagesInfo?.[1] ?? 0);
    const waiting = BigInt(page?.pendingTotal ?? 0);
    const total = claimable + claimed + waiting;
    const share = (x) => (total > 0n ? Number(x * 1000n / total) / 10 : 0);

    return /*html*/`
    <section class="${CARD} flex flex-col gap-4 p-4">
        ${sectionTitle("Wages", `<span class="text-xs text-slate-400">MWLD</span>`)}
        <div>
            <p class="text-[10px] uppercase tracking-wider text-slate-500">Total earned</p>
            <p class="font-mono text-2xl font-bold tabular-nums text-white">${coins(total, 4)}</p>
        </div>
        <div class="flex h-2 gap-0.5 overflow-hidden bg-black/30" aria-hidden="true">
            <div class="bg-slate-500" style="width:${share(claimed)}%"></div>
            <div class="bg-emerald-400" style="width:${share(claimable)}%"></div>
            <div class="bg-amber-400" style="width:${share(waiting)}%"></div>
        </div>
        <div class="grid grid-cols-3 gap-3">
            ${stat("Claimed", coins(claimed, 4), "text-slate-300")}
            ${stat("Claimable", coins(claimable, 4), "text-emerald-300")}
            ${stat("Waiting", coins(waiting, 4), "text-amber-200")}
        </div>
        <button type="button" onclick="claimSmithWages()" class="${BUTTON.primary}" ${claimable > 0n ? "" : "disabled"}>Claim ${coins(claimable, 4)} MWLD</button>
        ${(page?.pending ?? []).length ? /*html*/`
            <div class="flex flex-col divide-y divide-amber-200/10 border-t border-amber-200/10">
                <p class="pt-3 pb-1 text-[11px] uppercase tracking-wider text-slate-400">Waiting on owners</p>
                ${page.pending.map((p) => /*html*/`
                    <div class="flex items-center justify-between gap-3 py-2 text-[13px]">
                        <span class="flex min-w-0 items-center gap-1.5">${nftTag(p.tokenId)}<span class="truncate font-mono text-xs text-slate-400">${shortAddress(p.owner)}</span></span>
                        <span class="flex shrink-0 items-baseline gap-2"><span class="text-[11px] ${Number(page.now) - Number(p.since) > 3 * 86400 ? "text-amber-200" : "text-slate-500"}">${timeAgo(Number(page.now) - Number(p.since))}</span><span class="font-mono font-semibold tabular-nums text-white">${coins(p.wei, 4)}</span></span>
                    </div>
                `).join("")}
            </div>
        ` : ""}
    </section>
    `;
};

const jobCard = (page) => {
    const job = page?.job;
    if (!job) return "";
    return /*html*/`
    <section class="${CARD} hud-plasma flex flex-col gap-4 p-4">
        <div class="flex items-center gap-3">
            <div class="grid h-20 w-20 shrink-0 place-items-center">${itemArt(job.seed, { heat: 0.3, className: "h-20 w-20" })}</div>
            <div class="min-w-0 flex-1">
                <p class="text-[10px] font-semibold uppercase tracking-[0.24em] text-amber-200/80">Your job</p>
                <div class="mt-1 flex items-center gap-1.5">${nftTag(job.tokenId)}<h3 class="truncate text-sm font-semibold text-amber-50">${itemName(job.seed)}</h3></div>
                <p class="mt-0.5 text-xs text-slate-400">Owner <span class="font-mono">${shortAddress(job.owner)}</span> · your share <span class="font-semibold text-amber-200">${job.share}%</span></p>
            </div>
        </div>
        <p class="text-xs text-emerald-300">Locked to you · frees in ${countdown(job.freeAt)} without a strike</p>
        <div class="grid grid-cols-3 gap-3">
            ${stat("Points left", Number(job.points).toLocaleString(), "text-amber-200")}
            ${stat("Value", coins(job.value, 4), "text-emerald-300")}
            ${stat("Strikes", (job.log ?? []).length.toLocaleString())}
        </div>
        <button type="button" onclick="openHireStrike()" class="${BUTTON.heat} py-3" ${Number(job.points) > 0 ? "" : "disabled"}>Strike · 1 point</button>
        ${(job.log ?? []).length ? /*html*/`
            <div class="grid grid-cols-[auto_1fr_1fr] gap-x-3 gap-y-1 border-t border-amber-200/10 pt-3 font-mono text-xs tabular-nums">
                <span class="text-[10px] uppercase tracking-wider text-slate-500">Score</span><span class="text-[10px] uppercase tracking-wider text-slate-500">Value added</span><span class="text-[10px] uppercase tracking-wider text-slate-500">Your wage</span>
                ${job.log.slice(0, 6).map((x) => `<span class="${x.score >= 75 ? "text-emerald-300" : "text-amber-100"}">${x.score}</span><span>+${coins(x.added, 6)}</span><span class="text-emerald-300">+${coins(x.wage, 6)}</span>`).join("")}
            </div>
        ` : ""}
        <button type="button" onclick="releaseSmithJob()" class="${BUTTON.ghost}">Release job</button>
    </section>
    `;
};

/** One job on the board */
const jobItem = (item, data, view) => {
    const page = data?.smith;
    const me = String(data?.account ?? "").toLowerCase();
    const best = Number(page?.license?.best ?? -1);
    const isMine = item.owner === me;
    const isBlocked = (item.blocked ?? []).includes(me);
    const needsMore = best < Number(item.minScore);
    const hasJob = Boolean(page?.job);
    const owes = BigInt(item.ownerOwed ?? 0) > 0n;
    const record = owes
        ? `<span class="text-amber-200">Owner owes ${coins(item.ownerOwed, 4)} · ${timeAgo(Number(view.now) - Number(item.ownerOwedSince))}</span>`
        : item.ownerPaid > 0
            ? `<span class="text-emerald-300">Owner paid ${item.ownerPaid} time${item.ownerPaid === 1 ? "" : "s"} · nothing owed</span>`
            : `<span class="text-slate-400">New owner · nothing owed</span>`;

    const button = isMine ? `<button type="button" class="${BUTTON.ghost} w-full" disabled>Your weapon</button>`
        : item.isBusy ? `<button type="button" class="${BUTTON.ghost} w-full" disabled>Smith at work · free in ${countdown(item.freeAt)}</button>`
        : !page?.license ? `<button type="button" class="${BUTTON.ghost} w-full" disabled>Pass the exam first</button>`
        : needsMore ? `<button type="button" class="${BUTTON.ghost} w-full" disabled>Needs license ${item.minScore}</button>`
        : isBlocked ? `<button type="button" class="${BUTTON.ghost} w-full" disabled>Not open to you</button>`
        : hasJob ? `<button type="button" class="${BUTTON.ghost} w-full" disabled>Finish your job first</button>`
        : `<button type="button" onclick="takeSmithJob('${item.owner}', '${item.tokenId}')" class="${BUTTON.primary} w-full">Take job</button>`;

    return /*html*/`
    <article class="${CARD} flex flex-col gap-3 p-3 ${needsMore && !isMine ? "opacity-70" : ""}">
        <div class="flex items-center gap-3">
            <div class="grid h-14 w-14 shrink-0 place-items-center">${itemArt(item.seed, { className: "h-14 w-14" })}</div>
            <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5">${nftTag(item.tokenId)}<h3 class="truncate text-[13px] font-semibold text-amber-50">${itemName(item.seed)}</h3></div>
                <p class="mt-0.5 truncate text-[11px]">${record}</p>
            </div>
            <div class="shrink-0 text-right">
                <p class="text-[10px] uppercase tracking-wider text-slate-500">Share</p>
                <p class="font-display text-lg font-bold text-amber-200">${item.share}%</p>
            </div>
        </div>
        <div class="grid grid-cols-3 gap-3">
            ${stat("Value", coins(item.value, 4), "text-emerald-300")}
            ${stat("Points", Number(item.points).toLocaleString(), "text-amber-200")}
            ${stat("Needs", `${item.minScore}+`, needsMore && !isMine ? "text-rose-300" : "text-slate-100")}
        </div>
        ${button}
    </article>
    `;
};

/** The board on its own, so it can refresh without repainting the tab (data-jobs-results) */
const jobsResults = (view, data) => {
    if (view?.isLoading) return `<p class="py-6 text-center text-sm text-slate-400">Loading jobs…</p>`;
    const best = Number(data?.smith?.license?.best ?? -1);
    const items = (view?.items ?? []).filter((x) => view.filter !== "mine" || best >= Number(x.minScore));
    if (!items.length) {
        return `<p class="${CARD} p-4 text-sm text-slate-400">${view?.filter === "mine" && (view?.items ?? []).length ? "No jobs match your license score right now. Try All." : "No weapons out for hire right now. Check back soon."}</p>`;
    }
    return `<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">${items.map((x) => jobItem(x, data, view)).join("")}</div>`;
};

const chip = (isOn, onclick, label) => /*html*/`
    <button type="button" onclick="${onclick}" aria-pressed="${isOn}"
        class="cut shrink-0 px-3 py-1.5 text-xs font-semibold ${isOn ? "bg-amber-300/20 text-amber-100 shadow-[inset_0_0_0_1px_rgba(252,211,77,0.6)]" : "bg-white/[0.03] text-slate-400 shadow-[inset_0_0_0_1px_rgba(252,211,77,0.15)]"} ${FOCUS}">${label}</button>
`;

/**
 * @param {object} data  page data: account, smith (from /api/smith), wagesInfo (Wages.getSmithInfo), game.now
 * @param {{ items: object[], filter: "mine" | "all", isLoading: boolean, now: number }} view  the jobs board
 */
const smith = (data, view) => {
    const title = pageTitle("Smith for hire", "Smith jobs", `Strike other players' weapons and earn up to ${HIRE.maxShare}% of the value you add. No NFT needed.`);
    if (!data?.wallet?.address) return /*html*/`<div class="flex flex-col gap-5">${title}${connectPrompt("Connect to work as a smith", "Your license and wages belong to your wallet.")}</div>`;

    const page = data?.smith;
    const now = Number(data?.game?.now ?? Math.floor(Date.now() / 1000));
    if (!page) return /*html*/`<div class="flex flex-col gap-5">${title}<p class="${CARD} p-4 text-sm text-slate-400">The smiths' guild is not reachable right now. Try again in a moment.</p></div>`;

    const total = (view?.items ?? []).length;
    const best = Number(page?.license?.best ?? -1);
    const mine = (view?.items ?? []).filter((x) => best >= Number(x.minScore)).length;

    return /*html*/`
    <div class="flex flex-col gap-5">
        ${title}
        <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
            <div class="flex flex-col gap-4">
                ${jobCard(page)}
                ${licenseCard(page, now)}
                ${page.license || BigInt(page.pendingTotal ?? 0) > 0n ? wagesCard(page, data?.wagesInfo) : ""}
            </div>
            <div class="flex min-w-0 flex-col gap-3">
                <div class="flex items-center gap-2">
                    ${sectionTitle("Hire board")}
                    <span class="flex-1"></span>
                    ${chip(view?.filter !== "all", "filterJobs('mine')", `I qualify · ${mine}`)}
                    ${chip(view?.filter === "all", "filterJobs('all')", `All · ${total}`)}
                    <button type="button" onclick="refreshJobs()" class="${BUTTON.small}" aria-label="Refresh jobs">↻</button>
                </div>
                <div data-jobs-results>${jobsResults(view, data)}</div>
            </div>
        </div>
    </div>
    `;
};

export { smith, jobsResults };
