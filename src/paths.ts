import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * All paths are anchored here instead of process.cwd(), so the app behaves
 * the same cloned from git, `npm i -g`-installed, or run via npx (where the
 * package lives in an ephemeral cache and cwd is wherever the user happens
 * to be).
 */

/** Root of the installed package (this file lives in <root>/src/) */
export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Where user data (SQLite DB, user widgets) lives:
 * 1. $BUSYBAR_DATA_DIR if set
 * 2. <packageRoot>/data when a DB already exists there (git-clone dev setup)
 * 3. ~/.busybar-webos — the stable home for npx/global installs
 */
function resolveDataDir(): string {
  if (process.env.BUSYBAR_DATA_DIR) return path.resolve(process.env.BUSYBAR_DATA_DIR);
  const legacy = path.join(packageRoot, 'data');
  if (fs.existsSync(path.join(legacy, 'busybar.db'))) return legacy;
  return path.join(os.homedir(), '.busybar-webos');
}

export const dataDir = resolveDataDir();

/** Widgets shipped with the package */
export const packageWidgetsDir = path.join(packageRoot, 'widgets');

/** Extra widgets the user drops in <dataDir>/widgets — survive package updates */
export const userWidgetsDir = path.join(dataDir, 'widgets');

/** Static portal files shipped with the package */
export const publicDir = path.join(packageRoot, 'public');
