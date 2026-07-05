// Moviqe frontend
const $ = sel => document.querySelector(sel);
let me = null;
let currentStars = 0;
let profileData = null;
let profileGridMode = 'favorites';
let currentList = null;

// ---- API helper ----
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || 'Request failed');
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 2500);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function starString(n) {
  const full = Math.round(n || 0);
  return '★'.repeat(full) + '☆'.repeat(5 - full);
}

// Deterministic gradient per movie when no banner image exists
function fallbackBanner(id) {
  const hues = [265, 210, 340, 20, 160, 45, 300, 190];
  const h = hues[id % hues.length];
  return `linear-gradient(135deg, hsl(${h}, 45%, 30%), hsl(${(h + 40) % 360}, 45%, 45%))`;
}

function bannerStyle(m) {
  const img = m.backdrop_url || m.poster_url;
  return img ? `background-image:url('${encodeURI(img)}')` : `background-image:${fallbackBanner(m.id)}`;
}

// Portrait art for poster-shaped cards (grid); banners stay widescreen
function posterStyle(m) {
  const img = m.poster_url || m.backdrop_url;
  return img ? `background-image:url('${encodeURI(img)}')` : `background-image:${fallbackBanner(m.id)}`;
}

// Avatar: uploaded photo if present, otherwise colored initial
function avatarHtml(user, cls = '') {
  if (user.avatar_url) {
    return `<img class="avatar ${cls}" src="${encodeURI(user.avatar_url)}" alt="">`;
  }
  return `<div class="avatar ${cls}" style="background:${escapeHtml(user.avatar_color)}">${escapeHtml((user.username || '?')[0].toUpperCase())}</div>`;
}

// ---- Theme ----
function applyTheme() {
  const r = document.documentElement.style;
  if (me) {
    r.setProperty('--bg', me.bg_color);
    r.setProperty('--accent', me.accent_color);
    r.setProperty('--avatar', me.avatar_color);
  } else {
    r.removeProperty('--bg');
    r.removeProperty('--accent');
    r.removeProperty('--avatar');
  }
}

// ---- Views ----
function showApp() {
  $('#auth-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  $('#nav').classList.remove('hidden');
  applyTheme();
  switchTab('movies');
}

function showAuth() {
  $('#auth-view').classList.remove('hidden');
  $('#app-view').classList.add('hidden');
  $('#nav').classList.add('hidden');
  applyTheme();
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.add('hidden'));
  document.querySelectorAll('.nav-btn[data-tab]').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === name));
  $('#tab-' + name).classList.remove('hidden');
  if (name === 'movies') loadMovies();
  if (name === 'my-reviews') loadMyReviews();
  if (name === 'profile') loadProfile();
}

// ---- Movies ----
let allMovies = [];

function renderMovieGrid() {
  const q = $('#movie-filter').value.trim().toLowerCase();
  const movies = q ? allMovies.filter(m => m.title.toLowerCase().includes(q)) : allMovies;
  $('#movie-grid').innerHTML = movies.length ? movies.map(m => `
    <div class="movie-card" data-id="${m.id}" style="${posterStyle(m)}">
      <div class="banner-overlay">
        <h3>${escapeHtml(m.title)}</h3>
        <div class="banner-meta">
          <span>${m.year || ''}</span>
          <span class="stars-display">${starString(m.avg_stars)} (${m.review_count})</span>
        </div>
      </div>
    </div>
  `).join('') : '<div class="grid-empty">No movies match your search.</div>';
  document.querySelectorAll('.movie-card').forEach(c =>
    c.addEventListener('click', () => openMovie(c.dataset.id)));
}

async function loadMovies() {
  allMovies = await api('/api/movies');
  renderMovieGrid();
}

$('#movie-filter').addEventListener('input', renderMovieGrid);

// ---- Movie detail ----
function fmtRuntime(mins) {
  return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
}

function scoreBadges(m) {
  const badges = [];
  if (m.vote_average) {
    badges.push(`<span class="score-badge tmdb" title="${m.vote_count || 0} votes on TMDB">TMDB ${m.vote_average.toFixed(1)}</span>`);
  }
  if (m.scores && m.scores.imdb) {
    badges.push(`<span class="score-badge imdb">IMDb ${escapeHtml(m.scores.imdb)}</span>`);
  } else if (m.imdb_id) {
    badges.push(`<a class="score-badge imdb" href="https://www.imdb.com/title/${encodeURIComponent(m.imdb_id)}/" target="_blank" rel="noopener">IMDb ↗</a>`);
  }
  if (m.scores && m.scores.rt) {
    badges.push(`<span class="score-badge rt">🍅 ${escapeHtml(m.scores.rt)}</span>`);
  }
  return badges.join('');
}

function providersHtml(p) {
  if (!p) return '<p class="muted">No streaming availability found for your region.</p>';
  const group = (label, arr) => (arr && arr.length) ? `
    <div class="prov-group">
      <span class="prov-label">${label}</span>
      <div class="prov-logos">
        ${arr.map(x => `<span class="prov">${x.logo ? `<img src="${encodeURI(x.logo)}" alt="">` : ''}${escapeHtml(x.name)}</span>`).join('')}
      </div>
    </div>` : '';
  const groups = group('Stream', p.stream) + group('Rent', p.rent) + group('Buy', p.buy);
  return (groups || '<p class="muted">No streaming availability found for your region.</p>')
    + `<p class="muted attribution">Availability in ${escapeHtml(p.region)} · streaming data by JustWatch${p.link ? ` · <a href="${encodeURI(p.link)}" target="_blank" rel="noopener">more options</a>` : ''}</p>`;
}

async function openMovie(id) {
  const m = await api('/api/movies/' + id);
  const mine = m.reviews.find(r => r.user_id === me.id);
  currentStars = mine ? mine.stars : 0;

  $('#movie-detail').innerHTML = `
    <div class="detail-banner" style="${bannerStyle(m)}">
      <div class="banner-overlay">
        <h3>${escapeHtml(m.title)} <span class="muted">(${m.year || '—'})</span></h3>
        <div class="banner-meta">
          <span>${escapeHtml(m.genre || '')}${m.runtime ? ` · ${fmtRuntime(m.runtime)}` : ''}</span>
          <span class="stars-display">${starString(m.avg_stars)} ${m.avg_stars || '—'} · ${m.review_count} review(s)</span>
        </div>
      </div>
    </div>
    <div class="detail-body">
      <div class="detail-actions">
        <button id="like-btn" class="like-btn ${m.liked ? 'liked' : ''}">
          ${m.liked ? '♥ In favorites' : '♡ Add to favorites'} · <span id="like-count">${m.like_count}</span>
        </button>
        ${scoreBadges(m)}
      </div>
      <p>${escapeHtml(m.description || '')}</p>

      <div class="review-card">
        <h4>${mine ? 'Update your review' : 'Rate & review'}</h4>
        <div class="star-input" id="star-input">
          ${[1, 2, 3, 4, 5].map(i => `<span data-v="${i}">★</span>`).join('')}
        </div>
        <form id="review-form">
          <textarea id="review-text" rows="3" placeholder="Write your review (optional)">${escapeHtml(mine ? mine.text : '')}</textarea>
          <div class="review-form-actions">
            <button type="submit" class="primary">${mine ? 'Update review' : 'Post review'}</button>
            <button type="button" class="export-btn" id="detail-export">Export to social media</button>
          </div>
        </form>
      </div>

      <div class="detail-cols">
        <div>
          <h4>Cast</h4>
          ${m.cast.length ? `
            <div class="cast-list">
              ${m.cast.map(c => `<span class="chip"><strong>${escapeHtml(c.name)}</strong>${c.character ? ` · ${escapeHtml(c.character)}` : ''}</span>`).join('')}
            </div>` : '<p class="muted">No cast information.</p>'}
        </div>
        <div>
          <h4>Where to watch</h4>
          ${providersHtml(m.providers)}
        </div>
      </div>

      <h4>Reviews</h4>
      <div id="movie-reviews">
        ${m.reviews.length ? m.reviews.map(r => `
          <div class="review-item">
            <div class="review-head">
              ${avatarHtml(r, 'avatar-sm')}
              <strong>${escapeHtml(r.username)}</strong>
              <span class="stars-display">${starString(r.stars)}</span>
            </div>
            ${r.text ? `<p class="review-text">${escapeHtml(r.text)}</p>` : ''}
          </div>
        `).join('') : '<p class="muted">No reviews yet. Be the first!</p>'}
      </div>
    </div>
  `;

  const paintStars = () => {
    document.querySelectorAll('#star-input span').forEach(s =>
      s.classList.toggle('lit', +s.dataset.v <= currentStars));
  };
  paintStars();
  document.querySelectorAll('#star-input span').forEach(s =>
    s.addEventListener('click', () => { currentStars = +s.dataset.v; paintStars(); }));

  $('#like-btn').addEventListener('click', async () => {
    try {
      const r = await api(`/api/movies/${id}/like`, { method: 'POST' });
      const btn = $('#like-btn');
      btn.classList.toggle('liked', r.liked);
      btn.innerHTML = `${r.liked ? '♥ In favorites' : '♡ Add to favorites'} · <span id="like-count">${r.like_count}</span>`;
    } catch (err) { toast(err.message); }
  });

  $('#detail-export').addEventListener('click', () => exportReview(mine ? mine.id : null));

  $('#review-form').addEventListener('submit', async e => {
    e.preventDefault();
    if (!currentStars) return toast('Pick a star rating first');
    try {
      await api(`/api/movies/${id}/review`, { method: 'POST', body: { stars: currentStars, text: $('#review-text').value } });
      toast('Review saved');
      $('#movie-modal').classList.add('hidden');
      loadMovies();
    } catch (err) { toast(err.message); }
  });

  $('#movie-modal').classList.remove('hidden');
}

// ---- My Reviews ----
async function loadMyReviews() {
  const reviews = await api('/api/my-reviews');
  $('#my-reviews-list').innerHTML = reviews.length ? reviews.map(r => `
    <div class="review-item">
      <div class="review-head">
        ${r.poster_url ? `<img class="review-thumb" src="${encodeURI(r.poster_url)}" alt="">` : ''}
        <strong>${escapeHtml(r.title)}</strong>
        <span class="muted">(${r.year || '—'})</span>
        <span class="stars-display">${starString(r.stars)}</span>
      </div>
      ${r.text ? `<p class="review-text">${escapeHtml(r.text)}</p>` : ''}
      <div class="review-actions">
        <button class="export-btn" data-review="${r.id}">Export to social media</button>
      </div>
    </div>
  `).join('') : '<p class="muted">You haven\'t reviewed anything yet. Head to the Movies tab!</p>';

  document.querySelectorAll('#my-reviews-list .export-btn').forEach(b =>
    b.addEventListener('click', () => exportReview(b.dataset.review)));
}

// TODO(export): wire this up once the export design is done.
// This is the single hook point — reviewId identifies the review to share
// (null when the user hasn't posted a review for the movie yet).
// Add platform pickers / share URLs / API calls here.
function exportReview(reviewId) {
  toast('Export coming soon — this feature is still in design.');
}

// ---- Profile (Instagram-style) ----
async function loadProfile() {
  profileData = await api('/api/my-profile');
  const { user, stats } = profileData;
  $('#profile-username').textContent = user.username;
  $('#profile-since').textContent = 'Member since ' + user.created_at.slice(0, 10);
  $('#profile-avatar-wrap').innerHTML = avatarHtml(user, 'avatar-xl');
  $('#profile-bio').textContent = user.bio || '';
  $('#stat-reviews').textContent = stats.review_count;
  $('#stat-favorites').textContent = stats.favorite_count;
  $('#stat-avg').textContent = stats.avg_given != null ? stats.avg_given + '★' : '–';
  renderProfileGrid();
}

function renderProfileGrid() {
  const grid = $('#profile-grid');
  if (profileGridMode === 'lists') {
    grid.classList.add('as-lists');
    grid.innerHTML = `
      <button id="new-list-btn" class="list-card new">＋ New list</button>
      ${profileData.lists.map(l => `
        <div class="list-card" data-id="${l.id}">
          <div class="list-posters">
            ${l.posters.length
              ? l.posters.map(p => `<span style="${bannerStyle(p)}"></span>`).join('')
              : '<span class="empty-poster"></span>'}
          </div>
          <strong>${escapeHtml(l.title)}</strong>
          <span class="muted">${l.kind === 'random' ? '🎲 random' : '🏆 ranked'} · ${l.count} movies</span>
        </div>
      `).join('')}
    `;
    $('#new-list-btn').addEventListener('click', () => {
      $('#list-title').value = '';
      $('#new-list-modal').classList.remove('hidden');
    });
    document.querySelectorAll('.list-card[data-id]').forEach(c =>
      c.addEventListener('click', () => openList(c.dataset.id)));
    return;
  }
  grid.classList.remove('as-lists');
  const items = profileGridMode === 'favorites' ? profileData.favorites : profileData.reviewed;
  const empty = profileGridMode === 'favorites'
    ? 'No favorites yet. Tap the heart on a movie you love.'
    : 'No reviews yet. Rate a movie from the Movies tab.';
  grid.innerHTML = items.length ? items.map(m => `
    <div class="poster-tile" data-id="${m.id}" style="${bannerStyle(m)}">
      <div class="tile-label">
        <span>${escapeHtml(m.title)}</span>
        ${m.stars ? `<span class="stars-display">${starString(m.stars)}</span>` : ''}
      </div>
    </div>
  `).join('') : `<div class="grid-empty">${empty}</div>`;
  document.querySelectorAll('.poster-tile').forEach(t =>
    t.addEventListener('click', () => openMovie(t.dataset.id)));
}

document.querySelectorAll('.ig-tab').forEach(b =>
  b.addEventListener('click', () => {
    profileGridMode = b.dataset.grid;
    document.querySelectorAll('.ig-tab').forEach(x => x.classList.toggle('active', x === b));
    renderProfileGrid();
  }));

// ---- Lists ----
$('#new-list-form').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const list = await api('/api/lists', {
      method: 'POST',
      body: { title: $('#list-title').value, kind: document.querySelector('input[name="list-kind"]:checked').value }
    });
    $('#new-list-modal').classList.add('hidden');
    await loadProfile();
    openList(list.id);
  } catch (err) { toast(err.message); }
});

async function openList(id) {
  currentList = await api('/api/lists/' + id);
  renderListDetail();
  $('#list-modal').classList.remove('hidden');
}

function renderListDetail() {
  const l = currentList;
  const inList = new Set(l.items.map(i => i.id));
  const addable = allMovies.filter(m => !inList.has(m.id));
  $('#list-detail').innerHTML = `
    <div class="list-head">
      <h3>${escapeHtml(l.title)}</h3>
      <span class="muted">${l.kind === 'random' ? '🎲 random' : '🏆 ranked'} · ${l.items.length} movies</span>
      <button id="delete-list" class="ghost-btn danger">Delete list</button>
    </div>
    ${l.items.length ? l.items.map((m, idx) => `
      <div class="list-item">
        <span class="rank-num">${idx + 1}</span>
        <span class="review-thumb" style="${bannerStyle(m)}"></span>
        <div class="li-info" data-open="${m.id}">
          <strong>${escapeHtml(m.title)}</strong>
          <span class="muted">${m.year || ''} ${m.stars ? '· your rating: ' + starString(m.stars) : '· not rated yet'}</span>
        </div>
        <div class="li-actions">
          ${l.kind === 'ranked' ? `
            <button class="mini-btn" data-move="up" data-movie="${m.id}" ${idx === 0 ? 'disabled' : ''}>▲</button>
            <button class="mini-btn" data-move="down" data-movie="${m.id}" ${idx === l.items.length - 1 ? 'disabled' : ''}>▼</button>
          ` : ''}
          <button class="mini-btn" data-remove="${m.id}">✕</button>
        </div>
      </div>
    `).join('') : '<p class="muted">Empty list — add movies below.</p>'}
    ${l.kind === 'ranked' ? `
      <div class="list-add">
        <select id="list-add-select">
          <option value="">Add a movie...</option>
          ${addable.map(m => `<option value="${m.id}">${escapeHtml(m.title)}${m.year ? ` (${m.year})` : ''}</option>`).join('')}
        </select>
      </div>` : ''}
  `;

  $('#delete-list').addEventListener('click', async () => {
    if (!confirm(`Delete the list "${l.title}"?`)) return;
    await api('/api/lists/' + l.id, { method: 'DELETE' });
    $('#list-modal').classList.add('hidden');
    loadProfile();
  });
  document.querySelectorAll('#list-detail .li-info').forEach(el =>
    el.addEventListener('click', () => {
      $('#list-modal').classList.add('hidden');
      openMovie(el.dataset.open);
    }));
  document.querySelectorAll('#list-detail [data-move]').forEach(b =>
    b.addEventListener('click', async () => {
      currentList = await api(`/api/lists/${l.id}/move`, { method: 'POST', body: { movie_id: +b.dataset.movie, dir: b.dataset.move } });
      renderListDetail();
    }));
  document.querySelectorAll('#list-detail [data-remove]').forEach(b =>
    b.addEventListener('click', async () => {
      currentList = await api(`/api/lists/${l.id}/items/${b.dataset.remove}`, { method: 'DELETE' });
      renderListDetail();
    }));
  const sel = $('#list-add-select');
  if (sel) sel.addEventListener('change', async () => {
    if (!sel.value) return;
    try {
      currentList = await api(`/api/lists/${l.id}/items`, { method: 'POST', body: { movie_id: +sel.value } });
      renderListDetail();
    } catch (err) { toast(err.message); }
  });
}

// ---- Edit profile ----
$('#edit-profile-btn').addEventListener('click', () => {
  $('#profile-bio-input').value = me.bio || '';
  $('#color-bg').value = me.bg_color;
  $('#color-accent').value = me.accent_color;
  $('#color-avatar').value = me.avatar_color;
  $('#edit-avatar-preview').innerHTML = avatarHtml(me, 'avatar-lg');
  $('#edit-modal').classList.remove('hidden');
});

$('#avatar-file').addEventListener('change', () => {
  const file = $('#avatar-file').files[0];
  if (!file) return;
  if (file.size > 3 * 1024 * 1024) return toast('Image too large (max 3MB)');
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      me = await api('/api/profile/avatar', { method: 'POST', body: { image: reader.result } });
      $('#edit-avatar-preview').innerHTML = avatarHtml(me, 'avatar-lg');
      toast('Profile photo updated');
      if (profileData) loadProfile();
    } catch (err) { toast(err.message); }
  };
  reader.readAsDataURL(file);
});

// Live preview while picking colors
['#color-bg', '#color-accent', '#color-avatar'].forEach(sel => {
  $(sel).addEventListener('input', () => {
    const r = document.documentElement.style;
    r.setProperty('--bg', $('#color-bg').value);
    r.setProperty('--accent', $('#color-accent').value);
    r.setProperty('--avatar', $('#color-avatar').value);
  });
});

$('#profile-form').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    me = await api('/api/profile', {
      method: 'PUT',
      body: {
        bio: $('#profile-bio-input').value,
        bg_color: $('#color-bg').value,
        accent_color: $('#color-accent').value,
        avatar_color: $('#color-avatar').value
      }
    });
    applyTheme();
    $('#edit-modal').classList.add('hidden');
    toast('Profile saved');
    loadProfile();
  } catch (err) { toast(err.message); }
});

// ---- Add movie (search-based) ----
$('#add-movie-btn').addEventListener('click', () => {
  $('#search-results').innerHTML = '<p class="muted">Search for a movie to add it to the catalog.</p>';
  $('#add-modal').classList.remove('hidden');
  $('#search-q').focus();
});

$('#search-form').addEventListener('submit', async e => {
  e.preventDefault();
  $('#search-results').innerHTML = '<p class="muted">Searching...</p>';
  try {
    const results = await api('/api/search?q=' + encodeURIComponent($('#search-q').value.trim()));
    if (!results.length) {
      $('#search-results').innerHTML = '<p class="muted">No results found.</p>';
      return;
    }
    $('#search-results').innerHTML = results.map((r, i) => `
      <div class="search-result">
        ${r.poster_url ? `<img src="${encodeURI(r.poster_url)}" alt="">` : '<div class="review-thumb"></div>'}
        <div class="sr-info">
          <strong>${escapeHtml(r.title)}</strong>
          <span class="muted">${r.year || '—'}${r.genre ? ' · ' + escapeHtml(r.genre) : ''}</span>
        </div>
        <button class="primary small" data-i="${i}">Add</button>
      </div>
    `).join('');
    document.querySelectorAll('#search-results button[data-i]').forEach(b =>
      b.addEventListener('click', async () => {
        try {
          await api('/api/movies', { method: 'POST', body: results[+b.dataset.i] });
          $('#add-modal').classList.add('hidden');
          toast('Movie added');
          loadMovies();
        } catch (err) { toast(err.message); }
      }));
  } catch (err) {
    $('#search-results').innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
});

// ---- Auth ----
let authMode = 'login';
$('#show-login').addEventListener('click', () => setAuthMode('login'));
$('#show-register').addEventListener('click', () => setAuthMode('register'));
function setAuthMode(mode) {
  authMode = mode;
  $('#show-login').classList.toggle('active', mode === 'login');
  $('#show-register').classList.toggle('active', mode === 'register');
  $('#auth-submit').textContent = mode === 'login' ? 'Log in' : 'Create account';
  $('#auth-error').classList.add('hidden');
}

$('#auth-form').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    me = await api('/api/' + authMode, {
      method: 'POST',
      body: { username: $('#auth-username').value.trim(), password: $('#auth-password').value }
    });
    showApp();
  } catch (err) {
    $('#auth-error').textContent = err.message;
    $('#auth-error').classList.remove('hidden');
  }
});

$('#logout-btn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  me = null;
  showAuth();
});

// ---- Nav / modals ----
document.querySelectorAll('.nav-btn[data-tab]').forEach(b =>
  b.addEventListener('click', () => switchTab(b.dataset.tab)));

document.querySelectorAll('.modal-close').forEach(b =>
  b.addEventListener('click', () => $('#' + b.dataset.close).classList.add('hidden')));
document.querySelectorAll('.modal').forEach(m =>
  m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); }));

// ---- PWA ----
if ('serviceWorker' in navigator && location.hostname !== 'localhost') {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ---- Boot ----
(async () => {
  me = await api('/api/me');
  me ? showApp() : showAuth();
})();
