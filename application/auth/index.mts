import jwt from "jsonwebtoken";
import { randomBytes } from "node:crypto";

process.loadEnvFile();

const TOKEN_TTL = "7d";
const ALGORITHM = "HS256";

let secret = process.env.AUTH_SECRET;
if (!secret) {
    // Sin AUTH_SECRET los tokens dejan de ser válidos al reiniciar el servidor
    secret = randomBytes(32).toString("hex");
    console.warn("AUTH_SECRET no está definido: se usa un secreto temporal.");
}

export function signToken(userId: number): string {
    return jwt.sign({}, secret!, { algorithm: ALGORITHM, subject: String(userId), expiresIn: TOKEN_TTL });
}

export function verifyToken(token: string): { sub: number } | null {
    try {
        const payload = jwt.verify(token, secret!, { algorithms: [ALGORITHM] });
        if (typeof payload === "string") return null;
        const sub = Number(payload.sub);
        return Number.isInteger(sub) ? { sub } : null;
    } catch {
        return null;
    }
}
