/**
 * Access and refresh tokens.
 *
 * The frontend and the API are deployed to unrelated hosts, so a session
 * cookie would be a third-party cookie — Safari and Firefox block those
 * outright. Instead:
 *
 *   access token   short-lived signed JWT, sent as `Authorization: Bearer`,
 *                  held only in the page's memory
 *   refresh token  opaque 32 random bytes, stored in the browser and swapped
 *                  for a new pair; only its SHA-256 is kept server-side, and
 *                  it is rotated on every use so a stolen one dies quickly
 */
import { createHash, randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { sql } from "./db.js";

if (!process.env.AUTH_SECRET) {
  throw new Error("AUTH_SECRET is not set. Copy .env.example to .env.");
}
const SECRET = new TextEncoder().encode(process.env.AUTH_SECRET);

const ACCESS_TTL = "15m";
const REFRESH_DAYS = 7;

/** @param {string} token @returns {string} Hex SHA-256, what we store. */
const fingerprint = (token) => createHash("sha256").update(token).digest("hex");

/**
 * @param {{ id: string, role: string, name: string, email: string }} account
 * @returns {Promise<string>} A signed access token.
 */
export async function issueAccessToken(account) {
  return new SignJWT({ role: account.role, name: account.name, email: account.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(account.id)
    .setIssuedAt()
    .setExpirationTime(ACCESS_TTL)
    .sign(SECRET);
}

/**
 * @param {string} token
 * @returns {Promise<{ id: string, role: string, name: string, email: string } | null>}
 */
export async function verifyAccessToken(token) {
  try {
    const { payload } = await jwtVerify(token, SECRET);
    return { id: String(payload.sub), role: payload.role, name: payload.name, email: payload.email };
  } catch {
    return null; // expired, tampered with, or signed by a rotated secret
  }
}

/**
 * Mint a refresh token and record its fingerprint.
 * @param {string} accountId
 * @returns {Promise<string>} The token to hand the browser. Never stored as-is.
 */
export async function issueRefreshToken(accountId) {
  const token = randomBytes(32).toString("base64url");
  await sql`
    INSERT INTO refresh_tokens (id, account_id, token_hash, expires_at)
    VALUES (${"rt_" + randomBytes(8).toString("hex")}, ${accountId}, ${fingerprint(token)},
            now() + ${`${REFRESH_DAYS} days`}::interval)
  `;
  return token;
}

/**
 * Spend a refresh token: validate it, revoke it, and report whose it was.
 *
 * Rotation is the point — a refresh token works exactly once.
 *
 * @param {string} token
 * @returns {Promise<string | null>} The account id, or null if unusable.
 */
export async function consumeRefreshToken(token) {
  if (!token) return null;
  const rows = await sql`
    UPDATE refresh_tokens SET revoked_at = now()
    WHERE token_hash = ${fingerprint(token)} AND revoked_at IS NULL AND expires_at > now()
    RETURNING account_id
  `;
  return rows[0]?.account_id ?? null;
}

/**
 * Revoke a refresh token on sign-out. Silent when it is already gone.
 * @param {string} token
 * @returns {Promise<void>}
 */
export async function revokeRefreshToken(token) {
  if (!token) return;
  await sql`
    UPDATE refresh_tokens SET revoked_at = now()
    WHERE token_hash = ${fingerprint(token)} AND revoked_at IS NULL
  `;
}

/**
 * Drop every refresh token for an account — used when an admin closes it.
 * @param {string} accountId
 * @returns {Promise<void>}
 */
export async function revokeAllForAccount(accountId) {
  await sql`UPDATE refresh_tokens SET revoked_at = now() WHERE account_id = ${accountId} AND revoked_at IS NULL`;
}
