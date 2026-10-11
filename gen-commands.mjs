// Generates commands.json and the bridge.ps1 ValidateSet from the mod dispatcher.
// Source of truth: the `switch (command)` inside DispatchCore in src/Mod.cs.
// Usage: node gen-commands.mjs           write commands.json and bridge.ps1 line 2
//        node gen-commands.mjs --check   print differences and exit 1 if either file is stale
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const modPath = join(root, 'src', 'Mod.cs');
const jsonPath = join(root, 'commands.json');
const bridgePath = join(root, 'bridge.ps1');

// Client-only commands: handled by bridge.ps1 itself, never sent to the mod.
const CLIENT_ONLY = ['stop'];
// Commands that never auto-pause the game, regardless of the statusOnly expression.
const ALWAYS_NON_PAUSING = ['simulate_step', 'cancel_simulation_step', 'set_simulation_speed', 'set_camera'];
// Commands that mutate the city and therefore need AllowControl.
const CONTROL = [
    'create_district', 'edit_district', 'set_service_districts', 'set_building_option', 'set_camera', 'set_simulation_speed',
    'build_road', 'build_network', 'upgrade_network', 'road_option', 'zone_rectangle', 'clear_zoning', 'place_building',
    'relocate_building', 'demolish', 'purchase_tiles', 'set_tax', 'set_service_budget', 'save_checkpoint',
    'batch_execute', 'execute_neighborhood', 'cancel_batch', 'simulate_step', 'cancel_simulation_step',
    'resolve_pause_blocker', 'quit_game', 'load_save', 'zone_area', 'pause_for_analysis',
];
const CONTROL_SET = new Set(CONTROL);

function fail(message) { throw new Error(message); }

// Text from DispatchCore's signature to the end of the file, so the statusOnly search stays inside it.
function dispatchCoreText(src) {
    const at = src.search(/\bJObject\s+DispatchCore\s*\(/);
    if (at < 0) fail('DispatchCore not found in src/Mod.cs');
    return src.slice(at);
}

// Scans C# source with a token regex that skips comments and string/char literals, so braces inside them are ignored.
const SCAN = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\bcase\s+"([^"\\\n]+)"\s*:|[{}]/g;

// The text of the switch block, from its opening brace to the matching closing brace.
function switchBody(text) {
    const kw = text.indexOf('switch (command)');
    if (kw < 0) fail('switch (command) not found inside DispatchCore');
    const open = text.indexOf('{', kw);
    let depth = 0;
    const scan = new RegExp(SCAN.source, 'g');
    scan.lastIndex = open;
    let m;
    while ((m = scan.exec(text))) {
        if (m[0] === '{') depth++;
        else if (m[0] === '}' && --depth === 0) return text.slice(open, m.index + 1);
    }
    fail('unbalanced braces in the DispatchCore switch');
}

// Case labels that sit directly under the switch (depth 1), not inside nested blocks.
function switchCases(body) {
    const names = [];
    let depth = 0;
    const scan = new RegExp(SCAN.source, 'g');
    let m;
    while ((m = scan.exec(body))) {
        if (m[0] === '{') depth++;
        else if (m[0] === '}') depth--;
        else if (m[1] !== undefined && depth === 1) names.push(m[1]);
    }
    return names;
}

function nonPausingReadNames(src) {
    const m = /\bNonPausingReads\s*=\s*\{([^}]*)\}/.exec(src);
    if (!m) fail('NonPausingReads array not found in src/Mod.cs');
    return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

function statusOnlyNames(text) {
    const start = text.indexOf('bool statusOnly');
    if (start < 0) fail('statusOnly expression not found in DispatchCore');
    const expr = text.slice(start, text.indexOf(';', start));
    return [...expr.matchAll(/command\s*==\s*"([^"]+)"/g)].map((x) => x[1]);
}

// Reads the dispatcher and returns [{name, pausing, control}] sorted by name.
function readDispatcher() {
    const src = readFileSync(modPath, 'utf8');
    const text = dispatchCoreText(src);
    const cases = switchCases(switchBody(text));
    if (cases.length === 0) fail('no case labels found in the DispatchCore switch');
    for (const name of cases) if (!/^[a-z_]+$/.test(name)) fail(`unexpected command name in dispatcher: ${name}`);
    const dup = cases.find((n, i) => cases.indexOf(n) !== i);
    if (dup !== undefined) fail(`duplicate case label in dispatcher: ${dup}`);
    const nonPausing = new Set([...nonPausingReadNames(src), ...statusOnlyNames(text), ...ALWAYS_NON_PAUSING]);
    const known = new Set(cases);
    for (const name of CONTROL) if (!known.has(name)) fail(`control list names a command the dispatcher does not have: ${name}`);
    return cases
        .map((name) => ({ name, pausing: !nonPausing.has(name), control: CONTROL_SET.has(name) }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// Existing commands.json entries, keyed by name. A bare string is an entry with no fields.
function readExisting() {
    const text = readFileSync(jsonPath, 'utf8');
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { fail(`commands.json is not valid JSON: ${e.message}`); }
    if (!Array.isArray(parsed)) fail('commands.json must be a JSON array');
    const byName = new Map();
    for (const item of parsed) {
        const entry = typeof item === 'string' ? { name: item } : item;
        if (!entry || typeof entry.name !== 'string') fail(`commands.json entry without a name: ${JSON.stringify(item)}`);
        if (byName.has(entry.name)) fail(`duplicate commands.json entry: ${entry.name}`);
        byName.set(entry.name, entry);
    }
    return { text, byName };
}

// Builds the commands.json entries. Existing descriptions and extra fields (such as args) are kept;
// pausing and control come from the dispatcher; undocumented marks entries with no description.
function buildEntries(commands, existing) {
    return commands.map((cmd) => {
        const old = existing.get(cmd.name) ?? {};
        const description = typeof old.description === 'string' ? old.description : '';
        const { name: _name, description: _description, pausing: _pausing, control: _control, undocumented: _undocumented, ...extras } = old;
        const entry = { name: cmd.name, description, pausing: cmd.pausing, control: cmd.control, ...extras };
        if (description === '') entry.undocumented = true;
        return entry;
    });
}

function validateSetLine(names) {
    return `[ValidateSet(${names.map((n) => `'${n}'`).join(',')})]`;
}

// Replaces only line 2 (the $Command ValidateSet), keeping its indentation and any CR.
function buildBridge(bridgeText, names) {
    const lines = bridgeText.split('\n');
    const current = lines[1] ?? '';
    const m = /^(\s*)\[ValidateSet\((.*)\)\]\r?$/.exec(current);
    if (!m) fail('bridge.ps1 line 2 is not a [ValidateSet(...)] line');
    const eol = current.endsWith('\r') ? '\r' : '';
    lines[1] = `${m[1]}${validateSetLine(names)}${eol}`;
    return { text: lines.join('\n'), currentNames: [...m[2].matchAll(/'([^']*)'/g)].map((x) => x[1]) };
}

function diffNames(wanted, actual) {
    const w = new Set(wanted); const a = new Set(actual);
    return { missing: wanted.filter((n) => !a.has(n)), extra: actual.filter((n) => !w.has(n)) };
}

function main() {
    const args = process.argv.slice(2);
    const check = args.includes('--check');
    const unknown = args.filter((a) => a !== '--check');
    if (unknown.length) fail(`unknown argument: ${unknown.join(' ')}`);

    const commands = readDispatcher();
    const names = commands.map((c) => c.name);
    const existing = readExisting();
    const entries = buildEntries(commands, existing.byName);
    const jsonText = JSON.stringify(entries, null, 2) + '\n';

    const bridgeOld = readFileSync(bridgePath, 'utf8');
    const bridge = buildBridge(bridgeOld, [...names, ...CLIENT_ONLY].sort());

    const added = names.filter((n) => !existing.byName.has(n));
    const removed = [...existing.byName.keys()].filter((n) => !names.includes(n));
    const summary = `${names.length} commands: ${added.length} missing from old commands.json, ${removed.length} stale entries removed`;

    if (check) {
        const problems = [];
        if (jsonText !== existing.text) {
            const oldByName = existing.byName;
            const changed = entries.filter((e) => oldByName.has(e.name) && JSON.stringify(oldByName.get(e.name)) !== JSON.stringify(e)).map((e) => e.name);
            if (added.length + removed.length + changed.length === 0) problems.push('commands.json: formatting differs from generated output');
            if (added.length) problems.push(`commands.json missing: ${added.join(', ')}`);
            if (removed.length) problems.push(`commands.json stale: ${removed.join(', ')}`);
            if (changed.length) problems.push(`commands.json changed: ${changed.join(', ')}`);
        }
        if (bridge.text !== bridgeOld) {
            const d = diffNames([...names, ...CLIENT_ONLY].sort(), bridge.currentNames);
            problems.push(`bridge.ps1 ValidateSet differs: missing ${JSON.stringify(d.missing)}, extra ${JSON.stringify(d.extra)}`);
        }
        if (problems.length) {
            for (const p of problems) console.error(p);
            console.error('Run: node gen-commands.mjs');
            process.exitCode = 1;
            return;
        }
        console.log(`commands.json and bridge.ps1 match the dispatcher (${summary}).`);
        return;
    }

    if (jsonText !== existing.text) writeFileSync(jsonPath, jsonText, 'utf8');
    if (bridge.text !== bridgeOld) writeFileSync(bridgePath, bridge.text, 'utf8');
    console.log(`Wrote commands.json and bridge.ps1 ValidateSet (${summary}).`);
    if (added.length) console.log(`added: ${added.join(', ')}`);
    if (removed.length) console.log(`removed: ${removed.join(', ')}`);
}

try { main(); }
catch (e) { console.error(`gen-commands: ${e.message}`); process.exitCode = 1; }
