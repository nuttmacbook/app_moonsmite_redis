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
    limit: (name, who) => `ms:limit:${name}:${lower(who)}:${Math.floor(Date.now() / 60000)}`,
};

export { keys, setScope };
