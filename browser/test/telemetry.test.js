const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { after, before, beforeEach, describe, test } = require("node:test");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-telemetry-"));
process.env.TERMINAL_BROWSER_CONFIG_DIR = path.join(root, "config");
process.env.XDG_DATA_HOME = path.join(root, "data");
process.env.XDG_STATE_HOME = path.join(root, "state");
process.env.XDG_CACHE_HOME = path.join(root, "cache");
delete process.env.DO_NOT_TRACK;
delete process.env.TERMINAL_BROWSER_NO_TELEMETRY;

const received = [];
const collector = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    received.push(JSON.parse(body).event);
    response.end("{}");
  });
});

let shared;
let Telemetry;
let SettingsManager;

before(async () => {
  await new Promise((resolve) => collector.listen(0, "127.0.0.1", resolve));
  process.env.TERMINAL_BROWSER_TELEMETRY_ORIGIN = `http://127.0.0.1:${collector.address().port}`;
  shared = require("shared");
  ({ Telemetry } = require("../dist/telemetry.js"));
  ({ SettingsManager } = require("../dist/session/settings.js"));
  fs.mkdirSync(shared.CONFIG_DIR, { recursive: true });
});

after(() => {
  collector.close();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  received.length = 0;
  fs.rmSync(shared.SETTINGS_FILE, { recursive: true, force: true });
  shared.store().sqlite.exec("DELETE FROM app_state");
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
const files = () => ({ settings: shared.SETTINGS_FILE, shortcuts: shared.SHORTCUTS_FILE });
const host = {
  requestRender() {},
  settingsChanged() {},
  toast() {},
  setClipboard() {},
  overlayOpened() {},
  overlayClosed() {},
  release: () => ({}),
};

function usageTelemetry(settings) {
  return new Telemetry({
    version: "1.0.0",
    usageEnabled: () => settings.telemetryAllowed("telemetry.usage"),
    crashReportsEnabled: () => false,
    terminal: () => null,
  });
}

function crashTelemetry() {
  return new Telemetry({
    version: "1.0.0",
    usageEnabled: () => false,
    crashReportsEnabled: () => shared.telemetryAllowed(new shared.ConfigStore(files()).load(), "telemetry.crashReports"),
    terminal: () => null,
  });
}

async function launchedEvents(text) {
  if (text !== null) fs.writeFileSync(shared.SETTINGS_FILE, text);
  usageTelemetry(new SettingsManager(host, files())).launched();
  await settle();
  return [...received];
}

async function crashEvents(text) {
  if (text !== null) fs.writeFileSync(shared.SETTINGS_FILE, text);
  await crashTelemetry().crashed(new TypeError("boom"), "uncaughtException");
  return [...received];
}

const both = (value) => JSON.stringify({ "telemetry.usage": value, "telemetry.crashReports": value });
const only = (key, raw) => `{ "${key}": ${raw} }`;

const sends = [
  ["valid opt-in", both("on")],
  ["empty object", "{}"],
  ["empty file", ""],
  ["unrelated keys only", '{ "window.transparent": "on" }'],
  ["missing file", null],
];

const blocks = [
  ["trailing comma", '{ "telemetry.usage": "off", "telemetry.crashReports": "off", }'],
  ["comment", '// keep telemetry off\n{ "telemetry.usage": "off", "telemetry.crashReports": "off" }'],
  ["byte order mark", `﻿${both("off")}`],
  ["truncated", '{ "telemetry.usage": "off", "telemetry.cra'],
  ["not an object", '["off"]'],
];

describe("unit: telemetryAllowed and ConfigStore.load", () => {
  const load = (text) => {
    fs.writeFileSync(shared.SETTINGS_FILE, text);
    return new shared.ConfigStore(files()).load();
  };

  test("valid values decide, defaults apply to absent keys", () => {
    assert.equal(shared.telemetryAllowed(load(both("off")), "telemetry.usage"), false);
    assert.equal(shared.telemetryAllowed(load(both("on")), "telemetry.usage"), true);
    assert.equal(shared.telemetryAllowed(load("{}"), "telemetry.crashReports"), true);
    assert.equal(shared.telemetryAllowed(load(only("telemetry.usage", '"off"')), "telemetry.crashReports"), true);
  });

  test("an invalid telemetry value is reported and blocks only its own key", () => {
    const loaded = load(only("telemetry.usage", "false"));
    assert.deepEqual(loaded.invalidSettings, ["telemetry.usage"]);
    assert.equal(shared.telemetryAllowed(loaded, "telemetry.usage"), false);
    assert.equal(shared.telemetryAllowed(loaded, "telemetry.crashReports"), true);
  });

  test("an invalid unrelated value does not block telemetry or hide a valid opt-out", () => {
    const invalid = load(only("render.fps", '"fast"'));
    assert.deepEqual(invalid.invalidSettings, ["render.fps"]);
    assert.equal(shared.telemetryAllowed(invalid, "telemetry.usage"), true);
    const off = load(`{ "render.fps": "fast", "telemetry.usage": "off" }`);
    assert.equal(shared.telemetryAllowed(off, "telemetry.usage"), false);
  });

  test("an unparseable file has no settings and blocks both kinds", () => {
    const loaded = load("{ nope");
    assert.equal(loaded.settings, null);
    assert.equal(shared.telemetryAllowed(loaded, "telemetry.usage"), false);
    assert.equal(shared.telemetryAllowed(loaded, "telemetry.crashReports"), false);
  });

  test("an unreadable settings file is an error rather than empty settings", () => {
    fs.mkdirSync(shared.SETTINGS_FILE);
    const loaded = new shared.ConfigStore(files()).load();
    assert.equal(loaded.settings, null);
    assert.match(loaded.errors[0], /settings\.json: cannot read file \(EISDIR\)/);
    assert.equal(shared.telemetryAllowed(loaded, "telemetry.usage"), false);
  });

  test("a missing settings file is not an error", () => {
    const loaded = new shared.ConfigStore(files()).load();
    assert.deepEqual(loaded.errors, []);
    assert.equal(shared.telemetryAllowed(loaded, "telemetry.usage"), true);
  });
});

describe("integration: compiled Telemetry against a local collector", () => {
  test("valid opt-out sends nothing for either kind", async () => {
    assert.deepEqual(await launchedEvents(both("off")), []);
    assert.deepEqual(await crashEvents(null), []);
  });

  for (const [name, text] of sends) {
    test(`${name} keeps the default and sends usage`, async () => {
      assert.deepEqual(await launchedEvents(text), ["app_launched"]);
    });
    test(`${name} keeps the default and sends crash reports`, async () => {
      assert.deepEqual(await crashEvents(text), ["$exception"]);
    });
  }

  for (const [name, text] of blocks) {
    test(`${name} suppresses usage`, async () => {
      assert.deepEqual(await launchedEvents(text), []);
    });
    test(`${name} suppresses crash reports`, async () => {
      assert.deepEqual(await crashEvents(text), []);
    });
  }

  test("an unreadable file suppresses usage and crash reports", async () => {
    fs.mkdirSync(shared.SETTINGS_FILE);
    assert.deepEqual(await launchedEvents(null), []);
    assert.deepEqual(await crashEvents(null), []);
  });

  for (const key of ["telemetry.usage", "telemetry.crashReports"]) {
    const kind = key === "telemetry.usage" ? "usage" : "crash";
    const run = (text) => (kind === "usage" ? launchedEvents(text) : crashEvents(text));
    const expected = kind === "usage" ? ["app_launched"] : ["$exception"];
    for (const raw of ["false", "true", '"OFF"', '"On"', '"disabled"', "0", "null", '["off"]']) {
      test(`${key} set to ${raw} suppresses ${kind}`, async () => {
        assert.deepEqual(await run(only(key, raw)), []);
      });
    }
    test(`${key} valid opt-out suppresses ${kind}`, async () => {
      assert.deepEqual(await run(only(key, '"off"')), []);
    });
    test(`${key} valid opt-in sends ${kind}`, async () => {
      assert.deepEqual(await run(only(key, '"on"')), expected);
    });
    test(`the other key being invalid does not suppress ${kind}`, async () => {
      const other = key === "telemetry.usage" ? "telemetry.crashReports" : "telemetry.usage";
      assert.deepEqual(await run(only(other, "false")), expected);
    });
  }

  test("environment opt-out still wins over a valid opt-in", async () => {
    process.env.DO_NOT_TRACK = "1";
    try {
      assert.deepEqual(await launchedEvents(both("on")), []);
      assert.deepEqual(await crashEvents(null), []);
    } finally {
      delete process.env.DO_NOT_TRACK;
    }
  });

  test("nothing is sent while the file is broken, and the real setting applies once it is repaired", async () => {
    fs.writeFileSync(shared.SETTINGS_FILE, '{ "telemetry.usage": "on", }');
    const settings = new SettingsManager(host, files());
    const telemetry = usageTelemetry(settings);
    telemetry.launched();
    telemetry.used();
    await settle();
    assert.deepEqual(received, []);

    fs.writeFileSync(shared.SETTINGS_FILE, both("off"));
    settings.reload(true);
    telemetry.used();
    await settle();
    assert.deepEqual(received, []);

    fs.writeFileSync(shared.SETTINGS_FILE, both("on"));
    settings.reload(true);
    telemetry.used();
    await settle();
    assert.deepEqual(received, ["daily_active"]);
  });

  test("a file that breaks while running pauses usage until repaired", async () => {
    fs.writeFileSync(shared.SETTINGS_FILE, both("on"));
    const settings = new SettingsManager(host, files());
    const telemetry = usageTelemetry(settings);

    fs.writeFileSync(shared.SETTINGS_FILE, '{ "telemetry.usage": "off" // ');
    settings.reload(true);
    telemetry.used();
    await settle();
    assert.deepEqual(received, []);

    fs.writeFileSync(shared.SETTINGS_FILE, both("on"));
    settings.reload(true);
    telemetry.used();
    await settle();
    assert.deepEqual(received, ["daily_active"]);
  });

  test("crash reports follow the file on every report", async () => {
    const crash = crashTelemetry();
    fs.writeFileSync(shared.SETTINGS_FILE, "{");
    await crash.crashed(new Error("a"), "uncaughtException");
    assert.deepEqual(received, []);
    fs.writeFileSync(shared.SETTINGS_FILE, both("on"));
    await crash.crashed(new Error("b"), "uncaughtException");
    assert.deepEqual(received, ["$exception"]);
  });
});
