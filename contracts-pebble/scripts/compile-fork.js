// Compile using the local pebble fork (with amountOf + Windows path fix)

import * as fs from "node:fs";
import * as path from "node:path";

const { Compiler, productionOptions } = await import(
    "file:///C:/Users/max/ODATANO/pebble-fork/packages/pebble/dist/index.js"
);

const root = process.cwd().replace(/\\/g, "/");
const entry = root + "/src/index.pebble";
const outDir = "out";

const config = { ...productionOptions };
const configPath = path.resolve(process.cwd(), "pebble.config.json");
if (fs.existsSync(configPath)) {
    Object.assign(config, JSON.parse(fs.readFileSync(configPath, "utf8")));
}

const io = {
    readFile(filePath) {
        return fs.readFileSync(filePath.replace(/\//g, path.sep), "utf8");
    },
    writeFile(filePath, content) {
        const n = filePath.replace(/\//g, path.sep);
        fs.mkdirSync(path.dirname(n), { recursive: true });
        fs.writeFileSync(n, content);
    },
    writeBinaryFile(filePath, content) {
        const n = filePath.replace(/\//g, path.sep);
        fs.mkdirSync(path.dirname(n), { recursive: true });
        fs.writeFileSync(n, content);
    },
    fileExists(filePath) {
        return fs.existsSync(filePath.replace(/\//g, path.sep));
    },
    exsistSync(filePath) {
        return fs.existsSync(filePath.replace(/\//g, path.sep));
    },
    stdout: process.stdout
};

const compiler = new Compiler(io, config);

try {
    await compiler.compile({ root, entry, outDir });
    console.log("Compilation successful with amountOf! Output: out/out.flat");
} catch (e) {
    console.error("Compilation failed:", e.message);
    if (e.stack) console.error(e.stack);
    process.exit(1);
}
