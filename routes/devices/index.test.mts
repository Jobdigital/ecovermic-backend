import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import { signToken } from "#Application/auth";
import { createDevicesRouter } from "./index.mts";

test("development claims require authentication and remain exclusive and idempotent", async () => {
    const original = process.env.DEV_DEVICE_LINKING;
    const database = new DatabaseSync(":memory:");
    database.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email_verified INTEGER NOT NULL); INSERT INTO users VALUES (1, 1), (2, 1), (3, 0)");
    const app = express();
    app.use(express.json());
    app.use("/devices", createDevicesRouter(database));
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test address");
    const base = `http://127.0.0.1:${address.port}`;
    const request = (token?: string, deviceId: unknown = "F4E065A84320") =>
        fetch(`${base}/devices/claim`, {
            method: "POST",
            headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify({ deviceId }),
        });
    try {
        delete process.env.DEV_DEVICE_LINKING;
        assert.equal((await request(signToken(1))).status, 404);
        process.env.DEV_DEVICE_LINKING = "true";
        assert.equal((await request()).status, 401);
        assert.equal((await request("invalid")).status, 401);
        assert.equal((await request(signToken(3))).status, 401);
        assert.equal((await request(signToken(1), "invalid")).status, 400);
        assert.deepEqual(await (await request(signToken(1))).json(),
            { deviceId: "F4E065A84320", linked: true, mode: "development" });
        assert.equal((await request(signToken(1))).status, 200);
        assert.equal((await request(signToken(2))).status, 409);
        const owned = await fetch(`${base}/devices`, { headers: { authorization: `Bearer ${signToken(1)}` } });
        assert.deepEqual(await owned.json(), { devices: [{ deviceId: "F4E065A84320" }], mode: "development" });
        const other = await fetch(`${base}/devices`, { headers: { authorization: `Bearer ${signToken(2)}` } });
        assert.deepEqual(await other.json(), { devices: [], mode: "development" });
    } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        database.close();
        if (original === undefined) delete process.env.DEV_DEVICE_LINKING;
        else process.env.DEV_DEVICE_LINKING = original;
    }
});
