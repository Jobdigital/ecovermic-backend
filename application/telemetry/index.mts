import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { WebSocket, WebSocketServer } from "ws";
import { verifyToken } from "#Application/auth";

type DeviceReadings = {
    type: "readings";
    temperature: number | null;
    humidity: number | null;
    soilAdc: number | null;
    soilMoisture?: number | null;
};

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function within(value: unknown, min: number, max: number): value is number | null {
    return value === null || (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max);
}

function readings(value: unknown): value is DeviceReadings {
    return record(value) && value.type === "readings" &&
        within(value.temperature, -40, 80) && within(value.humidity, 0, 100) &&
        within(value.soilAdc, 0, 4095) && (value.soilAdc === null || Number.isInteger(value.soilAdc)) &&
        (!("soilMoisture" in value) ||
            (within(value.soilMoisture, 0, 100) && (value.soilAdc !== null || value.soilMoisture === null)));
}

export function parseDevelopmentKeys(raw: string | undefined): Map<string, Buffer> {
    if (!raw) throw new Error("DEV_TELEMETRY_KEYS es obligatorio cuando la telemetría de desarrollo está activada");
    let values: unknown;
    try { values = JSON.parse(raw); }
    catch { throw new Error("DEV_TELEMETRY_KEYS no es JSON válido"); }
    if (!record(values) || Object.keys(values).length === 0) throw new Error("DEV_TELEMETRY_KEYS inválido");
    const keys = new Map<string, Buffer>();
    for (const [id, key] of Object.entries(values)) {
        if (!/^[0-9A-F]{12}$/.test(id) || typeof key !== "string" || !/^[0-9A-F]{64}$/.test(key)) {
            throw new Error("DEV_TELEMETRY_KEYS contiene una identidad o clave inválida");
        }
        keys.set(id, Buffer.from(key, "hex"));
    }
    return keys;
}

export function loadDevelopmentKeys(raw: string | undefined, directory: string | undefined): Map<string, Buffer> {
    if (raw && directory) throw new Error("Configura DEV_TELEMETRY_KEYS o DEV_TELEMETRY_KEYS_DIR, no ambos");
    if (!directory) return parseDevelopmentKeys(raw);
    const values: Record<string, string> = {};
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.name.endsWith(".telemetry.json")) continue;
        const match = /^([0-9A-F]{12})\.telemetry\.json$/.exec(entry.name);
        if (!entry.isFile() || !match) throw new Error("Archivo de clave de telemetría inválido");
        let value: unknown;
        try { value = JSON.parse(readFileSync(join(directory, entry.name), "utf8")); }
        catch { throw new Error("No se pudo leer un archivo de clave de telemetría"); }
        if (!record(value) || value.device_id !== match[1] || typeof value.telemetry_key !== "string") {
            throw new Error("Archivo de clave de telemetría inválido");
        }
        values[match[1]] = value.telemetry_key;
    }
    return parseDevelopmentKeys(JSON.stringify(values));
}

export function installDevelopmentTelemetry(server: Server, database: DatabaseSync, keys: Map<string, Buffer>) {
    database.exec(`CREATE TABLE IF NOT EXISTS dev_device_links (
        device_id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    database.exec(`CREATE TABLE IF NOT EXISTS dev_telemetry_links (
        device_id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id)
    )`);
    const socketServer = new WebSocketServer({ noServer: true, maxPayload: 2048 });
    const devices = new Map<string, WebSocket>();
    const clients = new Set<{ socket: WebSocket; id: string; token: string }>();

    function permitted(token: string, id: string): boolean {
        const session = verifyToken(token);
        return !!session && !!database.prepare(
            "SELECT 1 FROM dev_device_links d JOIN dev_telemetry_links t ON t.device_id = d.device_id AND t.user_id = d.user_id JOIN users u ON u.id = d.user_id WHERE d.device_id = ? AND d.user_id = ? AND u.email_verified = 1"
        ).get(id, session.sub);
    }

    function broadcast(id: string, payload: object) {
        const data = JSON.stringify(payload);
        for (const client of clients) {
            if (client.id !== id) continue;
            if (!permitted(client.token, id)) {
                client.socket.close(1008, "Unauthorized");
            } else if (client.socket.readyState === WebSocket.OPEN) {
                client.socket.send(data);
            }
        }
    }

    server.on("upgrade", (request, socket, head) => {
        if (request.url !== "/telemetry/device" && request.url !== "/telemetry/client") {
            socket.destroy();
            return;
        }
        socketServer.handleUpgrade(request, socket, head, ws => {
            const isDevice = request.url === "/telemetry/device";
            const nonce = isDevice ? randomBytes(32).toString("hex") : "";
            let authenticated = false;
            let deviceId = "";
            let lastReading = 0;
            let readingTimeout: NodeJS.Timeout | undefined;
            let client: { socket: WebSocket; id: string; token: string } | undefined;
            const timer = setTimeout(() => ws.close(1008, "Authentication timeout"), 10000);
            let alive = true;
            const heartbeat = setInterval(() => {
                if (!alive) return ws.terminate();
                alive = false;
                ws.ping();
            }, 30000);
            ws.on("pong", () => { alive = true; });
            ws.on("error", () => ws.terminate());
            ws.on("close", () => {
                clearTimeout(timer);
                clearTimeout(readingTimeout);
                clearInterval(heartbeat);
                if (client) clients.delete(client);
                if (deviceId && devices.get(deviceId) === ws) {
                    devices.delete(deviceId);
                    broadcast(deviceId, { type: "status", online: false });
                }
            });
            if (isDevice) ws.send(JSON.stringify({ type: "challenge", nonce }));
            ws.on("message", (raw, binary) => {
                if (binary) return ws.close(1003, "Text required");
                let message: unknown;
                try { message = JSON.parse(raw.toString()); }
                catch { return ws.close(1007, "Invalid JSON"); }
                if (!authenticated) {
                    if (!record(message) || message.type !== "auth" || typeof message.deviceId !== "string" ||
                        !/^[0-9A-F]{12}$/.test(message.deviceId)) return ws.close(1008, "Unauthorized");
                    if (isDevice) {
                        const key = keys.get(message.deviceId);
                        if (!key || typeof message.mac !== "string" || !/^[0-9a-f]{64}$/.test(message.mac)) {
                            return ws.close(1008, "Unauthorized");
                        }
                        const expected = createHmac("sha256", key)
                            .update(`telemetry-v1:${message.deviceId}:${nonce}`).digest();
                        if (!timingSafeEqual(expected, Buffer.from(message.mac, "hex"))) return ws.close(1008, "Unauthorized");
                        deviceId = message.deviceId;
                        const previous = devices.get(deviceId);
                        devices.set(deviceId, ws);
                        if (previous) previous.close(1008, "Replaced");
                        readingTimeout = setTimeout(() => ws.terminate(), 20000);
                        broadcast(deviceId, { type: "status", online: true });
                    } else {
                        if (typeof message.token !== "string" || !permitted(message.token, message.deviceId)) {
                            return ws.close(1008, "Unauthorized");
                        }
                        client = { socket: ws, id: message.deviceId, token: message.token };
                        clients.add(client);
                        ws.send(JSON.stringify({ type: "status", online: devices.has(message.deviceId) }));
                    }
                    authenticated = true;
                    clearTimeout(timer);
                    if (isDevice) ws.send(JSON.stringify({ type: "authenticated" }));
                    return;
                }
                if (!isDevice || devices.get(deviceId) !== ws || !readings(message)) {
                    return ws.close(1008, "Invalid message");
                }
                const now = Date.now();
                if (now - lastReading < 1000) return ws.close(1008, "Rate limit");
                lastReading = now;
                clearTimeout(readingTimeout);
                readingTimeout = setTimeout(() => ws.terminate(), 20000);
                broadcast(deviceId, {
                    type: "readings",
                    temperature: message.temperature,
                    humidity: message.humidity,
                    soilAdc: message.soilAdc,
                    ...(message.soilMoisture !== undefined ? { soilMoisture: message.soilMoisture } : {}),
                });
            });
        });
    });
    return socketServer;
}
