import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import express from "express";
import { logHttp } from "./index.mts";

test("registra el endpoint y el cuerpo redactado sin exponer datos sensibles", async () => {
    const app = express();
    app.use(logHttp);
    app.use(express.json());
    const router = express.Router();
    router.post("/login", (req, res) => {
        if (req.body.password === "secret-password") {
            res.json({ token: "secret-token", emailSent: true, user: { email: "private@example.com" } });
        } else {
            res.status(400).json({
                error: {
                    code: "VALIDATION_ERROR",
                    fields: { password: { code: "PASSWORD_REQUIRED", message: "private-message" } },
                },
            });
        }
    });
    app.use("/users", router);
    app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(400).json({ error: { code: "INVALID_JSON" } });
    });

    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

    try {
        const response = await fetch(`${base}/users/login?token=private-query`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer private-header" },
            body: JSON.stringify({
                email: "private@example.com",
                password: "secret-password",
                name: { code: ["private-nested", { phone: "private-phone", "private-nested-key": "private-value" }] },
                "private-key": "private-value",
            }),
        });
        assert.deepEqual(await response.json(), {
            token: "secret-token", emailSent: true, user: { email: "private@example.com" },
        });

        const invalid = await fetch(`${base}/users/login`, {
            method: "POST", headers: { "content-type": "application/json" }, body: "{}",
        });
        assert.equal(invalid.status, 400);
        const malformed = await fetch(`${base}/users/login`, {
            method: "POST", headers: { "content-type": "application/json" }, body: '{"password":"private-malformed"',
        });
        assert.equal(malformed.status, 400);
        const missing = await fetch(`${base}/private-path`);
        assert.equal(missing.status, 404);
        await missing.text();

        const array = await fetch(`${base}/users/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(Array.from({ length: 21 }, () => ({ name: { name: { name: { name: "private-deep" } } } }))),
        });
        assert.equal(array.status, 400);
        await array.text();

        assert.equal(logs.length, 10);
        const allEntries = logs.map(line => JSON.parse(line.slice("[HTTP] ".length)));
        const requests = allEntries.filter(entry => entry.tipo === "petición");
        const entries = allEntries.filter(entry => entry.tipo === "resultado");
        assert.equal(requests.length, 5);
        assert.equal(entries.length, 5);
        assert.deepEqual(requests.map(entry => entry.id), entries.map(entry => entry.id));
        assert.equal(requests[0].endpoint, "/users/login");
        assert.equal(requests[2].endpoint, "/users/login");
        assert.equal(requests[3].endpoint, "[ruta no identificada]");
        assert.equal(entries[0].endpoint, "/users/login");
        assert.equal(entries[0].ruta, "/users/login");
        assert.equal(entries[0].estado, 200);
        assert.deepEqual(entries[0].peticion.campos, ["email", "password", "name"]);
        assert.equal(entries[0].peticion.parametrosConsulta, "[oculto]");
        assert.deepEqual(entries[0].peticion.cuerpo, {
            email: "[oculto]",
            password: "[oculto]",
            name: { code: ["[oculto]", { phone: "[oculto]", "[otros campos]": "[oculto]" }] },
            "[otros campos]": "[oculto]",
        });
        assert.equal(entries[0].respuesta.emailSent, true);
        assert.equal(entries[1].respuesta.error.code, "VALIDATION_ERROR");
        assert.deepEqual(entries[1].respuesta.error.fields, { password: "PASSWORD_REQUIRED" });
        assert.equal(entries[2].respuesta.error.code, "INVALID_JSON");
        assert.equal(entries[2].peticion.cuerpo, "[no disponible]");
        assert.equal(entries[3].estado, 404);
        assert.equal(entries[3].ruta, "[ruta no identificada]");
        assert.equal(entries[4].peticion.cuerpo.length, 21);
        assert.deepEqual(entries[4].peticion.cuerpo[0], { name: { name: { name: { name: "[oculto]" } } } });
        assert.equal(entries[4].peticion.cuerpo[20], "[elementos adicionales ocultos]");
        assert.doesNotMatch(logs.join("\n"), /secret-password|secret-token|private@example\.com|private-key|private-value|private-message|private-query|private-path|private-header|private-nested|private-phone|private-malformed|private-deep/);
    } finally {
        console.log = originalLog;
        server.close();
        await once(server, "close");
    }
});
