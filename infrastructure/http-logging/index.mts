import type { RequestHandler } from "express";
import { randomUUID } from "node:crypto";

const requestFields = [
    "email", "password", "registrationToken", "name", "age", "gender", "countryCode", "phone", "code",
] as const;
const endpoints = new Set([
    "/users/register", "/users/register/profile", "/users/confirm", "/users/confirm/resend", "/users/login",
]);
const hidden = "[oculto]";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(value: unknown): string | undefined {
    return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : undefined;
}

function endpoint(path: string): string {
    const normalized = path.toLowerCase().replace(/\/+$/, "") || "/";
    return endpoints.has(normalized) ? normalized : "[ruta no identificada]";
}

function requestBody(body: unknown, depth = 0): unknown {
    if (depth >= 5) return hidden;
    if (Array.isArray(body)) {
        return [
            ...body.slice(0, 20).map(value => requestBody(value, depth + 1)),
            ...(body.length > 20 ? ["[elementos adicionales ocultos]"] : []),
        ];
    }
    if (isRecord(body)) {
        const fields: Record<string, unknown> = {};
        for (const field of requestFields) {
            if (Object.hasOwn(body, field)) fields[field] = requestBody(body[field], depth + 1);
        }
        if (Object.keys(body).some(field => !(requestFields as readonly string[]).includes(field))) {
            fields["[otros campos]"] = hidden;
        }
        return fields;
    }
    return hidden;
}

function responseSummary(body: unknown): Record<string, unknown> {
    if (!isRecord(body)) return { cuerpo: "[omitido]" };

    const summary: Record<string, unknown> = { cuerpo: "[omitido]" };
    if (typeof body.emailSent === "boolean") summary.emailSent = body.emailSent;
    if (isRecord(body.error)) {
        const code = errorCode(body.error.code);
        const fields: Record<string, string> = {};
        if (isRecord(body.error.fields)) {
            for (const field of requestFields) {
                const detail = body.error.fields[field];
                if (isRecord(detail)) {
                    const fieldCode = errorCode(detail.code);
                    if (fieldCode) fields[field] = fieldCode;
                }
            }
        }
        if (code) summary.error = { code, ...(Object.keys(fields).length ? { fields } : {}) };
    }
    return summary;
}

export const logHttp: RequestHandler = (req, res, next) => {
    const started = process.hrtime.bigint();
    const id = randomUUID();
    const requestedEndpoint = endpoint(req.path);
    let route: string | undefined;
    let result: Record<string, unknown> = { cuerpo: "[omitido]" };
    const json = res.json;

    console.log(`[HTTP] ${JSON.stringify({
        tipo: "petición",
        id,
        metodo: req.method,
        endpoint: requestedEndpoint,
    }, null, 2)}`);

    res.json = function (body: unknown) {
        if (typeof req.route?.path === "string") {
            route = `${req.baseUrl === "/users" ? req.baseUrl : ""}${req.route.path}`;
        }
        result = responseSummary(body);
        return json.call(this, body);
    };

    const logResult = (aborted: boolean) => {
        const fields = isRecord(req.body)
            ? requestFields.filter(field => Object.hasOwn(req.body, field))
            : [];
        const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
        console.log(`[HTTP] ${JSON.stringify({
            tipo: "resultado",
            id,
            metodo: req.method,
            endpoint: requestedEndpoint,
            ruta: route ?? "[ruta no identificada]",
            estado: aborted ? "conexión cerrada" : res.statusCode,
            duracionMs: Number(durationMs.toFixed(2)),
            peticion: {
                campos: fields,
                parametrosConsulta: req.originalUrl.includes("?") ? hidden : "[sin parámetros]",
                cuerpo: req.body === undefined ? "[no disponible]" : requestBody(req.body),
            },
            respuesta: result,
        }, null, 2)}`);
    };

    res.once("finish", () => logResult(false));
    res.once("close", () => {
        if (!res.writableFinished) logResult(true);
    });
    next();
};
