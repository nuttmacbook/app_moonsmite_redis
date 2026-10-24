#!/usr/bin/env node
// Admin tool: moves the game server's data to the new format before a new version goes live.
// Runs on the admin's computer and talks to /api/admin on the live site (Node 18+, no packages).
//
//   ADMIN_KEY=... node scripts/sync-all.mjs https://your-site.app migrate   pause the game, back up, copy, verify
//   ADMIN_KEY=... node scripts/sync-all.mjs https://your-site.app open      resume the game (after the new deploy)
//   ADMIN_KEY=... node scripts/sync-all.mjs https://your-site.app status
//   ADMIN_KEY=... node scripts/sync-all.mjs https://your-site.app backup
//   ADMIN_KEY=... node scripts/sync-all.mjs https://your-site.app restore backups/<file>.json
//
// "migrate" never deletes or changes the old data, so if anything looks wrong, "open" brings the
// current version back exactly as it was. The next version does not read this version's pause
// flag, so pushing it after "migrate" opens the game by itself.

import { mkdir, writeFile, readFile } from "node:fs/promises";

const [ , , site, command = "status", file ] = process.argv;
const KEY = process.env.ADMIN_KEY;
const WAIT_SEC = 15;   // > the servers' 5s maintenance cache + the 10s lock time

if (!site || !KEY) {
    console.error("Usage: ADMIN_KEY=... node scripts/sync-all.mjs https://your-site.app [migrate|open|status|backup|restore <file>]");
    process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function admin(action, body = {}) {
    for (let attempt = 1; ; attempt++) {
        let res;
        try {
            res = await fetch(new URL("/api/admin", site), {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
                body: JSON.stringify({ action, ...body }),
            });
        } catch (error) {
            if (attempt >= 4) throw error;
            await sleep(1000 * attempt);
            continue;
        }
        const json = await res.json().catch(() => ({}));
        if (res.ok) return json;
        if (res.status >= 500 && attempt < 4) {
            await sleep(1000 * attempt);
            continue;
        }
        throw new Error(`${action}: ${res.status} ${json?.error ?? ""}`);
    }
}

/** Runs a paged action until the cursor comes back to "0", collecting each page */
async function pages(action, body, onPage) {
    let cursor = "0";
    do {
        const page = await admin(action, { ...body, cursor });
        await onPage(page);
        cursor = page.cursor;
    } while (cursor !== "0");
}

async function backup() {
    const entries = [];
    await pages("backup", {}, (p) => entries.push(...p.entries));
    await mkdir("backups", { recursive: true });
    const path = `backups/backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    await writeFile(path, JSON.stringify({ site, at: Date.now(), entries }));
    console.log(`  backup: ${entries.length} keys → ${path}`);
    return path;
}

async function status() {
    const s = await admin("status");
    console.log(`  scope ${s.scope}`);
    console.log(`  maintenance: ${s.maintenance ? "ON (game paused)" : "off"}, open locks: ${s.locks}`);
    console.log(`  old sword keys: ${s.oldSwordKeys.total}, old stats keys: ${s.oldStatsKeys.total}, wallet documents: ${s.ownerDocs.total}`);
    return s;
}

async function migrate() {
    console.log("1/6 status");
    await status();

    console.log("2/6 pause the game");
    await admin("maintenance", { on: true });
    for (let s = WAIT_SEC; s > 0; s--) {
        process.stdout.write(`\r  waiting ${s}s for actions in progress to finish… `);
        await sleep(1000);
    }
    process.stdout.write("\n");
    for (let i = 0; i < 10 && (await admin("status")).locks > 0; i++) await sleep(2000);

    console.log("3/6 back up");
    await backup();

    console.log("4/6 copy sword records");
    let swords = 0;
    await pages("sync", { kind: "swords" }, (p) => {
        swords += p.swords;
        process.stdout.write(`\r  ${swords} swords`);
    });
    process.stdout.write("\n");

    console.log("5/6 copy strike stats");
    let owners = 0;
    await pages("sync", { kind: "stats" }, (p) => {
        owners += p.owners;
    });
    console.log(`  ${owners} wallets`);

    console.log("6/6 verify");
    const bad = [];
    let checked = 0;
    for (const kind of [ "swords", "stats" ]) {
        await pages("verify", { kind }, (p) => {
            checked += p.checked;
            bad.push(...p.mismatched);
        });
    }
    if (bad.length) {
        console.error(`  ✗ ${bad.length} of ${checked} do not match: ${bad.slice(0, 10).join(", ")}${bad.length > 10 ? " …" : ""}`);
        console.error("  Nothing was deleted. Run `migrate` again, or `open` to resume the current version as it was.");
        process.exit(2);
    }
    console.log(`  ✓ all ${checked} records match`);
    await status();
    console.log("\nThe game is paused. Push the new version now (git push): the game opens by itself");
    console.log("as soon as Vercel has deployed it. If you need the current version back instead:");
    console.log(`  ADMIN_KEY=… node scripts/sync-all.mjs ${site} open`);
}

try {
    if (command === "migrate") await migrate();
    else if (command === "open") {
        await admin("maintenance", { on: false });
        console.log("Game resumed.");
        await status();
    } else if (command === "backup") await backup();
    else if (command === "restore") {
        const { entries } = JSON.parse(await readFile(file, "utf8"));
        let restored = 0;
        for (let i = 0; i < entries.length; i += 500) restored += (await admin("restore", { entries: entries.slice(i, i + 500) })).restored;
        console.log(`Restored ${restored} keys from ${file}`);
    } else await status();
} catch (error) {
    console.error(`Failed: ${error.message}`);
    process.exit(1);
}
