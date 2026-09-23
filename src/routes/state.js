/**
 * GET /state — everything the caller is allowed to see.
 *
 * An admin gets every client plus the audit trail; a client gets only their
 * own account. One endpoint means the frontend store can resync with a single
 * request after any mutation.
 */
import { Router } from "express";
import { sql, toAccount } from "../db.js";
import { requireSession } from "../middleware/auth.js";

const router = Router();

router.get("/", requireSession, async (req, res) => {
  if (req.session.role === "admin") {
    const [clients, auditLog] = await Promise.all([
      sql`SELECT * FROM accounts WHERE role = 'client' ORDER BY created_at ASC`,
      sql`SELECT id, at, action, detail, actor FROM audit_log ORDER BY at DESC LIMIT 60`,
    ]);
    return res.json({ clients: clients.map(toAccount), auditLog });
  }

  const rows = await sql`SELECT * FROM accounts WHERE id = ${req.session.id}`;
  if (!rows.length) return res.status(404).json({ error: "Account not found." });
  return res.json({ clients: [toAccount(rows[0])], auditLog: [] });
});

export default router;
