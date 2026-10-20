import { Router } from "express";
import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { db } from "#Infrastructure/database";
import { sendMail } from "#Infrastructure/mailer";
import { getAccess } from "#Application/access";
import { signToken } from "#Application/auth";

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
const CONFIRMATION_TTL_MS = 15 * 60 * 1000;
const CODE_LENGTH = 6;
const CODE_REGEX = /^[0-9]{6}$/;
const MAX_CODE_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;

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
    confirmation_code_hash: "TEXT",
    confirmation_expires_at: "INTEGER",
    confirmation_attempts: "INTEGER NOT NULL DEFAULT 0",
    confirmation_sent_at: "INTEGER",
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

const generateCode = () => String(randomInt(0, 1_000_000)).padStart(CODE_LENGTH, "0");
// El código se liga al correo para que el mismo código en dos cuentas no produzca el mismo hash
const hashCode = (email: string, code: string) => sha256(`${email}:${code}`);

async function sendConfirmationCode(email: string, name: string, code: string): Promise<boolean> {
    const minutes = CONFIRMATION_TTL_MS / 60000;
    try {
        await sendMail(
            email,
            "Tu código de confirmación de Ecovermic",
            `Hola ${name}, tu código de confirmación es: ${code}\nExpira en ${minutes} minutos.`,
            `<p>Hola ${escapeHtml(name)}, tu código de confirmación es:</p>` +
                `<p style="font-size:24px;letter-spacing:4px"><strong>${code}</strong></p>` +
                `<p>Expira en ${minutes} minutos.</p>`,
        );
        return true;
    } catch (error) {
        console.error("No se pudo enviar el correo de confirmación:", error);
        return false;
    }
}

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

        const confirmationCode = generateCode();
        let userId: number;

        try {
            db.exec("BEGIN");
            const { lastInsertRowid } = db
                .prepare(
                    `INSERT INTO users (email, password_hash, name, age, gender, country_code, phone,
                                        email_verified, confirmation_code_hash, confirmation_expires_at,
                                        confirmation_attempts, confirmation_sent_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, ?)`,
                )
                .run(
                    pending.email,
                    pending.password_hash,
                    (name as string).trim(),
                    age as number,
                    gender as string,
                    (countryCode as string).trim(),
                    (phone as string).trim(),
                    hashCode(pending.email, confirmationCode),
                    Date.now() + CONFIRMATION_TTL_MS,
                    Date.now(),
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

        const emailSent = await sendConfirmationCode(pending.email, (name as string).trim(), confirmationCode);

        res.status(201).json({
            id: userId,
            email: pending.email,
            emailSent,
            access: getAccess(age as number, false),
            ...(emailSent ? {} : { warning: "Cuenta creada, pero no se pudo enviar el código. Solicita uno nuevo" }),
        });
    } catch (error) {
        next(error);
    }
});

type ConfirmationRow = {
    id: number;
    name: string | null;
    email_verified: number;
    confirmation_code_hash: string | null;
    confirmation_expires_at: number | null;
    confirmation_attempts: number;
    confirmation_sent_at: number | null;
};

const findForConfirmation = (email: string) =>
    db
        .prepare(
            `SELECT id, name, email_verified, confirmation_code_hash, confirmation_expires_at,
                    confirmation_attempts, confirmation_sent_at
             FROM users WHERE email = ?`,
        )
        .get(email) as ConfirmationRow | undefined;

const codeInvalid = {
    error: { code: "CONFIRMATION_CODE_INVALID", message: "El código de confirmación no es válido" },
};

// Confirmación de cuenta con el código de 6 dígitos recibido por correo
router.post("/confirm", (req, res, next) => {
    try {
        const body = req.body;
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
            res.status(400).json({
                error: { code: "INVALID_BODY", message: "Se espera un JSON con email y code" },
            });
            return;
        }

        const { email, code } = body as Record<string, unknown>;
        const errors: FieldErrors = {};
        if (isEmpty(email) || typeof email !== "string") {
            errors.email = { code: "EMAIL_REQUIRED", message: "El correo electrónico es obligatorio" };
        }
        if (isEmpty(code)) {
            errors.code = { code: "CODE_REQUIRED", message: "El código es obligatorio" };
        } else if (typeof code !== "string" || !CODE_REGEX.test(code.trim())) {
            errors.code = { code: "CODE_INVALID_FORMAT", message: `El código debe tener ${CODE_LENGTH} dígitos numéricos` };
        }
        if (Object.keys(errors).length > 0) {
            res.status(400).json(validationError(errors));
            return;
        }

        const normalizedEmail = (email as string).trim().toLowerCase();
        const user = findForConfirmation(normalizedEmail);

        // Mismo error para correo inexistente o sin código pendiente, para no revelar qué cuentas existen
        if (!user || (!user.email_verified && !user.confirmation_code_hash)) {
            res.status(400).json(codeInvalid);
            return;
        }

        if (user.email_verified) {
            res.json({ message: "La cuenta ya estaba confirmada" });
            return;
        }

        if (user.confirmation_attempts >= MAX_CODE_ATTEMPTS) {
            res.status(429).json({
                error: {
                    code: "TOO_MANY_ATTEMPTS",
                    message: "Demasiados intentos fallidos. Solicita un código nuevo",
                },
            });
            return;
        }

        if ((user.confirmation_expires_at ?? 0) < Date.now()) {
            res.status(410).json({
                error: { code: "CONFIRMATION_CODE_EXPIRED", message: "El código expiró. Solicita uno nuevo" },
            });
            return;
        }

        const expected = Buffer.from(user.confirmation_code_hash!);
        const received = Buffer.from(hashCode(normalizedEmail, (code as string).trim()));
        if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
            db.prepare("UPDATE users SET confirmation_attempts = confirmation_attempts + 1 WHERE id = ?").run(user.id);
            res.status(400).json(codeInvalid);
            return;
        }

        db.prepare(
            `UPDATE users SET email_verified = 1, confirmation_code_hash = NULL, confirmation_expires_at = NULL,
                    confirmation_attempts = 0 WHERE id = ?`,
        ).run(user.id);

        res.json({ message: "Cuenta confirmada correctamente" });
    } catch (error) {
        next(error);
    }
});

// Reenvío de un código nuevo (invalida el anterior)
router.post("/confirm/resend", async (req, res, next) => {
    try {
        const body = req.body;
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
            res.status(400).json({
                error: { code: "INVALID_BODY", message: "Se espera un JSON con email" },
            });
            return;
        }

        const { email } = body as Record<string, unknown>;
        if (isEmpty(email) || typeof email !== "string") {
            res.status(400).json(
                validationError({ email: { code: "EMAIL_REQUIRED", message: "El correo electrónico es obligatorio" } }),
            );
            return;
        }

        const normalizedEmail = email.trim().toLowerCase();
        const user = findForConfirmation(normalizedEmail);

        // Respuesta idéntica exista o no la cuenta, para no revelar qué correos están registrados
        const accepted = { message: "Si la cuenta existe y no está confirmada, se envió un código nuevo" };

        if (!user || user.email_verified) {
            res.json(accepted);
            return;
        }

        const wait = (user.confirmation_sent_at ?? 0) + RESEND_COOLDOWN_MS - Date.now();
        if (wait > 0) {
            res.status(429).json({
                error: {
                    code: "RESEND_TOO_SOON",
                    message: `Espera ${Math.ceil(wait / 1000)} segundos antes de solicitar otro código`,
                },
            });
            return;
        }

        const code = generateCode();
        db.prepare(
            `UPDATE users SET confirmation_code_hash = ?, confirmation_expires_at = ?, confirmation_attempts = 0,
                    confirmation_sent_at = ? WHERE id = ?`,
        ).run(hashCode(normalizedEmail, code), Date.now() + CONFIRMATION_TTL_MS, Date.now(), user.id);

        const sent = await sendConfirmationCode(normalizedEmail, user.name ?? "", code);
        if (!sent) {
            res.status(502).json({
                error: { code: "EMAIL_SEND_FAILED", message: "No se pudo enviar el correo. Inténtalo más tarde" },
            });
            return;
        }

        res.json(accepted);
    } catch (error) {
        next(error);
    }
});

// Login: solo cuentas con correo confirmado
const DUMMY_HASH = `${"00".repeat(16)}:${"00".repeat(64)}`;

async function passwordMatches(password: string, stored: string): Promise<boolean> {
    const [saltHex, hashHex] = stored.split(":");
    const expected = Buffer.from(hashHex ?? "", "hex");
    const actual = (await scryptAsync(password, Buffer.from(saltHex ?? "", "hex"), 64)) as Buffer;
    return expected.length === actual.length && timingSafeEqual(expected, actual);
}

router.post("/login", async (req, res, next) => {
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
        if (isEmpty(email) || typeof email !== "string") {
            errors.email = { code: "EMAIL_REQUIRED", message: "El correo electrónico es obligatorio" };
        }
        if (isEmpty(password) || typeof password !== "string") {
            errors.password = { code: "PASSWORD_REQUIRED", message: "La contraseña es obligatoria" };
        }
        if (Object.keys(errors).length > 0) {
            res.status(400).json(validationError(errors));
            return;
        }

        const user = db
            .prepare("SELECT id, email, name, age, age_verified, email_verified, password_hash FROM users WHERE email = ?")
            .get((email as string).trim().toLowerCase()) as
            | {
                  id: number;
                  email: string;
                  name: string | null;
                  age: number | null;
                  age_verified: number;
                  email_verified: number;
                  password_hash: string;
              }
            | undefined;

        // Se compara siempre contra un hash para no revelar por tiempo si el correo existe
        const valid = await passwordMatches((password as string), user?.password_hash ?? DUMMY_HASH);
        if (!user || !valid) {
            res.status(401).json({
                error: { code: "INVALID_CREDENTIALS", message: "Correo electrónico o contraseña incorrectos" },
            });
            return;
        }

        if (!user.email_verified) {
            res.status(403).json({
                error: {
                    code: "ACCOUNT_NOT_VERIFIED",
                    message: "Debes confirmar tu correo electrónico antes de iniciar sesión",
                },
            });
            return;
        }

        res.json({
            token: signToken(user.id),
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                access: getAccess(user.age ?? 0, user.age_verified === 1),
            },
        });
    } catch (error) {
        next(error);
    }
});

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export default router;
