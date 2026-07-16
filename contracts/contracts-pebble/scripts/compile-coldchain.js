// Compiles src/cold_chain.pebble (second entry point, separate from index.pebble).
// Mirrors scripts/compile.js including the Windows path patch.

import * as fs from "node:fs";
import * as path from "node:path";

const pebblePathMod = path.resolve(
    process.cwd(),
    "node_modules/@harmoniclabs/pebble/dist/compiler/path/getAbsolutePath.js"
);
const origSrc = fs.readFileSync(pebblePathMod, "utf8");
if (!origSrc.includes("WINDOWS_PATCHED")) {
    const patched = origSrc.replace(
        'export function isAbsolutePath(path) {\n    return path.startsWith(PATH_DELIMITER);',
        '/* WINDOWS_PATCHED */ export function isAbsolutePath(path) {\n    return path.startsWith(PATH_DELIMITER) || /^[A-Za-z]:[\\/]/.test(path);'
    );
    const patched2 = patched.replace(
        'return filePath.startsWith(projectRoot) ? filePath : projectRoot + filePath;',
        'return (filePath.startsWith(projectRoot) || isAbsolutePath(filePath)) ? filePath : projectRoot + filePath;'
    );
    fs.writeFileSync(pebblePathMod, patched2, "utf8");
    console.log("Patched Pebble path module for Windows compatibility");
}

const { Compiler, productionOptions } = await import("@harmoniclabs/pebble");

const root = process.cwd().replace(/\\/g, "/");
const entry = root + "/src/cold_chain.pebble";
const outDir = "out-coldchain";

const config = { ...productionOptions, compilerVersion: "^0.3.4", removeTraces: true };

const io = {
    readFile(filePath) {
        return fs.readFileSync(filePath.replace(/\//g, path.sep), "utf8");
    },
    writeFile(filePath, content) {
        const normalized = filePath.replace(/\//g, path.sep);
        fs.mkdirSync(path.dirname(normalized), { recursive: true });
        fs.writeFileSync(normalized, content);
    },
    writeBinaryFile(filePath, content) {
        const normalized = filePath.replace(/\//g, path.sep);
        fs.mkdirSync(path.dirname(normalized), { recursive: true });
        fs.writeFileSync(normalized, content);
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
    console.log("Cold-chain compilation successful! Output: out-coldchain/");
} catch (e) {
    console.error("Compilation failed:", e.message);
    if (e.stack) console.error(e.stack);
    process.exit(1);
}
