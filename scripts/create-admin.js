'use strict';
/**
 * Create (or reset) an admin login from the server's command line.
 *   npm run create-admin
 * You type the name, login ID and password yourself – nothing is stored in plain text.
 */
const readline = require('readline');
const bcrypt = require('bcryptjs');
const db = require('../src/db');

function ask(q, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = function (s) { if (s.includes(q)) rl.output.write(s); else rl.output.write('*'); };
    }
    rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a.trim()); });
  });
}

(async () => {
  const name = await ask('Full name: ');
  const username = (await ask('Login ID (e.g. aniket): ')).toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) { console.error('Login ID must be 3–30 letters/numbers/._-'); process.exit(1); }
  const pw = await ask('Password (min 8 characters): ', true);
  const pw2 = await ask('Repeat password: ', true);
  if (pw.length < 8) { console.error('Password must be at least 8 characters.'); process.exit(1); }
  if (pw !== pw2) { console.error('Passwords do not match.'); process.exit(1); }
  const hash = bcrypt.hashSync(pw, 10);
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    db.prepare("UPDATE users SET name = ?, password_hash = ?, role = 'admin', active = 1 WHERE id = ?").run(name || username, hash, existing.id);
    console.log(`Updated admin "${username}".`);
  } else {
    db.prepare("INSERT INTO users (username, name, password_hash, role) VALUES (?,?,?, 'admin')").run(username, name || username, hash);
    console.log(`Created admin "${username}". Open the CRM and log in.`);
  }
})();
