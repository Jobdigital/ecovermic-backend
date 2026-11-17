import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import { signToken, verifyToken } from "#Application/auth";
import { createProfileRouter } from "./profile.mts";

test("profile edits are scoped to the authenticated user and email changes require confirmation", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
        CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT UNIQUE, country_code TEXT,
                            phone TEXT, password_hash TEXT, email_verified INTEGER);
        INSERT INTO users VALUES
            (1, 'Ana', 'ana@example.test', '+52', '0012345678', 'secret', 1),
            (2, 'Luis', 'luis@example.test', '+52', '1111111111', 'secret', 1),
            (3, 'Sin confirmar', 'pending@example.test', '+52', '1111111111', 'secret', 0);
    `);
    let sentCode = "";
    let sendFails = false;
    const one = signToken(1);
    const two = signToken(2);
    const unverified = signToken(3);
    const app = express();
    app.use(express.json());
    app.use("/users/profile", createProfileRouter({
        database,
        verifyToken,
        passwordMatches: async (password, hash) => password === hash,
        sendConfirmationCode: async (_email, _name, code) => {
            sentCode = code;
            return !sendFails;
        },
    }));
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test address");
    const base = `http://127.0.0.1:${address.port}/users/profile`;
    const request = (path = "", token = one, body?: object) => fetch(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    try {
        assert.equal((await request("", "invalid")).status, 401);
        assert.equal((await request("", unverified)).status, 401);
        assert.equal((await request("", one, { name: "A", countryCode: "+52", phone: "12" })).status, 400);
        const updated = await request("", one, { name: "Ana Verde", countryCode: "+57", phone: "0000123456" });
        assert.deepEqual(await updated.json(), {
            user: { name: "Ana Verde", email: "ana@example.test", countryCode: "+57", phone: "0000123456" },
            pendingEmail: null,
        });
        assert.equal((await (await request("", two)).json()).user.name, "Luis");
        assert.equal((await request("/email/request", one, { email: "new@example.test", password: "wrong" })).status, 401);
        assert.equal((await request("/email/request", one, { email: "luis@example.test", password: "secret" })).status, 409);

        sendFails = true;
        assert.equal((await request("/email/request", one, { email: "new@example.test", password: "secret" })).status, 502);
        assert.equal((await (await request()).json()).pendingEmail, null);
        sendFails = false;
        assert.equal((await request("/email/request", one, { email: "NEW@example.test", password: "secret" })).status, 200);
        const pending = await (await request()).json();
        assert.equal(pending.user.email, "ana@example.test");
        assert.equal(pending.pendingEmail, "new@example.test");
        assert.equal((await request("/email/request", one, { email: "new@example.test", password: "secret" })).status, 429);
        assert.equal((await request("/email/confirm", two, { code: sentCode })).status, 400);
        assert.equal((await request("/email/confirm", one, { code: sentCode === "000000" ? "000001" : "000000" })).status, 400);
        const confirmed = await request("/email/confirm", one, { code: sentCode });
        assert.equal(confirmed.status, 200);
        assert.equal((await confirmed.json()).user.email, "new@example.test");
        assert.equal((await request("/email/confirm", one, { code: sentCode })).status, 400);

        assert.equal((await request("/email/request", one, { email: "other@example.test", password: "secret" })).status, 200);
        database.prepare("UPDATE users SET email = ? WHERE id = 2").run("other@example.test");
        assert.equal((await request("/email/confirm", one, { code: sentCode })).status, 409);
        database.prepare("UPDATE users SET email = ? WHERE id = 2").run("luis@example.test");
        database.prepare("UPDATE pending_email_changes SET expires_at = 0 WHERE user_id = 1").run();
        assert.equal((await request("/email/confirm", one, { code: sentCode })).status, 410);
        database.prepare("UPDATE pending_email_changes SET expires_at = ?, attempts = 5 WHERE user_id = 1").run(Date.now() + 10000);
        assert.equal((await request("/email/confirm", one, { code: sentCode })).status, 429);
        assert.equal((await (await request()).json()).user.email, "new@example.test");

        for (let i = 0; i < 5; i++) {
            assert.equal((await request("/email/request", two, { email: "other@example.test", password: "wrong" })).status, 401);
        }
        assert.equal((await request("/email/request", two, { email: "other@example.test", password: "secret" })).status, 429);
    } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        database.close();
    }
});
