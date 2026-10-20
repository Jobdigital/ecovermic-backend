import { Router } from "express";
import { randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";
import { db } from "#Infrastructure/database";

const scryptAsync = promisify(scrypt);

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_REGEX = /^(?=.*[A-Za-z])(?=.*[0-9]).{8,128}$/;

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
`);

const EMAIL_MAX_LENGTH = 254;

const router = Router();

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
        const errors: Record<string, { code: string; message: string }> = {};

        if (email === undefined || email === null || email === "") {
            errors.email = { code: "EMAIL_REQUIRED", message: "El correo electrónico es obligatorio" };
        } else if (
            typeof email !== "string" ||
            email.trim().length > EMAIL_MAX_LENGTH ||
            !EMAIL_REGEX.test(email.trim())
        ) {
            errors.email = { code: "EMAIL_INVALID", message: "El correo electrónico no es válido" };
        }

        if (password === undefined || password === null || password === "") {
            errors.password = { code: "PASSWORD_REQUIRED", message: "La contraseña es obligatoria" };
        } else if (typeof password !== "string" || !PASSWORD_REGEX.test(password)) {
            errors.password = {
                code: "PASSWORD_INVALID",
                message: "La contraseña debe tener entre 8 y 128 caracteres, con al menos una letra y un número",
            };
        }

        if (Object.keys(errors).length > 0) {
            res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Datos inválidos", fields: errors } });
            return;
        }

        const normalizedEmail = (email as string).trim().toLowerCase();
        const duplicated = {
            error: {
                code: "EMAIL_ALREADY_REGISTERED",
                message: "El correo electrónico ya está registrado",
                fields: { email: { code: "EMAIL_ALREADY_REGISTERED", message: "El correo electrónico ya está registrado" } },
            },
        };

        if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(normalizedEmail)) {
            res.status(409).json(duplicated);
            return;
        }

        const salt = randomBytes(16);
        const hash = (await scryptAsync(password as string, salt, 64)) as Buffer;
        const passwordHash = `${salt.toString("hex")}:${hash.toString("hex")}`;

        try {
            const { lastInsertRowid } = db
                .prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)")
                .run(normalizedEmail, passwordHash);
            res.status(201).json({ id: Number(lastInsertRowid), email: normalizedEmail });
        } catch (error) {
            // Condición de carrera: otro registro insertó el mismo correo entre el SELECT y el INSERT
            if (error instanceof Error && error.message.includes("UNIQUE")) {
                res.status(409).json(duplicated);
                return;
            }
            throw error;
        }
    } catch (error) {
        next(error);
    }
});

export default router;


