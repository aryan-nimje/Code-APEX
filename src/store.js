'use strict';
// Tiny JSON-file project store (data/projects.json). Swap for a database later.
const fs = require('fs');
const path = require('path');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DIR, 'projects.json');

let cache = null;
let writing = Promise.resolve();

function load() {
  if (cache) return cache;
  fs.mkdirSync(DIR, { recursive: true });
  try {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!Array.isArray(cache)) cache = [];
  } catch (e) {
    cache = [];
  }
  return cache;
}

function flush() {
  const data = JSON.stringify(cache);
  writing = writing.then(
    () =>
      new Promise((resolve) => {
        const tmp = FILE + '.tmp';
        fs.writeFile(tmp, data, (err) => {
          if (err) return resolve();
          fs.rename(tmp, FILE, () => resolve());
        });
      })
  );
  return writing;
}

const list = () => load();

function upsert(p) {
  const L = load();
  const i = L.findIndex((x) => x.id === p.id);
  if (i < 0) L.push(p);
  else L[i] = p;
  return flush();
}

function remove(id) {
  cache = load().filter((x) => x.id !== id);
  return flush();
}

module.exports = { list, upsert, remove };
