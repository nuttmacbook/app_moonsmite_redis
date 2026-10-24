// Redis key names in one place. Everything game related is scoped to the contract address,
// so a redeploy starts clean, like the phone's old localStorage keys did.

const lower = (a) => String(a ?? "").toLowerCase();

let scope = null;

const setScope = (address) => {
    scope = lower(address);
};

const scopeOf = () => {
    if (scope) return scope;
    scope = lower(process.env.FORGE_ADDRESS || process.env.VITE_FORGE_ADDRESS || "dev");
    return scope;
};

const keys = {
    scope: scopeOf,
    // Written by the previous version only. Read by the admin sync, by the one-time fallback for
    // a wallet without a document, and for sign-in tokens issued before this version (24h).
    sword: (tokenId) => `ms:${scopeOf()}:sword:${tokenId}`,
    stats: (owner) => `ms:${scopeOf()}:stats:${lower(owner)}`,
    imported: (tokenId, syncedAt) => `ms:${scopeOf()}:imported:${tokenId}:${syncedAt}`,
    ownerLock: (owner) => `ms:${scopeOf()}:lock:${lower(owner)}`,
    session: (token) => `ms:auth:session:${token}`,
    market: () => `ms:${scopeOf()}:market`,
    marketLock: () => `ms:${scopeOf()}:market:lock`,
    // One document per wallet: every sword record and the strike stats (see docs.js)
    owner: (owner) => `ms:${scopeOf()}:owner:${lower(owner)}`,
    // This version's own pause flag: the previous version's flag (set while the admin copies its
    // data) does not apply here, so the game opens as soon as this version is live
    maintenance: () => `ms:${scopeOf()}:maintenance:v2`,
    // Hire: one document per smith (license, current job, wages waiting) and the jobs board index
    smith: (wallet) => `ms:${scopeOf()}:smith:${lower(wallet)}`,
    jobs: () => `ms:${scopeOf()}:jobs`,
    // Patterns for the admin tools (SCAN MATCH)
    swordPattern: () => `ms:${scopeOf()}:sword:*`,
    statsPattern: () => `ms:${scopeOf()}:stats:*`,
    ownerPattern: () => `ms:${scopeOf()}:owner:*`,
    lockPattern: () => `ms:${scopeOf()}:lock:*`,
    allPattern: () => `ms:${scopeOf()}:*`,
    limit: (name, who) => `ms:limit:${name}:${lower(who)}:${Math.floor(Date.now() / 60000)}`,
};

export { keys, setScope };
