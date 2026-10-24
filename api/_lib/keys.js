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
    sword: (tokenId) => `ms:${scopeOf()}:sword:${tokenId}`,
    stats: (owner) => `ms:${scopeOf()}:stats:${lower(owner)}`,
    imported: (tokenId, syncedAt) => `ms:${scopeOf()}:imported:${tokenId}:${syncedAt}`,
    ownerLock: (owner) => `ms:${scopeOf()}:lock:${lower(owner)}`,
    nonce: (owner) => `ms:auth:nonce:${lower(owner)}`,
    session: (token) => `ms:auth:session:${token}`,
    market: () => `ms:${scopeOf()}:market`,
    marketLock: () => `ms:${scopeOf()}:market:lock`,
    // One document per wallet: every sword record and the strike stats (see docs.js)
    owner: (owner) => `ms:${scopeOf()}:owner:${lower(owner)}`,
    maintenance: () => `ms:${scopeOf()}:maintenance`,
    // Patterns for the admin tools (SCAN MATCH)
    swordPattern: () => `ms:${scopeOf()}:sword:*`,
    statsPattern: () => `ms:${scopeOf()}:stats:*`,
    ownerPattern: () => `ms:${scopeOf()}:owner:*`,
    lockPattern: () => `ms:${scopeOf()}:lock:*`,
    allPattern: () => `ms:${scopeOf()}:*`,
    limit: (name, who) => `ms:limit:${name}:${lower(who)}:${Math.floor(Date.now() / 60000)}`,
};

export { keys, setScope };
