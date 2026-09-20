// Ganditorul - deschide/initializeaza baza SQLite a serverului (conturi + chat).
// Acelasi tipar ca database/build_db.js: node:sqlite nativ, fara dependente.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'ganditorul_accounts.sqlite');
const SCHEMA_PATH = path.join(ROOT, 'schema.sql');

export const db = new DatabaseSync(DB_PATH);
db.exec(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
