import express from "express";
import { spawn } from "node:child_process"
import usersRouter from "#Routes/users";

process.loadEnvFile();

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3000);
const token = String(process.env.LOCALTO_TOKEN);

const app = express();

app.use(express.json());
app.use("/users", usersRouter);

app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(err);
    if (err?.type === "entity.parse.failed") {
        res.status(400).json({ error: { code: "INVALID_JSON", message: "El cuerpo de la petición no es un JSON válido" } });
        return;
    }
    console.error(err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Error interno del servidor" } });
});

app.listen(port, host, (error?: Error) => {
    if (error) {
        console.error(`No se pudo iniciar el servidor en ${host}:${port}:`, error.message);
        process.exit(1);
    }
    console.log(`Server started on http://${host}:${port}`);
    // const localtonet = spawn("localtonet",
    //     [
    //         "--authtoken",
    //         token
    //     ], {
    //     stdio: [
    //         "ignore",
    //         "pipe",
    //         "ignore"
    //     ]
    // });

    // if (localtonet.stdout) {
    //     const { stdout } = localtonet;
    //     stdout.on("data", chunk => {
    //         const line = String(chunk)
    //         if (line.includes(`${host}:${port}`)) {
    //             const split = line.split("ADDED")
    //             if (split.length < 2) return;
    // const url = split[1].split(":")[0].trim();
    // console.log(`Server started on https://${url}`);
    //         }
    //     });
    // }

    // localtonet.on("exit", (code) => process.exit(code ?? 0));
});
