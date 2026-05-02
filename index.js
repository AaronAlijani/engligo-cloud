// EngliGo Web Server - Cloud-native edition
// Patched for SIT737 7.2HD Capstone

const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const session = require('express-session');
const bcrypt = require('bcrypt');

// --- Configuration from environment ---
const PORT = parseInt(process.env.PORT, 10) || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'engligo.db');
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me';
const NODE_ENV = process.env.NODE_ENV || 'development';
const BCRYPT_ROUNDS = 10;

// Refuse to start in production with the dev fallback secret
if (NODE_ENV === 'production' && SESSION_SECRET === 'dev-only-insecure-secret-change-me') {
    console.error('FATAL: SESSION_SECRET must be set in production.');
    process.exit(1);
}

const app = express();

// --- Structured JSON request logging ---
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        console.log(JSON.stringify({
            ts: new Date().toISOString(),
            level: 'info',
            method: req.method,
            path: req.path,
            status: res.statusCode,
            durationMs: Date.now() - start
        }));
    });
    next();
});

// --- Database connection ---
const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
        console.error('Error : Connecting to Database', err.message);
    } else {
        console.log(`Successfully connected to database at ${DB_PATH}`);
        // Enforce FK constraints on this connection
        db.run('PRAGMA foreign_keys = ON');
    }
});

// Track DB readiness for the /ready probe
let dbReady = false;
db.get('SELECT 1', (err) => { dbReady = !err; });

// --- View engine ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// --- Core middleware ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public_html'));

// --- Session middleware ---
// If running behind a load balancer that terminates HTTPS, trust the proxy
if (process.env.TRUST_PROXY === 'true') {
    app.set('trust proxy', 1);
}

app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: NODE_ENV === 'production' && process.env.TRUST_PROXY === 'true',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000
    }
}));

// --- Health endpoints (Kubernetes probes) ---

// Liveness probe: is the process alive? Lightweight, no dependency checks.
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

// Readiness probe: are we ready to serve traffic? Tests the database.
app.get('/ready', (req, res) => {
    db.get('SELECT 1', (err) => {
        if (err) {
            return res.status(503).json({ status: 'not-ready', reason: 'database not reachable' });
        }
        res.json({ status: 'ready' });
    });
});

// --- Pass session info to every rendered view ---
app.use((req, res, next) => {
    res.locals.isUserLoggedIn = !!(req.session && req.session.isUserLoggedIn);
    res.locals.loggedInUsername = req.session ? req.session.username : null;
    next();
});

// --- Authentication middleware ---

function requireLogin(req, res, next) {
    if (req.session && req.session.isUserLoggedIn) {
        return next();
    }
    res.redirect('/login');
}

// --- Routes ---

// Home page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public_html', 'index.html'));
});

// --- User Registration ---

app.get('/register', (req, res) => {
    res.render('register', {
        pageTitle: 'Register - EngliGo',
        errors: [],
        usernameValue: '',
        emailValue: ''
    });
});

app.post('/register', async (req, res) => {
    const { username, email, password, confirmPassword } = req.body;
    let errors = [];

    if (!username || username.trim().length < 3) {
        errors.push({ msg: "Username must be at least 3 characters." });
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        errors.push({ msg: "A valid email is required." });
    }
    if (!password || password.length < 6) {
        errors.push({ msg: "Password must be at least 6 characters." });
    }
    if (password !== confirmPassword) {
        errors.push({ msg: "Passwords do not match." });
    }

    if (errors.length > 0) {
        return res.render('register', {
            pageTitle: 'Register - EngliGo',
            errors,
            usernameValue: username || '',
            emailValue: email || ''
        });
    }

    try {
        // Check for existing username/email
        const existingUser = await new Promise((resolve, reject) => {
            db.get(
                'SELECT * FROM Users WHERE username = ? OR email = ?',
                [username.trim(), email.trim()],
                (err, row) => err ? reject(err) : resolve(row)
            );
        });

        if (existingUser) {
            if (existingUser.username === username.trim()) errors.push({ msg: "Username already taken." });
            if (existingUser.email === email.trim()) errors.push({ msg: "Email already registered." });
            return res.render('register', {
                pageTitle: 'Register - EngliGo',
                errors,
                usernameValue: username,
                emailValue: email
            });
        }

        // Hash the password and insert the user
        const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);

        await new Promise((resolve, reject) => {
            db.run(
                'INSERT INTO Users (username, email, password) VALUES (?, ?, ?)',
                [username.trim(), email.trim(), hashedPassword],
                function (err) { err ? reject(err) : resolve(this.lastID); }
            );
        });

        res.redirect('/login?status=registered');
    } catch (err) {
        console.error('Registration error:', err.message);
        res.render('register', {
            pageTitle: 'Register - EngliGo',
            errors: [{ msg: "Could not register user. Please try again." }],
            usernameValue: username || '',
            emailValue: email || ''
        });
    }
});

// --- User Login ---

app.get('/login', (req, res) => {
    let successMsg = null;
    if (req.query.status === 'registered') {
        successMsg = 'Registration successful! Please log in.';
    }
    res.render('login', {
        pageTitle: 'Login - EngliGo',
        error: null,
        success_msg: successMsg
    });
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.render('login', {
            pageTitle: 'Login - EngliGo',
            error: 'Username and password are required.',
            success_msg: null
        });
    }

    try {
        const user = await new Promise((resolve, reject) => {
            db.get(
                'SELECT * FROM Users WHERE username = ?',
                [username.trim()],
                (err, row) => err ? reject(err) : resolve(row)
            );
        });

        if (!user) {
            return res.render('login', {
                pageTitle: 'Login - EngliGo',
                error: 'Invalid username or password.',
                success_msg: null
            });
        }

        // Detect bcrypt vs legacy plain-text and handle both
        const isBcryptHash = typeof user.password === 'string' && user.password.startsWith('$2');
        let passwordMatches = false;

        if (isBcryptHash) {
            passwordMatches = await bcrypt.compare(password, user.password);
        } else {
            // Legacy plain-text comparison
            passwordMatches = password === user.password;
            // Upgrade their password to bcrypt now we know the plaintext
            if (passwordMatches) {
                const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);
                db.run('UPDATE Users SET password = ? WHERE id = ?', [hashed, user.id]);
                console.log(`Upgraded password to bcrypt for user id ${user.id}`);
            }
        }

        if (passwordMatches) {
            req.session.isUserLoggedIn = true;
            req.session.userId = user.id;
            req.session.username = user.username;
            return res.redirect('/');
        }

        res.render('login', {
            pageTitle: 'Login - EngliGo',
            error: 'Invalid username or password.',
            success_msg: null
        });
    } catch (err) {
        console.error('Login error:', err.message);
        res.render('login', {
            pageTitle: 'Login - EngliGo',
            error: 'Database error. Please try again.',
            success_msg: null
        });
    }
});

// --- Logout ---

app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) return res.redirect('/');
        res.clearCookie('connect.sid');
        res.redirect('/');
    });
});

// --- Contact form submission ---

app.post('/submit-contact', (req, res) => {
    const { contactName, contactEmail, contactPhone, contactBirthdate, contactComment } = req.body;
    let errors = [];

    if (!contactName || contactName.trim() === "") {
        errors.push("Name is required and cannot be empty.");
    }
    if (!contactEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail.trim())) {
        errors.push("A valid Email is required (e.g., user@example.com).");
    }
    if (!contactPhone || contactPhone.trim() === "" || !/^[0-9]{8,15}$/.test(contactPhone.trim())) {
        errors.push("Phone number is required (8-15 digits, numbers only).");
    }
    if (!contactBirthdate || !/^\d{4}-\d{2}-\d{2}$/.test(contactBirthdate.trim())) {
        errors.push("Birthdate in YYYY-MM-DD format is required.");
    } else {
        const [yearStr, monthStr, dayStr] = contactBirthdate.trim().split('-');
        const year = parseInt(yearStr, 10);
        const month = parseInt(monthStr, 10);
        const day = parseInt(dayStr, 10);
        const dateObj = new Date(year, month - 1, day);
        if (!(dateObj.getFullYear() === year && dateObj.getMonth() === month - 1 && dateObj.getDate() === day)) {
            errors.push("Invalid birthdate. Please enter a real calendar date.");
        }
    }
    if (!contactComment || contactComment.trim() === "") {
        errors.push("Comment is required and cannot be empty.");
    }

    if (errors.length > 0) {
        return res.status(400).json({
            message: "Validation failed. Please check your input.",
            errors
        });
    }

    db.run(
        'INSERT INTO Submissions (name, email, phone, birthdate, comment) VALUES (?, ?, ?, ?, ?)',
        [contactName.trim(), contactEmail.trim(), contactPhone.trim(), contactBirthdate.trim(), contactComment.trim()],
        function (err) {
            if (err) {
                console.error('Database error saving submission:', err.message);
                return res.status(500).json({
                    message: "Error: Could not save your submission. Please try again later."
                });
            }
            console.log(`A new submission has been inserted with rowid ${this.lastID}`);
            res.status(201).json({
                message: "Thank you for your submission! It has been received."
            });
        }
    );
});

// --- learnSVG page ---
app.get('/learnSvg', (req, res) => {
    res.render('learnSvg', { pageTitle: 'Learn SVG Waves - EngliGo' });
});

// --- Admin: view submitted messages (login required) ---
app.get('/admin/messages', requireLogin, async (req, res) => {
    try {
        const getAll = (sql, params = []) => new Promise((resolve, reject) => {
            db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
        });

        const [submissions, users] = await Promise.all([
            getAll('SELECT id, name, email, phone, birthdate, comment, submission_date FROM Submissions ORDER BY submission_date DESC'),
            getAll('SELECT id, username, email FROM Users ORDER BY username ASC')
        ]);

        res.render('admin_messages', {
            pageTitle: 'Site Data Overview - EngliGo',
            submissions,
            users,
            loggedInUsername: req.session.username
        });
    } catch (err) {
        console.error('Admin route error:', err.message);
        res.status(500).send("Error retrieving data from the database.");
    }
});

// --- Class Bookings ---

// List all upcoming classes (across all courses)
app.get('/classes', (req, res) => {
    const now = new Date().toISOString();
    const sql = `
        SELECT
            cs.id, cs.title, cs.teacher_name, cs.location, cs.start_time,
            cs.duration_minutes, cs.capacity,
            c.code AS course_code, c.name AS course_name,
            (SELECT COUNT(*) FROM Bookings WHERE session_id = cs.id) AS booked_count
        FROM ClassSessions cs
        JOIN Courses c ON cs.course_id = c.id
        WHERE cs.start_time > ?
        ORDER BY cs.start_time ASC
    `;

    db.all(sql, [now], (err, sessions) => {
        if (err) {
            console.error('Error fetching classes:', err.message);
            return res.status(500).send('Error loading classes.');
        }
        res.render('classes', {
            pageTitle: 'Available Classes - EngliGo',
            sessions,
            isLoggedIn: !!(req.session && req.session.isUserLoggedIn)
        });
    });
});

// List classes for a specific course
app.get('/classes/:code', (req, res) => {
    const courseCode = req.params.code;
    const now = new Date().toISOString();
    const sql = `
        SELECT
            cs.id, cs.title, cs.teacher_name, cs.location, cs.start_time,
            cs.duration_minutes, cs.capacity,
            c.code AS course_code, c.name AS course_name, c.description AS course_description,
            (SELECT COUNT(*) FROM Bookings WHERE session_id = cs.id) AS booked_count
        FROM ClassSessions cs
        JOIN Courses c ON cs.course_id = c.id
        WHERE c.code = ? AND cs.start_time > ?
        ORDER BY cs.start_time ASC
    `;

    db.all(sql, [courseCode, now], (err, sessions) => {
        if (err) {
            console.error('Error fetching course classes:', err.message);
            return res.status(500).send('Error loading course classes.');
        }
        if (sessions.length === 0) {
            // Either course doesn't exist or has no upcoming sessions; check which
            db.get('SELECT * FROM Courses WHERE code = ?', [courseCode], (err, course) => {
                if (err || !course) return res.status(404).send('Course not found.');
                return res.render('course-classes', {
                    pageTitle: `${course.name} - EngliGo`,
                    course,
                    sessions: [],
                    isLoggedIn: !!(req.session && req.session.isUserLoggedIn)
                });
            });
            return;
        }
        // We have sessions; pull course info from first row
        const course = {
            code: sessions[0].course_code,
            name: sessions[0].course_name,
            description: sessions[0].course_description
        };
        res.render('course-classes', {
            pageTitle: `${course.name} - EngliGo`,
            course,
            sessions,
            isLoggedIn: !!(req.session && req.session.isUserLoggedIn)
        });
    });
});

// Book a class session (login required)
app.post('/bookings', requireLogin, async (req, res) => {
    const sessionId = parseInt(req.body.session_id, 10);
    const userId = req.session.userId;

    if (Number.isNaN(sessionId)) {
        return res.redirect('/classes?error=invalid-session');
    }

    try {
        await new Promise((resolve, reject) => {
            db.run(
                'INSERT INTO Bookings (user_id, session_id) VALUES (?, ?)',
                [userId, sessionId],
                function (err) { err ? reject(err) : resolve(this.lastID); }
            );
        });
        res.redirect('/my-bookings?status=booked');
    } catch (err) {
        if (err.message && err.message.includes('UNIQUE constraint failed')) {
            return res.redirect('/my-bookings?error=already-booked');
        }
        if (err.message && err.message.includes('FOREIGN KEY constraint failed')) {
            return res.redirect('/classes?error=invalid-session');
        }
        console.error('Booking error:', err.message);
        res.redirect('/classes?error=booking-failed');
    }
});

// Cancel a booking (login required, must own the booking)
app.post('/bookings/:id/cancel', requireLogin, (req, res) => {
    const bookingId = parseInt(req.params.id, 10);
    const userId = req.session.userId;

    if (Number.isNaN(bookingId)) {
        return res.redirect('/my-bookings?error=invalid-booking');
    }

    db.run(
        'DELETE FROM Bookings WHERE id = ? AND user_id = ?',
        [bookingId, userId],
        function (err) {
            if (err) {
                console.error('Cancel booking error:', err.message);
                return res.redirect('/my-bookings?error=cancel-failed');
            }
            if (this.changes === 0) {
                // Either the booking doesn't exist, or it belongs to someone else
                return res.redirect('/my-bookings?error=not-found');
            }
            res.redirect('/my-bookings?status=cancelled');
        }
    );
});

// View own bookings (login required)
app.get('/my-bookings', requireLogin, (req, res) => {
    const userId = req.session.userId;
    const sql = `
        SELECT
            b.id AS booking_id, b.booked_at,
            cs.id AS session_id, cs.title, cs.teacher_name, cs.location,
            cs.start_time, cs.duration_minutes,
            c.name AS course_name, c.code AS course_code
        FROM Bookings b
        JOIN ClassSessions cs ON b.session_id = cs.id
        JOIN Courses c ON cs.course_id = c.id
        WHERE b.user_id = ?
        ORDER BY cs.start_time ASC
    `;

    db.all(sql, [userId], (err, bookings) => {
        if (err) {
            console.error('My bookings error:', err.message);
            return res.status(500).send('Error loading bookings.');
        }
        res.render('my-bookings', {
            pageTitle: 'My Bookings - EngliGo',
            bookings,
            statusMessage: req.query.status || null,
            errorMessage: req.query.error || null
        });
    });
});

// --- 404 handler (must be after all routes) ---
app.use((req, res) => {
    res.status(404).send('Page not found');
});

// --- Error handler (must be last) ---
app.use((err, req, res, next) => {
    console.error(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'error',
        message: err.message,
        stack: err.stack,
        path: req.path
    }));
    res.status(500).send('Internal server error');
});

// --- Start server ---
const server = app.listen(PORT, () => {
    console.log(`Web server running at: http://localhost:${PORT}`);
    console.log(`Environment: ${NODE_ENV}`);
    console.log(`Database: ${DB_PATH}`);
});

// --- Graceful shutdown for Kubernetes rolling updates ---
const shutdown = (signal) => {
    console.log(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        message: `${signal} received, shutting down gracefully`
    }));
    server.close(() => {
        db.close((err) => {
            if (err) console.error('Error closing database:', err.message);
            process.exit(err ? 1 : 0);
        });
    });
    setTimeout(() => {
        console.error('Forced shutdown after timeout');
        process.exit(1);
    }, 10000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));