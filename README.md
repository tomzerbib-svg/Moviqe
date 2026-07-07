# Moviqe

A movie rating platform. Users sign up, rate movies 1-5 stars, write reviews, and customize their profile colors.

## Run locally

```bash
cd moviqe
npm install
npm start
# open http://localhost:3000
```

## Stack

- **Backend:** Node.js + Express, SQLite (`better-sqlite3`) — one file (`moviqe.db`), zero external services
- **Auth:** bcrypt password hashing + signed session cookies (`cookie-session`)
- **Frontend:** vanilla HTML/CSS/JS in `public/`, no build step
- **Movie data:** TMDB via the `TMDB_TOKEN` env var (read access token in `.env`) — popular-movies catalog, banners, runtime, cast, watch providers (JustWatch data, region set by `WATCH_REGION`, default IL) and the TMDB audience score. Falls back to IMDb's public suggestion API without a token. Optional: set `OMDB_API_KEY` (free at omdbapi.com) to also show IMDb and Rotten Tomatoes scores.
- **PWA:** `manifest.webmanifest` + `sw.js` make it installable on phones (Add to Home Screen). Bump the cache version in `sw.js` when deploying static-file changes.

## Things to swap later

- **Logo:** `public/logo.svg` is a placeholder. Replace the file with the B3 logo export (keep the name `logo.svg`); nothing else needs changing.
- **Export to social media:** the button exists in the My Reviews tab. Implement it in `exportReview(reviewId)` in `public/app.js` (marked with `TODO(export)`).
- **Session secret:** in production set the `SESSION_SECRET` environment variable to a long random string.

## Security

- Registration requires a unique email and a password of 8+ characters with a letter and a number; login works with username or email. Passwords are bcrypt-hashed.
- Sessions: signed httpOnly cookies, `sameSite=lax`, `secure` in production. The secret comes from `SESSION_SECRET`, or a random one auto-generated into the gitignored `.secret` file.
- Rate limiting: 20 login/register attempts and 1000 API requests per IP per 15 minutes (in-memory — resets on restart).
- Login compares against a dummy hash when the account doesn't exist, so timing doesn't reveal which usernames are real.
- Security headers on every response: CSP, nosniff, frame denial, referrer and permissions policies. Mutating requests from a different origin are rejected.
- Avatar uploads are checked against real PNG/JPEG/WebP magic bytes, capped at 3MB; all other JSON bodies capped at 100KB.
- External URLs stored in the db pass a strict allowlist so they can't escape the CSS/HTML they're rendered into.
- Errors return generic JSON — no stack traces.

Before going live: set `NODE_ENV=production` and a strong `SESSION_SECRET` on the host.

## Deploying

See the deployment section in the chat, short version:

1. Push this folder to a GitHub repo.
2. Create a web service on Railway (or Render) pointing at the repo — start command `npm start`.
3. Attach a persistent volume/disk mounted where `moviqe.db` lives, otherwise the database resets on every deploy.
4. Set `SESSION_SECRET` in the service's environment variables.

## API overview

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | /api/register | – | Create account |
| POST | /api/login | – | Log in |
| POST | /api/logout | ✓ | Log out |
| GET | /api/me | – | Current user |
| PUT | /api/profile | ✓ | Update bio + colors |
| GET | /api/movies | – | List movies with avg rating |
| GET | /api/movies/:id | – | Movie details + reviews |
| POST | /api/movies | ✓ | Add a movie |
| POST | /api/movies/:id/review | ✓ | Create/update your rating + review |
| GET | /api/my-reviews | ✓ | Your reviews (with export button in UI) |
