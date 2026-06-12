const fs = require("fs");
const path = require("path");

const LOG_DIR = path.join(process.cwd(), "logs");
const LOG_PATH = path.join(LOG_DIR, "events.ndjson");

function bigintReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function logEvent(record) {
  let line;

  try {
    line = JSON.stringify(record, bigintReplacer) + "\n";
  } catch (err) {
    console.error("event log stringify failed:", err.message);
    return;
  }

  fs.mkdir(LOG_DIR, { recursive: true }, (mkdirErr) => {
    if (mkdirErr) {
      console.error("event log mkdir failed:", mkdirErr.message);
      return;
    }

    fs.appendFile(LOG_PATH, line, (appendErr) => {
      if (appendErr) {
        console.error("event log append failed:", appendErr.message);
      }
    });
  });
}

module.exports = {
  LOG_PATH,
  logEvent
};