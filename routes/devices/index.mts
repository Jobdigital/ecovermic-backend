import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import { verifyToken } from "#Application/auth";

export function createDevicesRouter(database: DatabaseSync) {
    const router = Router();

    router.use((req, res, next) => {
        if (process.env.DEV_DEVICE_LINKING !== "true") {
            res.status(404).json({ error: { code: "NOT_AVAILABLE", message: "Vinculación de desarrollo desactivada" } });
            return;
        }
        const match = /^Bearer ([^\s]+)$/i.exec(req.get("authorization") ?? "");
        const session = match ? verifyToken(match[1]) : null;
        if (!session || !database.prepare("SELECT 1 FROM users WHERE id = ? AND email_verified = 1").get(session.sub)) {
            res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Inicia sesión nuevamente" } });
            return;
        }
        res.locals.userId = session.sub;
        database.exec(`CREATE TABLE IF NOT EXISTS dev_device_links (
            device_id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id),
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        next();
    });

    router.post("/claim", (req, res) => {
        const body: unknown = req.body;
        if (typeof body !== "object" || body === null || Array.isArray(body) ||
            typeof (body as Record<string, unknown>).deviceId !== "string" ||
            !/^[0-9A-F]{12}$/.test((body as Record<string, string>).deviceId)) {
            res.status(400).json({ error: { code: "INVALID_DEVICE_ID", message: "ID de dispositivo inválido" } });
            return;
        }
        const deviceId = (body as Record<string, string>).deviceId;
        database.prepare("INSERT INTO dev_device_links (device_id, user_id) VALUES (?, ?) ON CONFLICT(device_id) DO NOTHING")
            .run(deviceId, res.locals.userId);
        const row = database.prepare("SELECT user_id FROM dev_device_links WHERE device_id = ?").get(deviceId) as { user_id: number };
        if (row.user_id !== res.locals.userId) {
            res.status(409).json({ error: { code: "DEVICE_ALREADY_LINKED", message: "El dispositivo ya está vinculado a otra cuenta" } });
            return;
        }
        res.json({ deviceId, linked: true, mode: "development" });
    });

    router.get("/", (_req, res) => {
        const devices = database.prepare("SELECT device_id AS deviceId FROM dev_device_links WHERE user_id = ? ORDER BY created_at, device_id")
            .all(res.locals.userId);
        res.json({ devices, mode: "development" });
    });

    return router;
}
