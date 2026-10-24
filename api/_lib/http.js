// Request and response helpers shared by the Vercel Functions in api/.

/** A refusal the player should read (400), as opposed to a server fault (500) */
class Refused extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

const refuse = (message, status = 400) => {
    throw new Refused(message, status);
};

const readBody = async (req) => {
    if (req.body && typeof req.body === "object") return req.body;
    if (typeof req.body === "string") return JSON.parse(req.body || "{}");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
};

/** JSON response; BigInt values go out as strings */
const send = (res, status, body, headers = {}) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", headers["Cache-Control"] ?? "no-store");
    Object.entries(headers).forEach(([ k, v ]) => k !== "Cache-Control" && res.setHeader(k, v));
    res.end(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
};

/** Query string of a Node or Vercel request */
const queryOf = (req) => req.query ?? Object.fromEntries(new URL(req.url, "http://local").searchParams);

const clientIp = (req) => String(req.headers?.["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "unknown").split(",")[0].trim();

/** Wraps a handler: refusals become 4xx with their message, anything else a plain 500 */
const handle = (fn) => async (req, res) => {
    try {
        await fn(req, res);
    } catch (error) {
        if (error instanceof Refused || (error?.status && error.status < 500)) {
            return send(res, error.status ?? 400, { error: error.message });
        }
        console.error(error);
        // Outside production (vercel dev, preview) say what broke, so setup mistakes are easy to find
        const isProduction = process.env.VERCEL_ENV === "production";
        const cause = error?.cause?.hostname ? `: ${error.cause.code} ${error.cause.hostname}` : "";
        const detail = isProduction ? "" : ` (${error?.message ?? error}${cause})`;
        return send(res, 500, { error: `The game server is not available right now. Please try again.${detail}` });
    }
};

export { Refused, refuse, readBody, send, queryOf, clientIp, handle };
