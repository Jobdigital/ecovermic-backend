import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { WebSocket } from "ws";
import express from "express";
import { signToken } from "#Application/auth";
import { createDevicesRouter } from "#Routes/devices";
import { installDevelopmentTelemetry, loadDevelopmentKeys, parseDevelopmentKeys } from "./index.mts";

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("WebSocket message timeout")), 3000);
        socket.once("message", data => {
            clearTimeout(timer);
            resolve(JSON.parse(data.toString()));
        });
    });
}

test("development telemetry authenticates devices and restricts account access", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email_verified INTEGER NOT NULL); INSERT INTO users VALUES (1, 1), (2, 1)");
    const id = "ABCDEF123456";
    const key = Buffer.alloc(32, 7);
    const server = createServer();
    const gateway = installDevelopmentTelemetry(server, db, new Map([[id, key]]));
    db.prepare("INSERT INTO dev_device_links (device_id, user_id) VALUES (?, ?)").run(id, 1);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `ws://127.0.0.1:${address.port}/telemetry`;
    const sockets: WebSocket[] = [];
    try {
        const wrong = new WebSocket(`${base}/device`);
        sockets.push(wrong);
        const challenge = await nextMessage(wrong);
        const rejected = once(wrong, "close");
        wrong.send(JSON.stringify({ type: "auth", deviceId: id, mac: "00".repeat(32) }));
        await rejected;
        assert.equal(challenge.type, "challenge");

        const device = new WebSocket(`${base}/device`);
        sockets.push(device);
        const { nonce } = await nextMessage(device);
        assert.equal(typeof nonce, "string");
        const authenticated = nextMessage(device);
        const mac = createHmac("sha256", key).update(`telemetry-v1:${id}:${nonce}`).digest("hex");
        device.send(JSON.stringify({ type: "auth", deviceId: id, mac }));
        assert.equal((await authenticated).type, "authenticated");

        const notReconfirmed = new WebSocket(`${base}/client`);
        sockets.push(notReconfirmed);
        await once(notReconfirmed, "open");
        const needsConfirmation = once(notReconfirmed, "close");
        notReconfirmed.send(JSON.stringify({ type: "auth", deviceId: id, token: signToken(1) }));
        await needsConfirmation;
        db.prepare("INSERT INTO dev_telemetry_links (device_id, user_id) VALUES (?, ?)").run(id, 1);

        const unauthorized = new WebSocket(`${base}/client`);
        sockets.push(unauthorized);
        await once(unauthorized, "open");
        const closed = once(unauthorized, "close");
        unauthorized.send(JSON.stringify({ type: "auth", deviceId: id, token: signToken(2) }));
        await closed;

        const client = new WebSocket(`${base}/client`);
        sockets.push(client);
        await once(client, "open");
        const online = nextMessage(client);
        client.send(JSON.stringify({ type: "auth", deviceId: id, token: signToken(1) }));
        assert.deepEqual(await online, { type: "status", online: true });
        const received = nextMessage(client);
        device.send(JSON.stringify({ type: "readings", temperature: 28.2, humidity: 32, soilAdc: 4095 }));
        assert.deepEqual(await received, { type: "readings", temperature: 28.2, humidity: 32, soilAdc: 4095 });
        await new Promise(resolve => setTimeout(resolve, 1100));
        const estimated = nextMessage(client);
        device.send(JSON.stringify({ type: "readings", temperature: 28.2, humidity: 32, soilAdc: 2000, soilMoisture: 50 }));
        assert.deepEqual(await estimated, { type: "readings", temperature: 28.2, humidity: 32, soilAdc: 2000, soilMoisture: 50 });
        const offline = nextMessage(client);
        device.send(JSON.stringify({ type: "readings", temperature: 28, humidity: 32, soilAdc: 2000, soilMoisture: 101 }));
        assert.deepEqual(await offline, { type: "status", online: false });
    } finally {
        for (const socket of sockets) socket.terminate();
        await new Promise<void>(resolve => gateway.close(() => resolve()));
        await new Promise<void>(resolve => server.close(() => resolve()));
        db.close();
    }
});

test("development telemetry keys reject invalid configuration", () => {
    assert.throws(() => parseDevelopmentKeys(undefined));
    assert.throws(() => parseDevelopmentKeys('{"ABCDEF123456":"short"}'));
    assert.equal(parseDevelopmentKeys(`{"ABCDEF123456":"${"AB".repeat(32)}"}`).size, 1);
});

test("development telemetry loads private device files and rejects invalid records", () => {
    const directory = mkdtempSync(join(tmpdir(), "telemetry-keys-"));
    const file = join(directory, "ABCDEF123456.telemetry.json");
    try {
        assert.throws(() => loadDevelopmentKeys(undefined, directory));
        writeFileSync(file, JSON.stringify({ device_id: "ABCDEF123456", telemetry_key: "AB".repeat(32) }));
        assert.deepEqual(loadDevelopmentKeys(undefined, directory).get("ABCDEF123456"), Buffer.alloc(32, 0xab));
        assert.throws(() => loadDevelopmentKeys("{}", directory));
        writeFileSync(file, JSON.stringify({ device_id: "ABCDEF123457", telemetry_key: "AB".repeat(32) }));
        assert.throws(() => loadDevelopmentKeys(undefined, directory));
    } finally {
        unlinkSync(file);
        rmdirSync(directory);
    }
});

test("reconfirming a development link enables telemetry only for its owner", async () => {
    const previousLinking = process.env.DEV_DEVICE_LINKING;
    const previousTelemetry = process.env.DEV_TELEMETRY;
    process.env.DEV_DEVICE_LINKING = "true";
    process.env.DEV_TELEMETRY = "true";
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email_verified INTEGER NOT NULL); INSERT INTO users VALUES (1, 1), (2, 1)");
    const app = express();
    app.use(express.json());
    app.use("/devices", createDevicesRouter(db));
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/devices/claim`;
    const claim = (user: number) => fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${signToken(user)}`, "content-type": "application/json" },
        body: JSON.stringify({ deviceId: "ABCDEF123456" }),
    });
    try {
        assert.equal((await claim(1)).status, 200);
        assert.equal((await claim(2)).status, 409);
        assert.equal(db.prepare("SELECT user_id FROM dev_telemetry_links WHERE device_id = ?").get("ABCDEF123456")?.user_id, 1);
    } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
        db.close();
        if (previousLinking === undefined) delete process.env.DEV_DEVICE_LINKING;
        else process.env.DEV_DEVICE_LINKING = previousLinking;
        if (previousTelemetry === undefined) delete process.env.DEV_TELEMETRY;
        else process.env.DEV_TELEMETRY = previousTelemetry;
    }
});
