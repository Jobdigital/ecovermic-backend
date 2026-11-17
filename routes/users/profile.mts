import { Router } from "express";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { CODE_LENGTH, CODE_REGEX, COUNTRY_CODE_REGEX, EMAIL_MAX_LENGTH, EMAIL_REGEX, NAME_MAX, NAME_MIN, PHONE_REGEX } from "./validation.mts";

type Dependencies = {
    database: DatabaseSync;
    verifyToken: (token: string) => { sub: number } | null;
    passwordMatches: (password: string, hash: string) => Promise<boolean>;
    sendConfirmationCode: (email: string, name: string, code: string) => Promise<boolean>;
};

const codeTtl = 15 * 60 * 1000;
const cooldown = 60 * 1000;
const attemptWindow = 15 * 60 * 1000;
const maxAttempts = 5;

const error = (code: string, message: string) => ({ error: { code, message } });
const codeHash = (userId: number, email: string, code: string) =>
    createHash("sha256").update(`${userId}:${email}:${code}`).digest("hex");

type ProfileRow = {
    id: number;
    name: string | null;
    email: string;
    country_code: string | null;
    phone: string | null;
    password_hash: string;
};
type PendingRow = {
    email: string;
    code_hash: string;
    expires_at: number;
    attempts: number;
    sent_at: number;
};

export function createProfileRouter({ database, verifyToken, passwordMatches, sendConfirmationCode }: Dependencies) {
    const router = Router();
    database.exec(`
        CREATE TABLE IF NOT EXISTS pending_email_changes (
            user_id INTEGER PRIMARY KEY REFERENCES users(id),
            email TEXT NOT NULL,
            code_hash TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            sent_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS profile_password_attempts (
            user_id INTEGER PRIMARY KEY REFERENCES users(id),
            attempts INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
        );
    `);

    router.use((req, res, next) => {
        const match = /^Bearer ([^\s]+)$/i.exec(req.get("authorization") ?? "");
        const session = match ? verifyToken(match[1]) : null;
        const user = session && database.prepare(
            "SELECT id, name, email, country_code, phone, password_hash FROM users WHERE id = ? AND email_verified = 1",
        ).get(session.sub) as ProfileRow | undefined;
        if (!user) {
            res.status(401).json(error("UNAUTHORIZED", "Inicia sesión nuevamente"));
            return;
        }
        res.locals.user = user;
        next();
    });

    const profile = (userId: number) => {
        const user = database.prepare(
            "SELECT name, email, country_code, phone FROM users WHERE id = ?",
        ).get(userId) as Pick<ProfileRow, "name" | "email" | "country_code" | "phone">;
        const pending = database.prepare(
            "SELECT email FROM pending_email_changes WHERE user_id = ? AND expires_at > ?",
        ).get(userId, Date.now()) as { email: string } | undefined;
        return {
            user: { name: user.name, email: user.email, countryCode: user.country_code, phone: user.phone },
            pendingEmail: pending?.email ?? null,
        };
    };

    router.get("/", (_req, res) => res.json(profile((res.locals.user as ProfileRow).id)));

    router.post("/", (req, res) => {
        const body: unknown = req.body;
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
            res.status(400).json(error("INVALID_BODY", "Se espera un perfil válido"));
            return;
        }
        const { name, countryCode, phone } = body as Record<string, unknown>;
        if (typeof name !== "string" || name.trim().length < NAME_MIN || name.trim().length > NAME_MAX ||
            typeof countryCode !== "string" || !COUNTRY_CODE_REGEX.test(countryCode.trim()) ||
            typeof phone !== "string" || !PHONE_REGEX.test(phone.trim())) {
            res.status(400).json(error("VALIDATION_ERROR", "Revisa el nombre, la clave de país y el teléfono"));
            return;
        }
        const user = res.locals.user as ProfileRow;
        database.prepare("UPDATE users SET name = ?, country_code = ?, phone = ? WHERE id = ?")
            .run(name.trim(), countryCode.trim(), phone.trim(), user.id);
        res.json(profile(user.id));
    });

    router.post("/email/request", async (req, res, next) => {
        try {
            const body: unknown = req.body;
            if (typeof body !== "object" || body === null || Array.isArray(body)) {
                res.status(400).json(error("INVALID_BODY", "Se espera el correo nuevo y la contraseña"));
                return;
            }
            const { email, password } = body as Record<string, unknown>;
            if (typeof email !== "string" || email.trim().length > EMAIL_MAX_LENGTH || !EMAIL_REGEX.test(email.trim()) ||
                typeof password !== "string" || password.length === 0 || password.length > 128) {
                res.status(400).json(error("VALIDATION_ERROR", "Revisa el correo nuevo y la contraseña"));
                return;
            }
            const user = res.locals.user as ProfileRow;
            const now = Date.now();
            const limit = database.prepare(
                "SELECT attempts, expires_at FROM profile_password_attempts WHERE user_id = ?",
            ).get(user.id) as { attempts: number; expires_at: number } | undefined;
            if (limit && limit.expires_at > now && limit.attempts >= maxAttempts) {
                res.status(429).json(error("TOO_MANY_ATTEMPTS", "Demasiados intentos. Inténtalo más tarde"));
                return;
            }
            database.prepare(`
                INSERT INTO profile_password_attempts (user_id, attempts, expires_at) VALUES (?, 1, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    attempts = CASE WHEN expires_at <= ? THEN 1 ELSE attempts + 1 END,
                    expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END
            `).run(user.id, now + attemptWindow, now, now);
            if (!await passwordMatches(password, user.password_hash)) {
                res.status(401).json(error("INVALID_PASSWORD", "La contraseña actual no es correcta"));
                return;
            }
            database.prepare("DELETE FROM profile_password_attempts WHERE user_id = ?").run(user.id);
            const normalizedEmail = email.trim().toLowerCase();
            if (normalizedEmail === user.email) {
                res.status(400).json(error("EMAIL_UNCHANGED", "El correo nuevo coincide con el actual"));
                return;
            }
            if (database.prepare("SELECT 1 FROM users WHERE email = ?").get(normalizedEmail)) {
                res.status(409).json(error("EMAIL_ALREADY_REGISTERED", "El correo electrónico ya está registrado"));
                return;
            }
            const pending = database.prepare("SELECT sent_at FROM pending_email_changes WHERE user_id = ?")
                .get(user.id) as { sent_at: number } | undefined;
            if (pending && pending.sent_at + cooldown > Date.now()) {
                res.status(429).json(error("RESEND_TOO_SOON", "Espera antes de solicitar otro código"));
                return;
            }
            const code = String(randomInt(0, 1_000_000)).padStart(CODE_LENGTH, "0");
            const hash = codeHash(user.id, normalizedEmail, code);
            database.prepare(`
                INSERT INTO pending_email_changes (user_id, email, code_hash, expires_at, attempts, sent_at)
                VALUES (?, ?, ?, ?, 0, ?)
                ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, code_hash = excluded.code_hash,
                    expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at
            `).run(user.id, normalizedEmail, hash, now + codeTtl, now);
            if (!await sendConfirmationCode(normalizedEmail, user.name ?? "", code)) {
                database.prepare("DELETE FROM pending_email_changes WHERE user_id = ? AND code_hash = ?")
                    .run(user.id, hash);
                res.status(502).json(error("EMAIL_SEND_FAILED", "No se pudo enviar el código. Inténtalo más tarde"));
                return;
            }
            res.json({ pendingEmail: normalizedEmail });
        } catch (cause) {
            next(cause);
        }
    });

    router.post("/email/confirm", (req, res, next) => {
        try {
            const body: unknown = req.body;
            const code = typeof body === "object" && body !== null && !Array.isArray(body)
                ? (body as Record<string, unknown>).code : undefined;
            if (typeof code !== "string" || !CODE_REGEX.test(code.trim())) {
                res.status(400).json(error("CODE_INVALID_FORMAT", "El código debe tener 6 dígitos"));
                return;
            }
            const user = res.locals.user as ProfileRow;
            const pending = database.prepare("SELECT * FROM pending_email_changes WHERE user_id = ?")
                .get(user.id) as PendingRow | undefined;
            if (!pending) {
                res.status(400).json(error("CONFIRMATION_CODE_INVALID", "No hay un cambio de correo pendiente"));
                return;
            }
            if (pending.attempts >= maxAttempts) {
                res.status(429).json(error("TOO_MANY_ATTEMPTS", "Demasiados intentos. Solicita un código nuevo"));
                return;
            }
            if (pending.expires_at <= Date.now()) {
                res.status(410).json(error("CONFIRMATION_CODE_EXPIRED", "El código expiró. Solicita uno nuevo"));
                return;
            }
            const expected = Buffer.from(pending.code_hash, "hex");
            const actual = Buffer.from(codeHash(user.id, pending.email, code.trim()), "hex");
            if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
                database.prepare("UPDATE pending_email_changes SET attempts = attempts + 1 WHERE user_id = ?").run(user.id);
                res.status(400).json(error("CONFIRMATION_CODE_INVALID", "El código de confirmación no es válido"));
                return;
            }
            if (database.prepare("SELECT 1 FROM users WHERE email = ?").get(pending.email)) {
                res.status(409).json(error("EMAIL_ALREADY_REGISTERED", "El correo electrónico ya está registrado"));
                return;
            }
            database.exec("BEGIN");
            try {
                database.prepare("UPDATE users SET email = ? WHERE id = ?").run(pending.email, user.id);
                database.prepare("DELETE FROM pending_email_changes WHERE user_id = ?").run(user.id);
                database.exec("COMMIT");
            } catch (cause) {
                database.exec("ROLLBACK");
                throw cause;
            }
            res.json(profile(user.id));
        } catch (cause) {
            next(cause);
        }
    });

    return router;
}
