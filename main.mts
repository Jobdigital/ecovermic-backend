import { Entity } from "#Models/enterprise";
import express from "express";
import { spawn } from "node:child_process"

process.loadEnvFile();

const enterprise = new Entity;

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3000);
const token = String(process.env.LOCALTO_TOKEN);

const app = express();

app.listen(port, host, () => {
    const localtonet = spawn("localtonet",
        [
            "--authtoken",
            token
        ], {
        stdio: [
            "ignore",
            "pipe",
            "ignore"
        ]
    });

    if (localtonet.stdout) {
        const { stdout } = localtonet;
        stdout.on("data", chunk => {
            const line = String(chunk)
            if (line.includes(`${host}:${port}`)) {
                const split = line.split("ADDED")
                if (split.length < 2) return;
                const url = split[1].split(":")[0].trim();
                console.log(`Server started on https://${url}`);
            }
        });
    }

    localtonet.on("exit", (code) => process.exit(code ?? 0));
});
