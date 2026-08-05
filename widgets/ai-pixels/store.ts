import { db } from '../../src/db';

/**
 * Saved creations: the raw movie text is tiny (~2KB) and re-parsable, so a
 * creation can be replayed with zero AI calls, or handed back to the model
 * as the base for a refinement.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_pixels_movies (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt     TEXT NOT NULL,
    movie      TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

const MAX_SAVED = 50;

const insert = db.prepare('INSERT INTO ai_pixels_movies (prompt, movie, created_at) VALUES (?, ?, ?)');
const prune = db.prepare(`
  DELETE FROM ai_pixels_movies
  WHERE id <= (
    SELECT id FROM ai_pixels_movies ORDER BY id DESC LIMIT 1 OFFSET ${MAX_SAVED}
  )
`);
const selectAll = db.prepare('SELECT id, prompt, created_at FROM ai_pixels_movies ORDER BY id DESC');
const selectOne = db.prepare('SELECT id, prompt, movie, created_at FROM ai_pixels_movies WHERE id = ?');

export interface SavedMovieSummary {
  id: number;
  prompt: string;
  created_at: number;
}

export interface SavedMovie extends SavedMovieSummary {
  movie: string;
}

export function saveMovie(prompt: string, movie: string): void {
  insert.run(prompt, movie, Date.now());
  prune.run();
}

export function listMovies(): SavedMovieSummary[] {
  return selectAll.all() as SavedMovieSummary[];
}

export function getMovie(id: number): SavedMovie | undefined {
  return selectOne.get(id) as SavedMovie | undefined;
}
