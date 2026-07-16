// Workaround for Pebble CLI Windows path bug (PATH_DELIMITER = "/" vs Windows "\")
// Patches the internal path module before compiling.

import * as fs from "node:fs";
import * as path from "node:path";

// Patch Pebble's getAbsolutePath module to handle Windows drive letters
const pebblePathMod = path.resolve(
    process.cwd(),
    "node_modules/@harmoniclabs/pebble/dist/compiler/path/getAbsolutePath.js"
);

const origSrc = fs.readFileSync(pebblePathMod, "utf8");
if (!origSrc.includes("WINDOWS_PATCHED")) {
    // Patch isAbsolutePath to recognize Windows drive letters (C:/, D:/, etc.)
    const patched = origSrc.replace(
        'export function isAbsolutePath(path) {\n    return path.startsWith(PATH_DELIMITER);',
        '/* WINDOWS_PATCHED */ export function isAbsolutePath(path) {\n    return path.startsWith(PATH_DELIMITER) || /^[A-Za-z]:[\\/]/.test(path);'
    );
    // Also patch getEnvRelativePath: when result is absolute Windows path, don't prepend root
    const patched2 = patched.replace(
        'return filePath.startsWith(projectRoot) ? filePath : projectRoot + filePath;',
        'return (filePath.startsWith(projectRoot) || isAbsolutePath(filePath)) ? filePath : projectRoot + filePath;'
    );
    fs.writeFileSync(pebblePathMod, patched2, "utf8");
    console.log("Patched Pebble path module for Windows compatibility");
}

// Now import and compile
const { Compiler, productionOptions } = await import("@harmoniclabs/pebble");

const root = process.cwd().replace(/\\/g, "/");
const entry = root + "/src/index.pebble";
const outDir = "out";

const configPath = path.resolve(process.cwd(), "pebble.config.json");
let config = { ...productionOptions };
if (fs.existsSync(configPath)) {
    const userConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config = { ...productionOptions, ...userConfig };
}

// Custom IO that normalizes paths
const io = {
    readFile(filePath) {
        const normalized = filePath.replace(/\//g, path.sep);
        return fs.readFileSync(normalized, "utf8");
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
        const normalized = filePath.replace(/\//g, path.sep);
        return fs.existsSync(normalized);
    },
    // Pebble has a typo: "exsistSync" instead of "existsSync"
    exsistSync(filePath) {
        const normalized = filePath.replace(/\//g, path.sep);
        return fs.existsSync(normalized);
    },
    stdout: process.stdout
};

const compiler = new Compiler(io, config);

try {
    await compiler.compile({
        root,
        entry,
        outDir
    });
    console.log("Compilation successful! Output: out/out.flat");
} catch (e) {
    console.error("Compilation failed:", e.message);
    process.exit(1);
}
