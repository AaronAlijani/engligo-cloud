// EngliGo Database Initialisation — Stage 3 (PostgreSQL)
// Migrated from SQLite to PostgreSQL sidecar.
// Retries connection until PG is ready (sidecar startup race condition).

const { Pool } = require('pg');

const pool = new Pool({
    host:     process.env.PG_HOST     || 'localhost',
    port:     parseInt(process.env.PG_PORT || '5432'),
    database: process.env.PG_DB       || 'engligo',
    user:     process.env.PG_USER     || 'engligo',
    password: process.env.PG_PASSWORD || 'engligo',
});

async function waitForDB(retries = 20, delayMs = 2000) {
    for (let i = 1; i <= retries; i++) {
        try {
            const client = await pool.connect();
            client.release();
            console.log('Connected to PostgreSQL');
            return;
        } catch (err) {
            console.log(`Waiting for PostgreSQL... attempt ${i}/${retries}`);
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
    console.error('Could not connect to PostgreSQL after retries. Exiting.');
    process.exit(1);
}

async function init() {
    await waitForDB();
    const client = await pool.connect();
    try {
        // --- Schema ---
        await client.query(`
            CREATE TABLE IF NOT EXISTS Submissions (
                id         SERIAL PRIMARY KEY,
                name       TEXT NOT NULL,
                email      TEXT NOT NULL,
                subject    TEXT,
                message    TEXT NOT NULL,
                timestamp  TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        console.log('Submissions table ready.');

        await client.query(`
            CREATE TABLE IF NOT EXISTS Users (
                id         SERIAL PRIMARY KEY,
                username   TEXT UNIQUE NOT NULL,
                email      TEXT UNIQUE NOT NULL,
                password   TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        console.log('Users table ready.');

        await client.query(`
            CREATE TABLE IF NOT EXISTS Courses (
                id          SERIAL PRIMARY KEY,
                code        TEXT UNIQUE NOT NULL,
                name        TEXT NOT NULL,
                description TEXT
            )
        `);
        console.log('Courses table ready.');

        await client.query(`
            CREATE TABLE IF NOT EXISTS ClassSessions (
                id               SERIAL PRIMARY KEY,
                course_id        INTEGER NOT NULL REFERENCES Courses(id) ON DELETE CASCADE,
                title            TEXT NOT NULL,
                instructor       TEXT NOT NULL,
                location         TEXT NOT NULL,
                session_date     DATE NOT NULL,
                start_time       TIME NOT NULL,
                duration_minutes INTEGER NOT NULL,
                capacity         INTEGER NOT NULL DEFAULT 10
            )
        `);
        console.log('ClassSessions table ready.');

        await client.query(`
            CREATE TABLE IF NOT EXISTS Bookings (
                id         SERIAL PRIMARY KEY,
                user_id    INTEGER NOT NULL REFERENCES Users(id) ON DELETE CASCADE,
                session_id INTEGER NOT NULL REFERENCES ClassSessions(id) ON DELETE CASCADE,
                booked_at  TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE (user_id, session_id)
            )
        `);
        console.log('Bookings table ready.');

        // Indexes
        await client.query(`CREATE INDEX IF NOT EXISTS idx_bookings_user    ON Bookings(user_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_bookings_session ON Bookings(session_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_sessions_course  ON ClassSessions(course_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_sessions_date    ON ClassSessions(session_date)`);

        // --- Seed Courses ---
        await client.query(`
            INSERT INTO Courses (code, name, description)
            VALUES
              ('IELTS-PREP', 'IELTS Preparation',
               'Comprehensive preparation for the IELTS Academic test, covering all four bands.'),
              ('GEN-ENG', 'General English',
               'Conversational and grammar-focused General English for everyday communication.')
            ON CONFLICT (code) DO NOTHING
        `);
        console.log('Course seed data ready.');

        // --- Seed ClassSessions (only if empty) ---
        const { rows } = await client.query('SELECT COUNT(*)::int AS count FROM ClassSessions');
        if (rows[0].count === 0) {
            const now = new Date();
            const offsetDate = (days) => {
                const d = new Date(now);
                d.setDate(d.getDate() + days);
                return d.toISOString().slice(0, 10);
            };

            const sessions = [
                { code: 'IELTS-PREP', title: 'IELTS Speaking Practice',  instructor: 'Ms Sarah Chen', location: 'Room 201',       date: offsetDate(7),  time: '10:00', duration: 90,  capacity: 12 },
                { code: 'GEN-ENG',    title: 'Conversation Club',         instructor: 'Mr Liam Brown', location: 'Online (Zoom)',  date: offsetDate(8),  time: '18:00', duration: 60,  capacity: 15 },
                { code: 'IELTS-PREP', title: 'IELTS Writing Workshop',    instructor: 'Mr David Park', location: 'Room 105',       date: offsetDate(9),  time: '14:00', duration: 120, capacity: 10 },
                { code: 'GEN-ENG',    title: 'Grammar Essentials',        instructor: 'Ms Anna Lee',   location: 'Room 102',       date: offsetDate(10), time: '11:00', duration: 60,  capacity: 12 },
                { code: 'IELTS-PREP', title: 'IELTS Mock Test',           instructor: 'Ms Sarah Chen', location: 'Room 201',       date: offsetDate(12), time: '09:00', duration: 180, capacity: 20 },
                { code: 'GEN-ENG',    title: 'Vocabulary Builder',        instructor: 'Mr Liam Brown', location: 'Room 102',       date: offsetDate(13), time: '16:00', duration: 60,  capacity: 12 },
            ];

            for (const s of sessions) {
                await client.query(`
                    INSERT INTO ClassSessions
                        (course_id, title, instructor, location, session_date, start_time, duration_minutes, capacity)
                    SELECT id, $1, $2, $3, $4, $5, $6, $7
                    FROM Courses WHERE code = $8
                `, [s.title, s.instructor, s.location, s.date, s.time, s.duration, s.capacity, s.code]);
            }
            console.log(`Seeded ${sessions.length} class sessions.`);
        } else {
            console.log(`ClassSessions already populated (${rows[0].count} rows).`);
        }

        console.log('Database initialisation complete.');
    } finally {
        client.release();
        await pool.end();
    }
}

init().catch(err => {
    console.error('Init failed:', err.message);
    process.exit(1);
});