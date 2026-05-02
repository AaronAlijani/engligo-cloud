// EngliGo Database Initialiser
// Creates the schema (Users, Submissions, Courses, ClassSessions, Bookings)
// and seeds initial course data. Safe to run repeatedly.

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'engligo.db');

const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('Error : Opening Database', err.message);
        process.exit(1);
    }
    console.log(`Connected to EngliGo Database at ${DB_PATH}`);
    initialise();
});

function initialise() {
    db.serialize(() => {
        // SQLite needs FK enforcement turned on per-connection
        db.run('PRAGMA foreign_keys = ON');

        // ---------- Existing tables (from my past unit) ----------

        db.run(`CREATE TABLE IF NOT EXISTS Submissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT NOT NULL,
            phone TEXT NOT NULL,
            birthdate TEXT NOT NULL,
            comment TEXT NOT NULL,
            submission_date TEXT DEFAULT CURRENT_TIMESTAMP
        )`, logResult('Submissions'));

        db.run(`CREATE TABLE IF NOT EXISTS Users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`, logResult('Users'));

        // ---------- Class booking tables(Courses, ClassSessions, Bookings) ----------

        db.run(`CREATE TABLE IF NOT EXISTS Courses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            description TEXT NOT NULL,
            level TEXT NOT NULL
        )`, logResult('Courses'));

        db.run(`CREATE TABLE IF NOT EXISTS ClassSessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            course_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            teacher_name TEXT NOT NULL,
            location TEXT NOT NULL,
            start_time TEXT NOT NULL,
            duration_minutes INTEGER NOT NULL,
            capacity INTEGER NOT NULL,
            FOREIGN KEY (course_id) REFERENCES Courses(id) ON DELETE RESTRICT
        )`, logResult('ClassSessions'));

        db.run(`CREATE TABLE IF NOT EXISTS Bookings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            session_id INTEGER NOT NULL,
            booked_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (user_id, session_id),
            FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE,
            FOREIGN KEY (session_id) REFERENCES ClassSessions(id) ON DELETE CASCADE
        )`, logResult('Bookings'));

        // ---------- Indexes for query performance ----------

        db.run('CREATE INDEX IF NOT EXISTS idx_sessions_course ON ClassSessions(course_id)');
        db.run('CREATE INDEX IF NOT EXISTS idx_sessions_start_time ON ClassSessions(start_time)');
        db.run('CREATE INDEX IF NOT EXISTS idx_bookings_user ON Bookings(user_id)');
        db.run('CREATE INDEX IF NOT EXISTS idx_bookings_session ON Bookings(session_id)');

        // ---------- Seed data ----------
        seedCourses();
    });
}

function logResult(tableName) {
    return (err) => {
        if (err) console.error(`Error creating ${tableName} table:`, err.message);
        else console.log(`${tableName} table created or already exists.`);
    };
}

function seedCourses() {
    const courses = [
        {
            code: 'IELTS-PREP',
            name: 'IELTS Preparation',
            description: 'Comprehensive preparation for the IELTS Academic and General Training tests, covering Reading, Writing, Listening, and Speaking modules.',
            level: 'Intermediate'
        },
        {
            code: 'GEN-ENG',
            name: 'General English',
            description: 'Build core English skills for everyday communication, with a focus on practical conversation, grammar, and vocabulary.',
            level: 'All Levels'
        }
    ];

    const insertCourse = db.prepare(
        'INSERT OR IGNORE INTO Courses (code, name, description, level) VALUES (?, ?, ?, ?)'
    );
    for (const c of courses) {
        insertCourse.run(c.code, c.name, c.description, c.level);
    }
    insertCourse.finalize();

    console.log('Course seed data inserted (or already present).');
    seedClassSessions();
}

function seedClassSessions() {
    // We seed sessions only if none exist yet, to keep this idempotent
    // without depending on UNIQUE constraints across a wide combination of fields.
    db.get('SELECT COUNT(*) AS count FROM ClassSessions', (err, row) => {
        if (err) {
            console.error('Error checking ClassSessions count:', err.message);
            db.close();
            return;
        }
        if (row.count > 0) {
            console.log('Class sessions already seeded; skipping.');
            db.close();
            return;
        }

        // Build sessions starting from 7 days from now
        const now = new Date();
        const oneWeek = 7 * 24 * 60 * 60 * 1000;
        const baseTime = new Date(now.getTime() + oneWeek);

        const sessions = [
            { course_code: 'IELTS-PREP', title: 'IELTS Speaking Practice', teacher: 'Ms Sarah Chen', location: 'Room 201', offsetDays: 0, hour: 10, duration: 90, capacity: 12 },
            { course_code: 'IELTS-PREP', title: 'IELTS Writing Workshop',  teacher: 'Mr David Park',  location: 'Room 105', offsetDays: 2, hour: 14, duration: 120, capacity: 10 },
            { course_code: 'IELTS-PREP', title: 'IELTS Mock Test',         teacher: 'Ms Sarah Chen', location: 'Room 201', offsetDays: 5, hour: 9,  duration: 180, capacity: 20 },
            { course_code: 'GEN-ENG',    title: 'Conversation Club',       teacher: 'Mr Liam Brown',  location: 'Online (Zoom)', offsetDays: 1, hour: 18, duration: 60, capacity: 15 },
            { course_code: 'GEN-ENG',    title: 'Grammar Essentials',      teacher: 'Ms Anna Lee',    location: 'Room 102', offsetDays: 3, hour: 11, duration: 60, capacity: 12 },
            { course_code: 'GEN-ENG',    title: 'Vocabulary Builder',      teacher: 'Mr Liam Brown',  location: 'Room 102', offsetDays: 6, hour: 16, duration: 60, capacity: 12 }
        ];

        const stmt = db.prepare(`
            INSERT INTO ClassSessions (course_id, title, teacher_name, location, start_time, duration_minutes, capacity)
            VALUES (
                (SELECT id FROM Courses WHERE code = ?),
                ?, ?, ?, ?, ?, ?
            )
        `);

        for (const s of sessions) {
            const startTime = new Date(baseTime.getTime() + s.offsetDays * 24 * 60 * 60 * 1000);
            startTime.setHours(s.hour, 0, 0, 0);
            stmt.run(s.course_code, s.title, s.teacher, s.location, startTime.toISOString(), s.duration, s.capacity);
        }
        stmt.finalize();

        console.log(`Seeded ${sessions.length} class sessions.`);
        db.close();
    });
}