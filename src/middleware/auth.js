/**
 * Bearer-token guards.
 */
import { verifyAccessToken } from "../tokens.js";

/**
 * Attach `req.session` when a valid access token is present. Does not reject —
 * that is `requireSession`'s job, so optional routes can stay open.
 *
 * @type {import('express').RequestHandler}
 */
export async function readSession(req, _res, next) {
  const header = req.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  req.session = token ? await verifyAccessToken(token) : null;
  next();
}

/** @type {import('express').RequestHandler} Reject anonymous callers. */
export function requireSession(req, res, next) {
  if (!req.session) return res.status(401).json({ error: "Not signed in." });
  next();
}

/** @type {import('express').RequestHandler} Reject anyone who is not an admin. */
export function requireAdmin(req, res, next) {
  if (!req.session) return res.status(401).json({ error: "Not signed in." });
  if (req.session.role !== "admin") return res.status(403).json({ error: "Admin access only." });
  next();
}
