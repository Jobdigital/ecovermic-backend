import { Router } from "express";
import { createHash, randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";
import { db } from "#Infrastructure/database";
import { sendMail } from "#Infrastructure/mailer";
import { getAccess } from "#Application/access";

const scryptAsync = promisify(scrypt);

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_REGEX = /^(?=.*[A-Za-z])(?=.*[0-9]).{8,128}$/;
const EMAIL_MAX_LENGTH = 254;
const COUNTRY_CODE_REGEX = /^\+[1-9][0-9]{0,3}$/;
const PHONE_REGEX = /^[0-9]{10}$/;
const GENDERS = ["Mujer", "Hombre", "No binario", "Otro"];
const NAME_MIN = 2;
const NAME_MAX = 30;
const AGE_MIN = 1;
const AGE_MAX = 120;

const PENDING_TTL_MS = 60 * 60 * 1000;
const CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS pending_registrations (
        email TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL
    );
`);

// Migración: agrega las columnas del perfil a una tabla users creada en el paso 1
const existingColumns = new Set(
    (db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map(c => c.name),
);
const newColumns: Record<string, string> = {
    name: "TEXT",
    age: "INTEGER",
    gender: "TEXT",
    country_code: "TEXT",
    phone: "TEXT",
    email_verified: "INTEGER NOT NULL DEFAULT 0",
    age_verified: "INTEGER NOT NULL DEFAULT 0",
    confirmation_token_hash: "TEXT",
    confirmation_expires_at: "INTEGER",
};
for (const [column, definition] of Object.entries(newColumns)) {
    if (!existingColumns.has(column)) db.exec(`ALTER TABLE users ADD COLUMN ${column} ${definition}`);
}

type FieldError = { code: string; message: string };
type FieldErrors = Record<string, FieldError>;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const isEmpty = (value: unknown) => value === undefined || value === null || value === "";

const validationError = (fields: FieldErrors) => ({
    error: { code: "VALIDATION_ERROR", message: "Datos inválidos", fields },
});

const duplicatedEmail = {
    error: {
        code: "EMAIL_ALREADY_REGISTERED",
        message: "El correo electrónico ya está registrado",
        fields: { email: { code: "EMAIL_ALREADY_REGISTERED", message: "El correo electrónico ya está registrado" } },
    },
};

const baseUrl = () => {
    const host = process.env.HOST || "127.0.0.1";
    const port = process.env.PORT || 3000;
    return (process.env.APP_URL || `http://${host}:${port}`).replace(/\/$/, "");
};

const router = Router();

// Paso 1: correo y contraseña. Guarda un registro pendiente y devuelve el token para el paso 2.
router.post("/register", async (req, res, next) => {
    try {
        const body = req.body;
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
            res.status(400).json({
                error: { code: "INVALID_BODY", message: "Se espera un JSON con email y password" },
            });
            return;
        }

        const { email, password } = body as Record<string, unknown>;
        const errors: FieldErrors = {};

        if (isEmpty(email)) {
            errors.email = { code: "EMAIL_REQUIRED", message: "El correo electrónico es obligatorio" };
        } else if (
            typeof email !== "string" ||
            email.trim().length > EMAIL_MAX_LENGTH ||
            !EMAIL_REGEX.test(email.trim())
        ) {
            errors.email = { code: "EMAIL_INVALID", message: "El correo electrónico no es válido" };
        }

        if (isEmpty(password)) {
            errors.password = { code: "PASSWORD_REQUIRED", message: "La contraseña es obligatoria" };
        } else if (typeof password !== "string" || !PASSWORD_REGEX.test(password)) {
            errors.password = {
                code: "PASSWORD_INVALID",
                message: "La contraseña debe tener entre 8 y 128 caracteres, con al menos una letra y un número",
            };
        }

        if (Object.keys(errors).length > 0) {
            res.status(400).json(validationError(errors));
            return;
        }

        const normalizedEmail = (email as string).trim().toLowerCase();

        if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(normalizedEmail)) {
            res.status(409).json(duplicatedEmail);
            return;
        }

        const salt = randomBytes(16);
        const hash = (await scryptAsync(password as string, salt, 64)) as Buffer;
        const passwordHash = `${salt.toString("hex")}:${hash.toString("hex")}`;

        const registrationToken = randomBytes(32).toString("hex");
        // Si el mismo correo reinicia el paso 1, el registro pendiente anterior se reemplaza
        db.prepare(
            `INSERT OR REPLACE INTO pending_registrations (email, password_hash, token_hash, expires_at)
             VALUES (?, ?, ?, ?)`,
        ).run(normalizedEmail, passwordHash, sha256(registrationToken), Date.now() + PENDING_TTL_MS);

        res.status(201).json({ registrationToken, email: normalizedEmail });
    } catch (error) {
        next(error);
    }
});

// Paso 2: perfil. Crea el usuario y envía el correo de confirmación.
router.post("/register/profile", async (req, res, next) => {
    try {
        const body = req.body;
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
            res.status(400).json({
                error: { code: "INVALID_BODY", message: "Se espera un JSON con los datos del perfil" },
            });
            return;
        }

        const { registrationToken, name, age, gender, countryCode, phone } = body as Record<string, unknown>;
        const errors: FieldErrors = {};

        if (isEmpty(registrationToken) || typeof registrationToken !== "string") {
            errors.registrationToken = { code: "TOKEN_REQUIRED", message: "El token de registro es obligatorio" };
        }

        if (isEmpty(name)) {
            errors.name = { code: "NAME_REQUIRED", message: "El nombre o apodo es obligatorio" };
        } else if (
            typeof name !== "string" ||
            name.trim().length < NAME_MIN ||
            name.trim().length > NAME_MAX
        ) {
            errors.name = {
                code: "NAME_INVALID",
                message: `El nombre o apodo debe tener entre ${NAME_MIN} y ${NAME_MAX} caracteres`,
            };
        }

        if (isEmpty(age)) {
            errors.age = { code: "AGE_REQUIRED", message: "La edad es obligatoria" };
        } else if (typeof age !== "number" || !Number.isInteger(age) || age < AGE_MIN || age > AGE_MAX) {
            errors.age = {
                code: "AGE_INVALID",
                message: `La edad debe ser un número entero entre ${AGE_MIN} y ${AGE_MAX}`,
            };
        }

        if (isEmpty(gender)) {
            errors.gender = { code: "GENDER_REQUIRED", message: "El género es obligatorio" };
        } else if (typeof gender !== "string" || !GENDERS.includes(gender)) {
            errors.gender = { code: "GENDER_INVALID", message: `El género debe ser: ${GENDERS.join(", ")}` };
        }

        if (isEmpty(countryCode)) {
            errors.countryCode = { code: "COUNTRY_CODE_REQUIRED", message: "La clave de país es obligatoria" };
        } else if (typeof countryCode !== "string" || !COUNTRY_CODE_REGEX.test(countryCode.trim())) {
            errors.countryCode = { code: "COUNTRY_CODE_INVALID", message: "La clave de país no es válida (ej. +52)" };
        }

        if (isEmpty(phone)) {
            errors.phone = { code: "PHONE_REQUIRED", message: "El número de teléfono es obligatorio" };
        } else if (typeof phone !== "string" || !PHONE_REGEX.test(phone.trim())) {
            errors.phone = { code: "PHONE_INVALID", message: "El número de teléfono debe tener 10 dígitos" };
        }

        if (Object.keys(errors).length > 0) {
            res.status(400).json(validationError(errors));
            return;
        }

        const pending = db
            .prepare("SELECT email, password_hash, expires_at FROM pending_registrations WHERE token_hash = ?")
            .get(sha256(registrationToken as string)) as
            | { email: string; password_hash: string; expires_at: number }
            | undefined;

        if (!pending) {
            res.status(401).json({
                error: { code: "REGISTRATION_TOKEN_INVALID", message: "El token de registro no es válido" },
            });
            return;
        }

        if (pending.expires_at < Date.now()) {
            db.prepare("DELETE FROM pending_registrations WHERE email = ?").run(pending.email);
            res.status(410).json({
                error: {
                    code: "REGISTRATION_EXPIRED",
                    message: "El registro expiró, vuelve a iniciar con tu correo y contraseña",
                },
            });
            return;
        }

        if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(pending.email)) {
            db.prepare("DELETE FROM pending_registrations WHERE email = ?").run(pending.email);
            res.status(409).json(duplicatedEmail);
            return;
        }

        const confirmationToken = randomBytes(32).toString("hex");
        let userId: number;

        try {
            db.exec("BEGIN");
            const { lastInsertRowid } = db
                .prepare(
                    `INSERT INTO users (email, password_hash, name, age, gender, country_code, phone,
                                        email_verified, confirmation_token_hash, confirmation_expires_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
                )
                .run(
                    pending.email,
                    pending.password_hash,
                    (name as string).trim(),
                    age as number,
                    gender as string,
                    (countryCode as string).trim(),
                    (phone as string).trim(),
                    sha256(confirmationToken),
                    Date.now() + CONFIRMATION_TTL_MS,
                );
            db.prepare("DELETE FROM pending_registrations WHERE email = ?").run(pending.email);
            db.exec("COMMIT");
            userId = Number(lastInsertRowid);
        } catch (error) {
            db.exec("ROLLBACK");
            if (error instanceof Error && error.message.includes("UNIQUE")) {
                res.status(409).json(duplicatedEmail);
                return;
            }
            throw error;
        }

        const link = `${baseUrl()}/users/confirm?token=${confirmationToken}`;
        let emailSent = true;
        try {
            await sendMail(
                pending.email,
                "Confirma tu cuenta de Ecovermic",
                `Hola ${(name as string).trim()}, confirma tu cuenta ingresando a: ${link}\nEl enlace expira en 24 horas.`,
                `<p>Hola ${escapeHtml((name as string).trim())}, confirma tu cuenta:</p>` +
                    `<p><a href="${link}">Confirmar cuenta</a></p><p>El enlace expira en 24 horas.</p>`,
            );
        } catch (error) {
            emailSent = false;
            console.error("No se pudo enviar el correo de confirmación:", error);
        }

        res.status(201).json({
            id: userId,
            email: pending.email,
            emailSent,
            access: getAccess(age as number, false),
            ...(emailSent ? {} : { warning: "Cuenta creada, pero no se pudo enviar el correo de confirmación" }),
        });
    } catch (error) {
        next(error);
    }
});

// Confirmación de cuenta desde el enlace del correo
router.get("/confirm", (req, res, next) => {
    try {
        const token = req.query.token;
        if (typeof token !== "string" || token === "") {
            res.status(400).json({
                error: { code: "TOKEN_REQUIRED", message: "El token de confirmación es obligatorio" },
            });
            return;
        }

        const user = db
            .prepare("SELECT id, email_verified, confirmation_expires_at FROM users WHERE confirmation_token_hash = ?")
            .get(sha256(token)) as
            | { id: number; email_verified: number; confirmation_expires_at: number }
            | undefined;

        if (!user) {
            res.status(400).json({
                error: { code: "CONFIRMATION_TOKEN_INVALID", message: "El enlace de confirmación no es válido" },
            });
            return;
        }

        if (user.confirmation_expires_at < Date.now()) {
            res.status(410).json({
                error: { code: "CONFIRMATION_TOKEN_EXPIRED", message: "El enlace de confirmación expiró" },
            });
            return;
        }

        db.prepare(
            "UPDATE users SET email_verified = 1, confirmation_token_hash = NULL, confirmation_expires_at = NULL WHERE id = ?",
        ).run(user.id);

        res.json({ message: "Cuenta confirmada correctamente" });
    } catch (error) {
        next(error);
    }
});

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export default router;
