/**
 * Sign-up, sign-in, refresh, sign-out.
 */
import { Router } from "express";
import bcrypt from "bcryptjs";
import { sql, toAccount, audit } from "../db.js";
import {
  issueAccessToken, issueRefreshToken, consumeRefreshToken, revokeRefreshToken,
} from "../tokens.js";
import { requireSession } from "../middleware/auth.js";

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CURRENCIES = ["USD", "GBP", "EUR"];
const ZERO_BALANCES = { credit: 0, withdraw: 0, outstanding: 0, loan: 0 };
const FLAT_HISTORY = {
  credit: Array(12).fill(0),
  withdraw: Array(12).fill(0),
  outstanding: Array(12).fill(0),
  loan: Array(12).fill(0),
};

/** @returns {string} A client reference such as `EMPZ-004182`. */
const newAccountId = () => `EMPZ-${String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0")}`;

/**
 * Issue a fresh token pair for an account.
 * @param {{ id: string, role: string, name: string, email: string, status: string }} account
 */
async function grant(account) {
  const [accessToken, refreshToken] = await Promise.all([
    issueAccessToken(account),
    issueRefreshToken(account.id),
  ]);
  return {
    accessToken,
    refreshToken,
    session: { id: account.id, role: account.role, name: account.name, email: account.email },
    status: account.status,
  };
}

/* ---- POST /auth/signup ------------------------------------------- */
router.post("/signup", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");
  const currency = CURRENCIES.includes(req.body?.currency) ? req.body.currency : "USD";

  if (name.length < 2) return res.status(422).json({ error: "Enter your full name.", field: "name" });
  if (!EMAIL_RE.test(email)) return res.status(422).json({ error: "Enter a valid email address.", field: "email" });
  if (password.length < 8) return res.status(422).json({ error: "Use at least 8 characters.", field: "password" });

  const existing = await sql`SELECT 1 FROM accounts WHERE lower(email) = ${email}`;
  if (existing.length) {
    return res.status(409).json({ error: "An account already uses that email.", field: "email" });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  // The id is random, so retry the rare collision rather than serialising on a sequence.
  let account = null;
  for (let attempt = 0; attempt < 5 && !account; attempt += 1) {
    try {
      const rows = await sql`
        INSERT INTO accounts (id, role, name, email, password_hash, status, tier, currency, leverage,
                              credit_limit, notice, balances, history, holdings, transactions)
        VALUES (${newAccountId()}, 'client', ${name}, ${email}, ${passwordHash}, 'Pending', 'Standard',
                ${currency}, '1:20', 0, '', ${JSON.stringify(ZERO_BALANCES)}, ${JSON.stringify(FLAT_HISTORY)},
                '[]', '[]')
        RETURNING id, role, name, email, status
      `;
      account = rows[0];
    } catch (err) {
      if (!String(err?.message ?? "").includes("accounts_pkey")) throw err;
    }
  }
  if (!account) return res.status(500).json({ error: "Could not allocate an account reference. Try again." });

  await audit("Account opened", `${name} · ${account.id} · awaiting approval`, name);
  return res.status(201).json(await grant(account));
});

/* ---- POST /auth/login -------------------------------------------- */
router.post("/login", async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");
  if (!email || !password) return res.status(422).json({ error: "Enter your email and password." });

  const rows = await sql`
    SELECT id, role, name, email, status, password_hash FROM accounts WHERE lower(email) = ${email}
  `;
  const account = rows[0];

  // Hash a throwaway value when the email is unknown so both paths cost the
  // same, and the response cannot be used to enumerate registered addresses.
  const ok = account
    ? await bcrypt.compare(password, account.password_hash)
    : await bcrypt.compare(password, "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin");

  if (!account || !ok) {
    return res.status(401).json({ error: "Those credentials don’t match a Farverde account." });
  }
  if (account.status === "Closed") {
    return res.status(403).json({ error: "This account is closed. Contact your relationship desk." });
  }

  return res.json(await grant(account));
});

/* ---- POST /auth/refresh ------------------------------------------ */
router.post("/refresh", async (req, res) => {
  const accountId = await consumeRefreshToken(String(req.body?.refreshToken ?? ""));
  if (!accountId) return res.status(401).json({ error: "Session expired. Sign in again." });

  const rows = await sql`SELECT id, role, name, email, status FROM accounts WHERE id = ${accountId}`;
  if (!rows.length) return res.status(401).json({ error: "Session expired. Sign in again." });

  return res.json(await grant(rows[0]));
});

/* ---- POST /auth/logout ------------------------------------------- */
router.post("/logout", async (req, res) => {
  await revokeRefreshToken(String(req.body?.refreshToken ?? ""));
  return res.json({ ok: true });
});

/* ---- GET /auth/me ------------------------------------------------ */
router.get("/me", requireSession, async (req, res) => {
  const rows = await sql`SELECT * FROM accounts WHERE id = ${req.session.id}`;
  if (!rows.length) return res.status(401).json({ error: "Account no longer exists." });
  const account = toAccount(rows[0]);
  return res.json({
    session: { id: account.id, role: account.role, name: account.name, email: account.email },
    status: account.status,
  });
});

export default router;
