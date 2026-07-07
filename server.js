const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const cookieSession = require('cookie-session');

// Load .env (kept out of git) into process.env — real env vars win
try {
  require('fs').readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach(line => {
    const m = line.match(/^\s*(\w+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  });
} catch (e) { /* no .env file — fine */ }

const PORT = process.env.PORT || 3000;
const TMDB_KEY = process.env.TMDB_API_KEY;      // short "API Key" — sent as query param
const TMDB_TOKEN = process.env.TMDB_TOKEN;      // long "API Read Access Token" — sent as bearer header

// Session secret: env var wins. Otherwise generate a random one and keep it in
// a gitignored file, so cookies survive restarts and no guessable default
// ever ships to production.
let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  const secretFile = path.join(__dirname, '.secret');
  if (!fs.existsSync(secretFile)) {
    fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  SESSION_SECRET = fs.readFileSync(secretFile, 'utf8').trim();
}
const db = new Database(path.join(__dirname, 'moviqe.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  bio TEXT DEFAULT '',
  bg_color TEXT DEFAULT '#12121a',
  accent_color TEXT DEFAULT '#e8b23a',
  avatar_color TEXT DEFAULT '#7c5cff',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS movies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  year INTEGER,
  genre TEXT,
  description TEXT,
  added_by INTEGER REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  movie_id INTEGER NOT NULL REFERENCES movies(id),
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  text TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, movie_id)
);
CREATE TABLE IF NOT EXISTS likes (
  user_id INTEGER NOT NULL REFERENCES users(id),
  movie_id INTEGER NOT NULL REFERENCES movies(id),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, movie_id)
);
CREATE TABLE IF NOT EXISTS lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'ranked' CHECK (kind IN ('ranked', 'random')),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS list_items (
  list_id INTEGER NOT NULL REFERENCES lists(id),
  movie_id INTEGER NOT NULL REFERENCES movies(id),
  position INTEGER NOT NULL,
  UNIQUE(list_id, movie_id)
);
`);

const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
if (!userCols.includes('avatar_url')) db.exec('ALTER TABLE users ADD COLUMN avatar_url TEXT');
if (!userCols.includes('email')) db.exec('ALTER TABLE users ADD COLUMN email TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL');

const movieCols = db.prepare('PRAGMA table_info(movies)').all().map(c => c.name);
[
  ['poster_url', 'poster_url TEXT'],
  ['backdrop_url', 'backdrop_url TEXT'],
  ['tmdb_id', 'tmdb_id INTEGER'],
  ['popularity', 'popularity REAL'],
  ['runtime', 'runtime INTEGER'],
  ['cast_json', 'cast_json TEXT'],
  ['providers_json', 'providers_json TEXT'],
  ['details_at', 'details_at TEXT'],
  ['vote_average', 'vote_average REAL'],
  ['vote_count', 'vote_count INTEGER'],
  ['imdb_id', 'imdb_id TEXT'],
  ['scores_json', 'scores_json TEXT']
].forEach(([name, ddl]) => {
  if (!movieCols.includes(name)) db.exec(`ALTER TABLE movies ADD COLUMN ${ddl}`);
});

// Seed a starter catalog on first run
if (db.prepare('SELECT COUNT(*) AS n FROM movies').get().n === 0) {
  const seed = db.prepare('INSERT INTO movies (title, year, genre, description) VALUES (?, ?, ?, ?)');
  [
    ['The Shawshank Redemption', 1994, 'Drama', 'A banker sentenced to life in Shawshank prison forms a decades-long friendship.'],
    ['The Godfather', 1972, 'Crime', 'The aging patriarch of a crime dynasty transfers control to his reluctant son.'],
    ['The Dark Knight', 2008, 'Action', 'Batman faces the Joker, a criminal mastermind who wants to watch the world burn.'],
    ['Pulp Fiction', 1994, 'Crime', 'The lives of two hitmen, a boxer and a gangster intertwine in Los Angeles.'],
    ['Inception', 2010, 'Sci-Fi', 'A thief who steals secrets through dreams is given a chance to erase his past.'],
    ['Spirited Away', 2001, 'Animation', 'A girl wanders into a world of spirits and must work to free her parents.'],
    ['Parasite', 2019, 'Thriller', 'A poor family schemes its way into the household of a wealthy one.'],
    ['Interstellar', 2014, 'Sci-Fi', 'Explorers travel through a wormhole in search of a new home for humanity.'],
    ['The Matrix', 1999, 'Sci-Fi', 'A hacker discovers reality is a simulation and joins the rebellion against it.'],
    ['Forrest Gump', 1994, 'Drama', 'Decades of American history unfold through the eyes of a slow-witted but kind man.'],
    ['Whiplash', 2014, 'Drama', 'A young drummer is pushed to his limits by a ruthless music instructor.'],
    ['La La Land', 2016, 'Musical', 'A jazz pianist and an aspiring actress chase their dreams in Los Angeles.']
  ].forEach(m => seed.run(...m));
}

// ---- Movie data provider ----
// Default source is IMDb's public suggestion API (the endpoint imdb.com's own
// search box uses) — no key needed, returns titles, years and poster art.
// If TMDB_API_KEY is set, TMDB is used instead: richer plots, genres and real
// widescreen banner images.
function imdbImage(url) {
  // Ask IMDb's image CDN for an 800px-wide version instead of the full-size scan
  return url ? url.replace('._V1_.', '._V1_QL75_UX800_.') : null;
}

const tmdbEnabled = () => Boolean(TMDB_TOKEN || TMDB_KEY);

async function tmdb(pathq) {
  const url = `https://api.themoviedb.org/3${pathq}`
    + (TMDB_KEY ? (pathq.includes('?') ? '&' : '?') + 'api_key=' + TMDB_KEY : '');
  const res = await fetch(url, TMDB_TOKEN ? { headers: { Authorization: `Bearer ${TMDB_TOKEN}` } } : {});
  if (!res.ok) throw new Error('TMDB request failed: ' + res.status);
  return res.json();
}

const tmdbMovie = r => ({
  title: r.title,
  year: r.release_date ? parseInt(r.release_date.slice(0, 4)) : null,
  genre: '',
  description: r.overview || '',
  poster_url: r.poster_path ? `https://image.tmdb.org/t/p/w500${r.poster_path}` : null,
  backdrop_url: r.backdrop_path ? `https://image.tmdb.org/t/p/w780${r.backdrop_path}` : null,
  tmdb_id: r.id,
  popularity: r.popularity || null,
  vote_average: r.vote_average || null,
  vote_count: r.vote_count || null
});

async function searchProvider(q) {
  if (tmdbEnabled()) {
    const data = await tmdb(`/search/movie?query=${encodeURIComponent(q)}`);
    return (data.results || []).slice(0, 10).map(tmdbMovie);
  }
  const slug = q.toLowerCase().trim();
  const bucket = /^[a-z0-9]/.test(slug) ? slug[0] : 'x';
  const res = await fetch(`https://v2.sg.media-imdb.com/suggestion/${bucket}/${encodeURIComponent(slug)}.json`);
  if (!res.ok) throw new Error('IMDb request failed');
  const data = await res.json();
  return (data.d || [])
    .filter(r => r.qid === 'movie' || r.qid === 'tvMovie')
    .slice(0, 10)
    .map(r => ({
      title: r.l,
      year: r.y || null,
      genre: '',
      description: r.s ? `Starring ${r.s}.` : '',
      poster_url: r.i ? imdbImage(r.i.imageUrl) : null,
      backdrop_url: null
    }));
}

// Pull TMDB's popular-movies list into the catalog so the landing page has a
// long list out of the box. Safe to run on every start: movies already in the
// catalog (by tmdb_id, or by title+year for pre-TMDB entries) are skipped or
// linked, never duplicated.
async function importPopular() {
  if (!tmdbEnabled()) return;
  let genreMap = {};
  try {
    genreMap = Object.fromEntries((await tmdb('/genre/movie/list')).genres.map(g => [g.id, g.name]));
  } catch (e) { /* genres stay blank */ }
  const insert = db.prepare(`
    INSERT INTO movies (title, year, genre, description, poster_url, backdrop_url, tmdb_id, popularity, vote_average, vote_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let page = 1; page <= 5; page++) {
    const data = await tmdb(`/movie/popular?page=${page}`);
    for (const r of (data.results || [])) {
      const m = tmdbMovie(r);
      if (db.prepare('SELECT 1 FROM movies WHERE tmdb_id = ?').get(m.tmdb_id)) continue;
      const existing = db.prepare(
        'SELECT id FROM movies WHERE tmdb_id IS NULL AND lower(title) = lower(?) AND year IS ?'
      ).get(m.title, m.year);
      if (existing) {
        db.prepare(`
          UPDATE movies SET tmdb_id = ?, popularity = ?, vote_average = ?, vote_count = ?,
            poster_url = COALESCE(poster_url, ?), backdrop_url = COALESCE(backdrop_url, ?)
          WHERE id = ?
        `).run(m.tmdb_id, m.popularity, m.vote_average, m.vote_count, m.poster_url, m.backdrop_url, existing.id);
        continue;
      }
      const genre = (r.genre_ids || []).slice(0, 2).map(i => genreMap[i]).filter(Boolean).join(' · ');
      insert.run(m.title, m.year, genre, m.description, m.poster_url, m.backdrop_url,
        m.tmdb_id, m.popularity, m.vote_average, m.vote_count);
    }
  }
}

// Fill gaps for movies that predate the TMDB link: missing artwork, tmdb_id
// or popularity. Never overwrites values a movie already has.
async function enrichCatalog() {
  const missing = db.prepare(`
    SELECT id, title, year FROM movies
    WHERE poster_url IS NULL OR backdrop_url IS NULL OR tmdb_id IS NULL OR vote_average IS NULL
  `).all();
  for (const m of missing) {
    try {
      const results = await searchProvider(m.title);
      const best = results.find(r => r.poster_url && (!m.year || !r.year || Math.abs(r.year - m.year) <= 1))
        || results.find(r => r.poster_url);
      if (best) db.prepare(`
        UPDATE movies SET poster_url = COALESCE(poster_url, ?), backdrop_url = COALESCE(backdrop_url, ?),
          tmdb_id = COALESCE(tmdb_id, ?), popularity = COALESCE(popularity, ?),
          vote_average = COALESCE(vote_average, ?), vote_count = COALESCE(vote_count, ?)
        WHERE id = ?
      `).run(best.poster_url, best.backdrop_url, best.tmdb_id || null, best.popularity || null,
        best.vote_average || null, best.vote_count || null, m.id);
    } catch (e) { /* offline or rate limited — existing art or placeholder stays */ }
  }
}

(async () => {
  try { await importPopular(); } catch (e) { console.error('popular import failed:', e.message); }
  await enrichCatalog();
})();

const uploadsDir = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Railway/Render terminate TLS at a proxy

// Security headers on every response
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  });
  if (process.env.NODE_ENV === 'production') {
    res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});

// CSRF backstop on top of sameSite cookies: mutating requests must come from
// our own origin (browsers always send Origin on cross-site requests)
app.use((req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
    let originHost = null;
    try { originHost = new URL(req.headers.origin).host; } catch (e) { /* malformed */ }
    if (originHost !== req.headers.host) {
      return res.status(403).json({ error: 'Cross-origin request blocked' });
    }
  }
  next();
});

// Simple in-memory rate limiter (per IP)
function rateLimit(windowMs, max) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    if (hits.size > 10000) {
      for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
    }
    const rec = hits.get(req.ip) || { count: 0, start: now };
    if (now - rec.start > windowMs) { rec.count = 0; rec.start = now; }
    rec.count++;
    hits.set(req.ip, rec);
    if (rec.count > max) return res.status(429).json({ error: 'Too many requests — try again in a few minutes' });
    next();
  };
}
const authLimiter = rateLimit(15 * 60 * 1000, 20);   // login/register attempts
const apiLimiter = rateLimit(15 * 60 * 1000, 1000);  // everything else
app.use('/api/', apiLimiter);

// Small JSON bodies everywhere except the avatar upload and CSV import
const smallJson = express.json({ limit: '100kb' });
const bigJson = express.json({ limit: '10mb' });
const BIG_BODY_PATHS = ['/api/profile/avatar', '/api/import/letterboxd'];
app.use((req, res, next) => (BIG_BODY_PATHS.includes(req.path) ? bigJson : smallJson)(req, res, next));

app.use(cookieSession({
  name: 'moviqe',
  secret: SESSION_SECRET,
  maxAge: 30 * 24 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production'
}));
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (!req.session.userId || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(req.session.userId)) {
    req.session = null; // stale cookie for a user that no longer exists
    return res.status(401).json({ error: 'Not logged in' });
  }
  next();
}

// Clamp user-supplied numbers so nobody stores a fake "TMDB 99" score
const clamp = (v, min, max) => {
  const n = parseFloat(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

const publicUser = u => ({
  id: u.id, username: u.username, email: u.email || null, bio: u.bio,
  bg_color: u.bg_color, accent_color: u.accent_color, avatar_color: u.avatar_color,
  avatar_url: u.avatar_url || null,
  created_at: u.created_at
});

// Strict allowlist: rejects quotes, parens, spaces and angle brackets so a
// stored URL can never break out of the CSS url('...') it lands in.
const httpsUrl = v => (typeof v === 'string' && v.length <= 500
  && /^https:\/\/[A-Za-z0-9.-]+(?::\d{2,5})?(?:\/[A-Za-z0-9\-._~!$&+,;=:@%/?]*)?$/.test(v)) ? v : null;

// Compared against when the account doesn't exist, so a login attempt takes
// the same time either way (no username probing via response timing)
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);

// ---- Auth ----
function passwordProblem(password) {
  if (!password || password.length < 8) return 'Password must be at least 8 characters';
  if (password.length > 128) return 'Password too long (max 128 characters)';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return 'Password must contain at least one letter and one number';
  return null;
}

app.post('/api/register', authLimiter, (req, res) => {
  const { username, email, password } = req.body || {};
  if (!username || !/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-20 characters (letters, numbers, _)' });
  }
  const mail = String(email || '').trim().toLowerCase();
  if (!mail || mail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(mail)) {
    return res.status(400).json({ error: 'Enter a valid email address' });
  }
  const pwErr = passwordProblem(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  if (db.prepare('SELECT 1 FROM users WHERE lower(username) = lower(?)').get(username)) {
    return res.status(409).json({ error: 'Username already taken' });
  }
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(mail)) {
    return res.status(409).json({ error: 'An account with that email already exists' });
  }
  const info = db.prepare(`
    INSERT INTO users (username, email, password_hash, bg_color, accent_color, avatar_color)
    VALUES (?, ?, ?, '#12121a', '#f4c245', '#3d6be8')
  `).run(username, mail, bcrypt.hashSync(password, 10));
  req.session.userId = info.lastInsertRowid;
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)));
});

app.post('/api/login', authLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const id = String(username || '').trim();
  const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(id, id.toLowerCase());
  const ok = bcrypt.compareSync(String(password || ''), user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) {
    return res.status(401).json({ error: 'Wrong username/email or password' });
  }
  req.session.userId = user.id;
  res.json(publicUser(user));
});

app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json(null);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  res.json(user ? publicUser(user) : null);
});

// ---- Profile ----
app.put('/api/profile', requireAuth, (req, res) => {
  const { bio, bg_color, accent_color, avatar_color } = req.body || {};
  const hex = /^#[0-9a-fA-F]{6}$/;
  const cur = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  db.prepare('UPDATE users SET bio = ?, bg_color = ?, accent_color = ?, avatar_color = ? WHERE id = ?').run(
    typeof bio === 'string' ? bio.slice(0, 500) : cur.bio,
    hex.test(bg_color) ? bg_color : cur.bg_color,
    hex.test(accent_color) ? accent_color : cur.accent_color,
    hex.test(avatar_color) ? avatar_color : cur.avatar_color,
    req.session.userId
  );
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId)));
});

// The declared image type must match the actual file bytes — a renamed
// executable or HTML file gets rejected even with a valid-looking data URL
function looksLikeImage(type, buf) {
  if (buf.length < 12) return false;
  if (type === 'png') return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (type === 'jpeg') return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (type === 'webp') return buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP';
  return false;
}

// Profile picture upload: JSON body { image: "data:image/png;base64,..." }
app.post('/api/profile/avatar', requireAuth, (req, res) => {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec((req.body || {}).image || '');
  if (!m) return res.status(400).json({ error: 'Send a PNG, JPEG or WebP image' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 3 * 1024 * 1024) return res.status(400).json({ error: 'Image too large (max 3MB)' });
  if (!looksLikeImage(m[1], buf)) return res.status(400).json({ error: 'File does not look like a valid image' });
  const old = db.prepare('SELECT avatar_url FROM users WHERE id = ?').get(req.session.userId).avatar_url;
  const file = `av_${req.session.userId}_${Date.now()}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  fs.writeFileSync(path.join(uploadsDir, file), buf);
  db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run('/uploads/' + file, req.session.userId);
  if (old) fs.unlink(path.join(uploadsDir, path.basename(old)), () => {});
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId)));
});

app.get('/api/my-profile', requireAuth, (req, res) => {
  const uid = req.session.userId;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  const stats = {
    review_count: db.prepare('SELECT COUNT(*) AS n FROM reviews WHERE user_id = ?').get(uid).n,
    favorite_count: db.prepare('SELECT COUNT(*) AS n FROM likes WHERE user_id = ?').get(uid).n,
    avg_given: db.prepare('SELECT ROUND(AVG(stars), 1) AS a FROM reviews WHERE user_id = ?').get(uid).a
  };
  const favorites = db.prepare(`
    SELECT m.id, m.title, m.year, m.poster_url, m.backdrop_url
    FROM likes l JOIN movies m ON m.id = l.movie_id
    WHERE l.user_id = ? ORDER BY l.created_at DESC
  `).all(uid);
  const reviewed = db.prepare(`
    SELECT m.id, m.title, m.year, m.poster_url, m.backdrop_url, r.stars
    FROM reviews r JOIN movies m ON m.id = r.movie_id
    WHERE r.user_id = ? ORDER BY r.created_at DESC
  `).all(uid);
  const lists = db.prepare('SELECT * FROM lists WHERE user_id = ? ORDER BY id DESC').all(uid).map(l => ({
    ...l,
    count: db.prepare('SELECT COUNT(*) AS n FROM list_items WHERE list_id = ?').get(l.id).n,
    posters: db.prepare(`
      SELECT m.poster_url, m.backdrop_url, m.id FROM list_items li
      JOIN movies m ON m.id = li.movie_id
      WHERE li.list_id = ? ORDER BY li.position LIMIT 3
    `).all(l.id)
  }));
  res.json({ user: publicUser(user), stats, favorites, reviewed, lists });
});

// ---- Lists (ranked or random, shown on the profile) ----
function getList(id, uid) {
  const list = db.prepare('SELECT * FROM lists WHERE id = ? AND user_id = ?').get(id, uid);
  if (!list) return null;
  list.items = db.prepare(`
    SELECT li.position, m.id, m.title, m.year, m.poster_url, m.backdrop_url, r.stars
    FROM list_items li JOIN movies m ON m.id = li.movie_id
    LEFT JOIN reviews r ON r.movie_id = m.id AND r.user_id = ?
    WHERE li.list_id = ? ORDER BY li.position
  `).all(uid, id);
  return list;
}

app.post('/api/lists', requireAuth, (req, res) => {
  const { title, kind } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'List name is required' });
  if (db.prepare('SELECT COUNT(*) AS n FROM lists WHERE user_id = ?').get(req.session.userId).n >= 50) {
    return res.status(400).json({ error: 'List limit reached (50 per account)' });
  }
  const k = kind === 'random' ? 'random' : 'ranked';
  const info = db.prepare('INSERT INTO lists (user_id, title, kind) VALUES (?, ?, ?)')
    .run(req.session.userId, title.trim().slice(0, 100), k);
  if (k === 'random') {
    const add = db.prepare('INSERT INTO list_items (list_id, movie_id, position) VALUES (?, ?, ?)');
    db.prepare('SELECT id FROM movies ORDER BY RANDOM() LIMIT 10').all()
      .forEach((p, i) => add.run(info.lastInsertRowid, p.id, i + 1));
  }
  res.json(getList(info.lastInsertRowid, req.session.userId));
});

app.get('/api/lists/:id', requireAuth, (req, res) => {
  const list = getList(req.params.id, req.session.userId);
  if (!list) return res.status(404).json({ error: 'List not found' });
  res.json(list);
});

app.delete('/api/lists/:id', requireAuth, (req, res) => {
  const list = db.prepare('SELECT id FROM lists WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!list) return res.status(404).json({ error: 'List not found' });
  db.prepare('DELETE FROM list_items WHERE list_id = ?').run(list.id);
  db.prepare('DELETE FROM lists WHERE id = ?').run(list.id);
  res.json({ ok: true });
});

app.post('/api/lists/:id/items', requireAuth, (req, res) => {
  const list = db.prepare('SELECT id FROM lists WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!list) return res.status(404).json({ error: 'List not found' });
  const movieId = parseInt((req.body || {}).movie_id);
  if (!db.prepare('SELECT id FROM movies WHERE id = ?').get(movieId)) {
    return res.status(404).json({ error: 'Movie not found' });
  }
  if (db.prepare('SELECT COUNT(*) AS n FROM list_items WHERE list_id = ?').get(list.id).n >= 100) {
    return res.status(400).json({ error: 'List is full (100 movies max)' });
  }
  try {
    const next = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM list_items WHERE list_id = ?').get(list.id).p;
    db.prepare('INSERT INTO list_items (list_id, movie_id, position) VALUES (?, ?, ?)').run(list.id, movieId, next);
  } catch (e) {
    return res.status(409).json({ error: 'That movie is already in the list' });
  }
  res.json(getList(list.id, req.session.userId));
});

app.delete('/api/lists/:id/items/:movieId', requireAuth, (req, res) => {
  const list = db.prepare('SELECT id FROM lists WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!list) return res.status(404).json({ error: 'List not found' });
  db.prepare('DELETE FROM list_items WHERE list_id = ? AND movie_id = ?').run(list.id, req.params.movieId);
  res.json(getList(list.id, req.session.userId));
});

// Move an item up/down in a ranked list: { movie_id, dir: 'up' | 'down' }
app.post('/api/lists/:id/move', requireAuth, (req, res) => {
  const list = db.prepare('SELECT id FROM lists WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!list) return res.status(404).json({ error: 'List not found' });
  const { movie_id, dir } = req.body || {};
  const items = db.prepare('SELECT movie_id, position FROM list_items WHERE list_id = ? ORDER BY position').all(list.id);
  const i = items.findIndex(x => x.movie_id === parseInt(movie_id));
  const j = dir === 'up' ? i - 1 : i + 1;
  if (i >= 0 && j >= 0 && j < items.length) {
    const swap = db.prepare('UPDATE list_items SET position = ? WHERE list_id = ? AND movie_id = ?');
    swap.run(items[j].position, list.id, items[i].movie_id);
    swap.run(items[i].position, list.id, items[j].movie_id);
  }
  res.json(getList(list.id, req.session.userId));
});

// ---- Letterboxd import ----
// Letterboxd has no public API; users migrate via their official data export
// (Settings -> Data -> Export), a zip of CSVs. We accept ratings.csv and
// reviews.csv (kind "reviews") plus likes/films.csv (kind "likes").
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (rows.length < 2) return [];
  const header = rows[0].map(h => h.trim().toLowerCase());
  return rows.slice(1).map(r => Object.fromEntries(header.map((h, i) => [h, (r[i] || '').trim()])));
}

function findLocalMovie(title, year) {
  const cands = db.prepare('SELECT id, year FROM movies WHERE lower(title) = lower(?)').all(title);
  if (!cands.length) return null;
  if (year) {
    const hit = cands.find(c => c.year === year) || cands.find(c => c.year && Math.abs(c.year - year) <= 1);
    return hit ? hit.id : null; // same title, different year = probably a remake
  }
  return cands[0].id;
}

const importLimiter = rateLimit(60 * 60 * 1000, 5);

app.post('/api/import/letterboxd', requireAuth, importLimiter, async (req, res) => {
  const files = Array.isArray((req.body || {}).files) ? req.body.files.slice(0, 10) : [];
  if (!files.length) return res.status(400).json({ error: 'Upload at least one CSV from your Letterboxd export' });
  const uid = req.session.userId;
  const result = { reviews: 0, favorites: 0, added_movies: 0, skipped: 0, unmatched: [] };
  let tmdbLookups = 0;

  const skip = title => {
    result.skipped++;
    if (title && result.unmatched.length < 20 && !result.unmatched.includes(title)) result.unmatched.push(title);
  };

  // Find the movie locally; otherwise pull it from TMDB into the catalog
  // (capped per import so one upload can't burn the API quota)
  const resolveMovie = async (title, year) => {
    const local = findLocalMovie(title, year);
    if (local) return local;
    if (!tmdbEnabled() || tmdbLookups >= 300) return null;
    tmdbLookups++;
    try {
      const results = await searchProvider(title);
      const best = results.find(r => year && r.year && Math.abs(r.year - year) <= 1)
        || (!year && results[0]) || null;
      if (!best) return null;
      if (best.tmdb_id) {
        const ex = db.prepare('SELECT id FROM movies WHERE tmdb_id = ?').get(best.tmdb_id);
        if (ex) return ex.id;
      }
      const info = db.prepare(`
        INSERT INTO movies (title, year, genre, description, poster_url, backdrop_url, tmdb_id, popularity, vote_average, vote_count, added_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(String(best.title).slice(0, 200), best.year, '', (best.description || '').slice(0, 1000),
        best.poster_url, best.backdrop_url, best.tmdb_id || null, best.popularity || null,
        best.vote_average || null, best.vote_count || null, uid);
      result.added_movies++;
      return info.lastInsertRowid;
    } catch (e) {
      return null;
    }
  };

  for (const f of files) {
    if (typeof f.content !== 'string' || f.content.length > 5 * 1024 * 1024) continue;
    const asLikes = f.kind === 'likes';
    for (const r of parseCsv(f.content).slice(0, 2000)) {
      const title = (r.name || '').slice(0, 200);
      const year = clamp(r.year, 1888, 2100);
      if (!title) { result.skipped++; continue; }
      if (asLikes) {
        const mid = await resolveMovie(title, year);
        if (!mid) { skip(title); continue; }
        try {
          db.prepare('INSERT INTO likes (user_id, movie_id) VALUES (?, ?)').run(uid, mid);
          result.favorites++;
        } catch (e) { /* already a favorite */ }
        continue;
      }
      // Letterboxd rates 0.5-5 in halves; our stars are 1-5 integers
      const rating = parseFloat(r.rating);
      if (!Number.isFinite(rating) || rating <= 0) { result.skipped++; continue; }
      const mid = await resolveMovie(title, year);
      if (!mid) { skip(title); continue; }
      const stars = Math.min(5, Math.max(1, Math.round(rating)));
      db.prepare(`
        INSERT INTO reviews (user_id, movie_id, stars, text) VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, movie_id) DO UPDATE SET stars = excluded.stars,
          text = CASE WHEN excluded.text != '' THEN excluded.text ELSE reviews.text END
      `).run(uid, mid, stars, (r.review || '').slice(0, 2000));
      result.reviews++;
    }
  }
  res.json(result);
});

// ---- Movie search (external provider) ----
app.get('/api/search', requireAuth, async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (!q) return res.json([]);
  try {
    res.json(await searchProvider(q));
  } catch (e) {
    res.status(502).json({ error: 'Movie search is unavailable right now' });
  }
});

// ---- Movies ----
app.get('/api/movies', (req, res) => {
  const uid = req.session.userId || 0;
  res.json(db.prepare(`
    SELECT m.*, ROUND(AVG(r.stars), 1) AS avg_stars, COUNT(r.id) AS review_count,
      (SELECT COUNT(*) FROM likes l WHERE l.movie_id = m.id) AS like_count,
      EXISTS(SELECT 1 FROM likes l WHERE l.movie_id = m.id AND l.user_id = ?) AS liked
    FROM movies m LEFT JOIN reviews r ON r.movie_id = m.id
    GROUP BY m.id ORDER BY m.popularity IS NULL, m.popularity DESC, m.title
  `).all(uid));
});

// Runtime, cast and where-to-watch come from TMDB the first time a movie is
// opened, then live in the local db. Providers are looked up for WATCH_REGION
// (default IL) with a US fallback; that data is licensed from JustWatch, so
// the UI shows attribution.
async function fetchDetails(movie) {
  const d = await tmdb(`/movie/${movie.tmdb_id}?append_to_response=credits,watch/providers`);
  const region = process.env.WATCH_REGION || 'IL';
  const all = (d['watch/providers'] && d['watch/providers'].results) || {};
  const prov = all[region] || all.US || null;
  const mapProv = arr => (arr || []).slice(0, 8).map(p => ({
    name: p.provider_name,
    logo: p.logo_path ? `https://image.tmdb.org/t/p/w92${p.logo_path}` : null
  }));
  const providers = prov ? {
    region: all[region] ? region : 'US',
    link: prov.link || null,
    stream: mapProv(prov.flatrate),
    rent: mapProv(prov.rent),
    buy: mapProv(prov.buy)
  } : null;
  const cast = ((d.credits && d.credits.cast) || []).slice(0, 8)
    .map(c => ({ name: c.name, character: c.character || '' }));
  // External audience scores: OMDb (free key) carries IMDb + Rotten Tomatoes.
  // Without a key the UI still shows the TMDB score and a link to IMDb.
  let scores = null;
  const imdbId = /^tt\d{1,12}$/.test(d.imdb_id || '') ? d.imdb_id : '';
  if (process.env.OMDB_API_KEY && imdbId) {
    try {
      const o = await (await fetch(`https://www.omdbapi.com/?apikey=${process.env.OMDB_API_KEY}&i=${imdbId}`)).json();
      const rating = src => ((o.Ratings || []).find(r => r.Source === src) || {}).Value || null;
      scores = {
        imdb: (o.imdbRating && o.imdbRating !== 'N/A') ? o.imdbRating : null,
        rt: rating('Rotten Tomatoes'),
        metacritic: rating('Metacritic')
      };
    } catch (e) { /* scores stay null; retried when details refresh */ }
  }
  db.prepare(`
    UPDATE movies SET runtime = ?, genre = COALESCE(NULLIF(genre, ''), ?),
      description = COALESCE(NULLIF(description, ''), ?),
      cast_json = ?, providers_json = ?, imdb_id = ?, scores_json = ?,
      vote_average = COALESCE(?, vote_average), vote_count = COALESCE(?, vote_count),
      details_at = datetime('now')
    WHERE id = ?
  `).run(
    d.runtime || null,
    (d.genres || []).slice(0, 3).map(g => g.name).join(' · '),
    d.overview || '',
    JSON.stringify(cast),
    providers ? JSON.stringify(providers) : null,
    imdbId,
    scores ? JSON.stringify(scores) : null,
    d.vote_average || null,
    d.vote_count || null,
    movie.id
  );
}

app.get('/api/movies/:id', async (req, res) => {
  const uid = req.session.userId || 0;
  const getMovie = () => db.prepare(`
    SELECT m.*, ROUND(AVG(r.stars), 1) AS avg_stars, COUNT(r.id) AS review_count,
      (SELECT COUNT(*) FROM likes l WHERE l.movie_id = m.id) AS like_count,
      EXISTS(SELECT 1 FROM likes l WHERE l.movie_id = m.id AND l.user_id = ?) AS liked
    FROM movies m LEFT JOIN reviews r ON r.movie_id = m.id
    WHERE m.id = ? GROUP BY m.id
  `).get(uid, req.params.id);
  let movie = getMovie();
  if (!movie) return res.status(404).json({ error: 'Movie not found' });
  // imdb_id === null means details predate the scores feature — refresh once
  if (movie.tmdb_id && tmdbEnabled() && (!movie.details_at || movie.imdb_id === null)) {
    try {
      await fetchDetails(movie);
      movie = getMovie();
    } catch (e) { /* show what we have; retried on next open */ }
  }
  movie.cast = movie.cast_json ? JSON.parse(movie.cast_json) : [];
  movie.providers = movie.providers_json ? JSON.parse(movie.providers_json) : null;
  movie.scores = movie.scores_json ? JSON.parse(movie.scores_json) : null;
  delete movie.cast_json;
  delete movie.providers_json;
  delete movie.scores_json;
  movie.reviews = db.prepare(`
    SELECT r.id, r.stars, r.text, r.created_at, u.username, u.avatar_color, u.avatar_url, r.user_id
    FROM reviews r JOIN users u ON u.id = r.user_id
    WHERE r.movie_id = ? ORDER BY r.created_at DESC
  `).all(req.params.id);
  res.json(movie);
});

const addMovieLimiter = rateLimit(60 * 60 * 1000, 30); // catalog spam cap per IP

app.post('/api/movies', requireAuth, addMovieLimiter, (req, res) => {
  const { title, year, genre, description, poster_url, backdrop_url, tmdb_id, popularity, vote_average, vote_count } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
  const t = title.trim().slice(0, 200);
  const y = clamp(year, 1888, 2100);
  const dupe = db.prepare('SELECT id FROM movies WHERE lower(title) = lower(?) AND (year IS ? OR year = ?)').get(t, y, y)
    || (parseInt(tmdb_id) ? db.prepare('SELECT id FROM movies WHERE tmdb_id = ?').get(parseInt(tmdb_id)) : null);
  if (dupe) return res.status(409).json({ error: 'That movie is already in the catalog' });
  const info = db.prepare(`
    INSERT INTO movies (title, year, genre, description, poster_url, backdrop_url, tmdb_id, popularity, vote_average, vote_count, added_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(t, y, (genre || '').slice(0, 50), (description || '').slice(0, 1000),
    httpsUrl(poster_url), httpsUrl(backdrop_url),
    parseInt(tmdb_id) || null, clamp(popularity, 0, 1e9),
    clamp(vote_average, 0, 10), clamp(vote_count, 0, 1e9), req.session.userId);
  res.json(db.prepare('SELECT * FROM movies WHERE id = ?').get(info.lastInsertRowid));
});

// ---- Likes (favorites) ----
app.post('/api/movies/:id/like', requireAuth, (req, res) => {
  const uid = req.session.userId;
  if (!db.prepare('SELECT id FROM movies WHERE id = ?').get(req.params.id)) {
    return res.status(404).json({ error: 'Movie not found' });
  }
  const exists = db.prepare('SELECT 1 FROM likes WHERE user_id = ? AND movie_id = ?').get(uid, req.params.id);
  if (exists) {
    db.prepare('DELETE FROM likes WHERE user_id = ? AND movie_id = ?').run(uid, req.params.id);
  } else {
    db.prepare('INSERT INTO likes (user_id, movie_id) VALUES (?, ?)').run(uid, req.params.id);
  }
  const like_count = db.prepare('SELECT COUNT(*) AS n FROM likes WHERE movie_id = ?').get(req.params.id).n;
  res.json({ liked: !exists, like_count });
});

// ---- Reviews ----
app.post('/api/movies/:id/review', requireAuth, (req, res) => {
  const { stars, text } = req.body || {};
  const s = parseInt(stars);
  if (!s || s < 1 || s > 5) return res.status(400).json({ error: 'Rating must be 1-5 stars' });
  if (!db.prepare('SELECT id FROM movies WHERE id = ?').get(req.params.id)) {
    return res.status(404).json({ error: 'Movie not found' });
  }
  db.prepare(`
    INSERT INTO reviews (user_id, movie_id, stars, text) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, movie_id) DO UPDATE SET stars = excluded.stars, text = excluded.text, created_at = datetime('now')
  `).run(req.session.userId, req.params.id, s, (text || '').slice(0, 2000));
  res.json({ ok: true });
});

app.get('/api/my-reviews', requireAuth, (req, res) => {
  res.json(db.prepare(`
    SELECT r.id, r.stars, r.text, r.created_at, m.title, m.year, m.id AS movie_id, m.poster_url
    FROM reviews r JOIN movies m ON m.id = r.movie_id
    WHERE r.user_id = ? ORDER BY r.created_at DESC
  `).all(req.session.userId));
});

// JSON errors only — no stack traces or HTML error pages leave the server
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
  console.error(err.message);
  res.status(err.status || 400).json({ error: 'Bad request' });
});

app.listen(PORT, () => console.log(`Moviqe running on http://localhost:${PORT}`));
