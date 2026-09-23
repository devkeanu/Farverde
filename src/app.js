/**
 * Express application.
 *
 * Exported as a factory so tests can mount it without binding a port.
 */
import express from "express";
import cors from "cors";
import { readSession } from "./middleware/auth.js";
import authRoutes from "./routes/auth.js";
import stateRoutes from "./routes/state.js";
import accountRoutes from "./routes/accounts.js";

/**
 * Origins allowed to call this API, from CORS_ORIGINS.
 * @returns {string[]}
 */
function allowedOrigins() {
  return String(process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

/** @returns {import('express').Express} */
export function createApp() {
  const app = express();
  const allowed = allowedOrigins();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));

  app.use(cors({
    // No cookies are involved — auth is a bearer token — but the allowlist
    // still matters: it is what stops another site's JavaScript calling this
    // API with a token it somehow obtained.
    origin(origin, cb) {
      if (!origin) return cb(null, true);          // curl, server-to-server, health checks
      if (allowed.includes(origin.replace(/\/$/, ""))) return cb(null, true);
      return cb(new Error(`Origin ${origin} is not allowed.`));
    },
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  }));

  app.use(readSession);

  app.get("/health", (_req, res) => res.json({ ok: true, service: "empaz-api" }));
  app.use("/auth", authRoutes);
  app.use("/state", stateRoutes);
  app.use("/accounts", accountRoutes);

  app.use((_req, res) => res.status(404).json({ error: "Not found." }));

  // Express 5 forwards rejected promises here, so async handlers need no try/catch.
  app.use((err, _req, res, _next) => {
    if (/is not allowed/.test(err?.message ?? "")) {
      return res.status(403).json({ error: "Origin not allowed." });
    }
    // A malformed body is the caller's mistake, not ours.
    if (err instanceof SyntaxError && "body" in err) {
      return res.status(400).json({ error: "Malformed JSON body." });
    }
    if (err?.type === "entity.too.large") {
      return res.status(413).json({ error: "Request body too large." });
    }
    console.error("[empaz-api]", err);
    return res.status(500).json({ error: "Something went wrong on our side." });
  });

  return app;
}
