const express = require('express');
const path = require('path');
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
`);

const movieCols = db.prepare('PRAGMA table_info(movies)').all().map(c => c.name);
if (!movieCols.includes('poster_url')) db.exec('ALTER TABLE movies ADD COLUMN poster_url TEXT');
if (!movieCols.includes('backdrop_url')) db.exec('ALTER TABLE movies ADD COLUMN backdrop_url TEXT');

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

async function searchProvider(q) {
  if (TMDB_TOKEN || TMDB_KEY) {
    const url = `https://api.themoviedb.org/3/search/movie?query=${encodeURIComponent(q)}`
      + (TMDB_KEY ? `&api_key=${TMDB_KEY}` : '');
    const res = await fetch(url, TMDB_TOKEN ? { headers: { Authorization: `Bearer ${TMDB_TOKEN}` } } : {});
    if (!res.ok) throw new Error('TMDB request failed');
    const data = await res.json();
    return (data.results || []).slice(0, 10).map(r => ({
      title: r.title,
      year: r.release_date ? parseInt(r.release_date.slice(0, 4)) : null,
      genre: '',
      description: r.overview || '',
      poster_url: r.poster_path ? `https://image.tmdb.org/t/p/w500${r.poster_path}` : null,
      backdrop_url: r.backdrop_path ? `https://image.tmdb.org/t/p/w780${r.backdrop_path}` : null
    }));
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

// Fill in missing artwork for catalog movies (runs in the background at
// startup; placeholders stay if the network is down). Never overwrites art a
// movie already has — only fills the gaps, e.g. adding TMDB widescreen
// backdrops to movies that so far only had an IMDb poster.
(async () => {
  const missing = db.prepare('SELECT id, title, year FROM movies WHERE poster_url IS NULL OR backdrop_url IS NULL').all();
  for (const m of missing) {
    try {
      const results = await searchProvider(m.title);
      const best = results.find(r => r.poster_url && (!m.year || !r.year || Math.abs(r.year - m.year) <= 1))
        || results.find(r => r.poster_url);
      if (best) db.prepare(`
        UPDATE movies SET poster_url = COALESCE(poster_url, ?), backdrop_url = COALESCE(backdrop_url, ?)
        WHERE id = ?
      `).run(best.poster_url, best.backdrop_url, m.id);
    } catch (e) { /* offline or rate limited — existing art or placeholder stays */ }
  }
})();

const app = express();
app.use(express.json());
app.use(cookieSession({
  name: 'moviqe',
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me-in-production',
  maxAge: 30 * 24 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax'
}));
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  next();
}

const publicUser = u => ({
  id: u.id, username: u.username, bio: u.bio,
  bg_color: u.bg_color, accent_color: u.accent_color, avatar_color: u.avatar_color,
  created_at: u.created_at
});

const httpsUrl = v => (typeof v === 'string' && /^https:\/\/\S+$/.test(v)) ? v.slice(0, 500) : null;

// ---- Auth ----
app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-20 characters (letters, numbers, _)' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  try {
    const info = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
      .run(username, bcrypt.hashSync(password, 10));
    req.session.userId = info.lastInsertRowid;
    res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)));
  } catch (e) {
    res.status(409).json({ error: 'Username already taken' });
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username || '');
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Wrong username or password' });
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
  res.json({ user: publicUser(user), stats, favorites, reviewed });
});

// ---- Movie search (external provider) ----
app.get('/api/search', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
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
    GROUP BY m.id ORDER BY m.title
  `).all(uid));
});

app.get('/api/movies/:id', (req, res) => {
  const uid = req.session.userId || 0;
  const movie = db.prepare(`
    SELECT m.*, ROUND(AVG(r.stars), 1) AS avg_stars, COUNT(r.id) AS review_count,
      (SELECT COUNT(*) FROM likes l WHERE l.movie_id = m.id) AS like_count,
      EXISTS(SELECT 1 FROM likes l WHERE l.movie_id = m.id AND l.user_id = ?) AS liked
    FROM movies m LEFT JOIN reviews r ON r.movie_id = m.id
    WHERE m.id = ? GROUP BY m.id
  `).get(uid, req.params.id);
  if (!movie) return res.status(404).json({ error: 'Movie not found' });
  movie.reviews = db.prepare(`
    SELECT r.id, r.stars, r.text, r.created_at, u.username, u.avatar_color, r.user_id
    FROM reviews r JOIN users u ON u.id = r.user_id
    WHERE r.movie_id = ? ORDER BY r.created_at DESC
  `).all(req.params.id);
  res.json(movie);
});

app.post('/api/movies', requireAuth, (req, res) => {
  const { title, year, genre, description, poster_url, backdrop_url } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
  const t = title.trim().slice(0, 200);
  const y = parseInt(year) || null;
  const dupe = db.prepare('SELECT id FROM movies WHERE lower(title) = lower(?) AND (year IS ? OR year = ?)').get(t, y, y);
  if (dupe) return res.status(409).json({ error: 'That movie is already in the catalog' });
  const info = db.prepare(`
    INSERT INTO movies (title, year, genre, description, poster_url, backdrop_url, added_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(t, y, (genre || '').slice(0, 50), (description || '').slice(0, 1000),
    httpsUrl(poster_url), httpsUrl(backdrop_url), req.session.userId);
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

app.listen(PORT, () => console.log(`Moviqe running on http://localhost:${PORT}`));
