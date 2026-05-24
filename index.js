// EngliGo Server — Stage 3 (PostgreSQL sidecar)
// Twelve-Factor: config via env, logs to stdout as JSON, graceful shutdown.
// Migrated from SQLite to PostgreSQL. DB init handled by initContainer.

const express      = require('express');
const session      = require('express-session');
const MemoryStore  = require('memorystore')(session);
const bodyParser   = require('body-parser');
const bcrypt       = require('bcrypt');
const { Pool }     = require('pg');
const path         = require('path');

// --- Configuration ---
const PORT           = process.env.PORT           || 3000;
const NODE_ENV       = process.env.NODE_ENV       || 'development';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-secret-do-not-use-in-prod';
const TRUST_PROXY    = process.env.TRUST_PROXY === 'true';

if (NODE_ENV === 'production' && SESSION_SECRET === 'dev-only-secret-do-not-use-in-prod') {
    console.error('FATAL: SESSION_SECRET not set in production. Exiting.');
    process.exit(1);
}

// --- PostgreSQL pool ---
const pool = new Pool({
    host:     process.env.PG_HOST     || 'localhost',
    port:     parseInt(process.env.PG_PORT || '5432'),
    database: process.env.PG_DB       || 'engligo',
    user:     process.env.PG_USER     || 'engligo',
    password: process.env.PG_PASSWORD || 'engligo',
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', message: 'PG pool error', error: err.message }));
});

// --- Structured JSON logger ---
function log(level, fields) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), level, ...fields }));
}

// --- App setup ---
const app = express();
if (TRUST_PROXY) app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public_html')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

app.use(session({
    store: new MemoryStore({ checkPeriod: 86400000 }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, secure: TRUST_PROXY, maxAge: 24 * 60 * 60 * 1000 }
}));

app.use((req, res, next) => {
    res.locals.isUserLoggedIn  = !!req.session.userId;
    res.locals.currentUsername = req.session.username || null;
    next();
});

app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        log('info', { method: req.method, path: req.path, status: res.statusCode, durationMs: Date.now() - start });
    });
    next();
});

// --- DB helpers ---
const dbAll = (sql, params = []) => pool.query(sql, params).then(r => r.rows);
const dbGet = (sql, params = []) => pool.query(sql, params).then(r => r.rows[0] || null);
const dbRun = (sql, params = []) => pool.query(sql, params).then(r => ({ rowCount: r.rowCount }));

// --- Auth middleware ---
function requireLogin(req, res, next) {
    if (!req.session.userId) return res.redirect('/login');
    next();
}

// --- Routes ---

// Liveness probe
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

// Readiness probe — check DB connectivity
app.get('/ready', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'ready' });
    } catch (err) {
        res.status(503).json({ status: 'not ready', error: err.message });
    }
});

// Home
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public_html', 'index.html'));
});

// Register
app.get('/register', (req, res) => res.render('register'));

app.post('/register', async (req, res) => {
    const { username, email, password, confirm_password } = req.body;
    if (!username || !email || !password)
        return res.render('register', { error: 'All fields required.' });
    if (password !== confirm_password)
        return res.render('register', { error: 'Passwords do not match.' });
    if (username.length < 3)
        return res.render('register', { error: 'Username must be at least 3 characters.' });
    if (password.length < 6)
        return res.render('register', { error: 'Password must be at least 6 characters.' });
    try {
        const hash = await bcrypt.hash(password, 10);
        await dbRun(
            'INSERT INTO Users (username, email, password) VALUES ($1, $2, $3)',
            [username, email, hash]
        );
        res.redirect('/login?status=registered');
    } catch (err) {
        if (err.code === '23505') // unique_violation
            return res.render('register', { error: 'Username or email already exists.' });
        log('error', { message: 'Registration failed', error: err.message });
        res.status(500).render('register', { error: 'Registration failed. Please try again.' });
    }
});

// Login
app.get('/login', (req, res) => {
    res.render('login', {
        message: req.query.status === 'registered' ? 'Registration successful! Please log in.' : null
    });
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await dbGet('SELECT * FROM Users WHERE username = $1', [username]);
        if (!user) return res.render('login', { error: 'Invalid credentials.' });

        let valid = false;
        if (user.password.startsWith('$2')) {
            valid = await bcrypt.compare(password, user.password);
        } else {
            if (user.password === password) {
                valid = true;
                const newHash = await bcrypt.hash(password, 10);
                await dbRun('UPDATE Users SET password = $1 WHERE id = $2', [newHash, user.id]);
                log('info', { message: 'Upgraded legacy password to bcrypt', userId: user.id });
            }
        }
        if (!valid) return res.render('login', { error: 'Invalid credentials.' });

        req.session.userId   = user.id;
        req.session.username = user.username;
        res.redirect('/');
    } catch (err) {
        log('error', { message: 'Login failed', error: err.message });
        res.status(500).render('login', { error: 'Login failed. Please try again.' });
    }
});

// Logout
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

// Classes
app.get('/classes', async (req, res) => {
    try {
        const sessions = await dbAll(`
            SELECT s.*, c.code AS course_code, c.name AS course_name,
                   (SELECT COUNT(*) FROM Bookings WHERE session_id = s.id)::int AS booked_count
            FROM ClassSessions s
            JOIN Courses c ON c.id = s.course_id
            WHERE s.session_date >= CURRENT_DATE
            ORDER BY s.session_date, s.start_time
        `);
        res.render('classes', { sessions });
    } catch (err) {
        log('error', { message: 'Failed to load classes', error: err.message });
        res.status(500).send('Internal server error');
    }
});

// Book a class
app.post('/classes/:sessionId/book', requireLogin, async (req, res) => {
    const sessionId = parseInt(req.params.sessionId, 10);
    try {
        await dbRun(
            'INSERT INTO Bookings (user_id, session_id) VALUES ($1, $2)',
            [req.session.userId, sessionId]
        );
        res.redirect('/my-bookings?status=booked');
    } catch (err) {
        if (err.code === '23505')
            return res.redirect('/my-bookings?error=already-booked');
        log('error', { message: 'Booking failed', error: err.message });
        res.redirect('/my-bookings?error=booking-failed');
    }
});

// My bookings
app.get('/my-bookings', requireLogin, async (req, res) => {
    try {
        const bookings = await dbAll(`
            SELECT b.id AS booking_id, b.booked_at, s.*, c.code AS course_code, c.name AS course_name
            FROM Bookings b
            JOIN ClassSessions s ON s.id = b.session_id
            JOIN Courses c ON c.id = s.course_id
            WHERE b.user_id = $1
            ORDER BY s.session_date, s.start_time
        `, [req.session.userId]);
        res.render('my-bookings', { bookings, status: req.query.status, error: req.query.error });
    } catch (err) {
        log('error', { message: 'Failed to load bookings', error: err.message });
        res.status(500).send('Internal server error');
    }
});

// Cancel booking
app.post('/bookings/:bookingId/cancel', requireLogin, async (req, res) => {
    const bookingId = parseInt(req.params.bookingId, 10);
    try {
        await dbRun('DELETE FROM Bookings WHERE id = $1 AND user_id = $2', [bookingId, req.session.userId]);
        res.redirect('/my-bookings?status=cancelled');
    } catch (err) {
        log('error', { message: 'Cancel failed', error: err.message });
        res.redirect('/my-bookings?error=cancel-failed');
    }
});

// Contact form
app.post('/contact', async (req, res) => {
    const { name, email, subject, message } = req.body;
    if (!name || !email || !message) return res.status(400).send('Required fields missing.');
    try {
        await dbRun(
            'INSERT INTO Submissions (name, email, subject, message) VALUES ($1, $2, $3, $4)',
            [name, email, subject || null, message]
        );
        res.send('Thank you for your message. We will be in touch.');
    } catch (err) {
        log('error', { message: 'Contact submission failed', error: err.message });
        res.status(500).send('Submission failed. Please try again.');
    }
});

// Admin
app.get('/admin/messages', requireLogin, async (req, res) => {
    try {
        const submissions = await dbAll('SELECT * FROM Submissions ORDER BY timestamp DESC');
        const users       = await dbAll('SELECT id, username, email, created_at FROM Users ORDER BY created_at DESC');
        res.render('admin_messages', { submissions, users });
    } catch (err) {
        log('error', { message: 'Admin page failed', error: err.message });
        res.status(500).send('Internal server error');
    }
});

// --- Start server ---
const server = app.listen(PORT, () => {
    log('info', { message: `EngliGo listening on port ${PORT}`, env: NODE_ENV });
});

// --- Graceful shutdown ---
function shutdown(signal) {
    log('info', { message: `${signal} received, shutting down` });
    server.close(async () => {
        await pool.end();
        process.exit(0);
    });
    setTimeout(() => { log('error', { message: 'Forced shutdown' }); process.exit(1); }, 10000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));