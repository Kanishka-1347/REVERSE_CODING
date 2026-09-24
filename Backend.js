// ====== REVERSE CODING PORTAL - BACKEND SERVER ======
// Setup: npm install express pg cors dotenv axios child_process fs
// Configure .env file with DATABASE_URL and JUDGE0_API_KEY
// Run: node server.js

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const axios = require('axios');
const { exec } = require('child_process');
const { spawn } = require('child_process');
const http = require('http');
const { WebSocketServer } = require('ws');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const competitionDurationMs = 60 * 60 * 1000;
const adminEmails = new Set((process.env.ADMIN_EMAILS || '').split(',').map((email) => email.trim().toLowerCase()).filter(Boolean));
let firebaseAuth = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) });
    firebaseAuth = admin.auth();
}
const allowedOrigins = new Set([
    'https://reverse-coding-2k26.web.app',
    'https://reverse-coding-2k26.firebaseapp.com'
]);

// Middleware
app.use(cors({
    origin(origin, callback) {
        if (!origin || allowedOrigins.has(origin)) {
            return callback(null, true);
        }
        return callback(new Error('Origin not allowed'));
    }
}));
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
});
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb' }));
const compileLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });

async function requireAuth(req, res, next) {
    if (!firebaseAuth) {
        return res.status(503).json({ error: 'Firebase Admin authentication is not configured' });
    }
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    try {
        req.user = await firebaseAuth.verifyIdToken(header.slice(7));
        next();
    } catch (error) {
        res.status(401).json({ error: 'Invalid authentication token' });
    }
}

function requireAdmin(req, res, next) {
    if (!adminEmails.has(String(req.user.email || '').toLowerCase())) {
        return res.status(403).json({ error: 'Administrator access required' });
    }
    next();
}

// Database Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://user:password@localhost:5432/reverse_coding'
});

// Initialize Database
async function initializeDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS participants (
                id SERIAL PRIMARY KEY,
                firebase_uid VARCHAR(255) UNIQUE,
                email VARCHAR(255) UNIQUE NOT NULL,
                name VARCHAR(255) NOT NULL,
                roll_no VARCHAR(50) NOT NULL,
                college VARCHAR(255),
                start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                warnings INT DEFAULT 0,
                disqualified BOOLEAN DEFAULT FALSE
            )
        `);
        await pool.query('ALTER TABLE participants ADD COLUMN IF NOT EXISTS firebase_uid VARCHAR(255) UNIQUE');
        await pool.query('ALTER TABLE participants ADD COLUMN IF NOT EXISTS timer_deadline TIMESTAMP');

        await pool.query(`
            CREATE TABLE IF NOT EXISTS submissions (
                id SERIAL PRIMARY KEY,
                participant_email VARCHAR(255) NOT NULL,
                challenge_id INT NOT NULL,
                code TEXT NOT NULL,
                language VARCHAR(50),
                status VARCHAR(50),
                output TEXT,
                error_message TEXT,
                points_earned INT DEFAULT 0,
                submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (participant_email) REFERENCES participants(email)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS leaderboard (
                id SERIAL PRIMARY KEY,
                participant_email VARCHAR(255) UNIQUE NOT NULL,
                challenges_solved INT DEFAULT 0,
                total_points INT DEFAULT 0,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (participant_email) REFERENCES participants(email)
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS challenges (
                id INT PRIMARY KEY,
                title VARCHAR(255) NOT NULL,
                description TEXT NOT NULL,
                difficulty VARCHAR(20) NOT NULL,
                points INT NOT NULL,
                input TEXT NOT NULL,
                output TEXT NOT NULL,
                explanation TEXT NOT NULL,
                templates JSONB NOT NULL DEFAULT '{}'::jsonb,
                tests JSONB NOT NULL DEFAULT '[]'::jsonb,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        for (const challenge of challengeCatalog) {
            await pool.query(
                `INSERT INTO challenges (id, title, description, difficulty, points, input, output, explanation, tests)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
                [challenge.id, challenge.title, challenge.description, challenge.difficulty, challenge.points, challenge.input, challenge.output, challenge.explanation, challenge.tests]
            );
        }

        console.log('✓ Database initialized');
    } catch (error) {
        console.error('Database init error:', error.message);
    }
}

const languageConfigs = {
    c: { extension: 'c', compile: ['gcc', (source, executable) => ['-o', executable, source, '-lm']], run: (source, executable) => [executable, []] },
    cpp: { extension: 'cpp', compile: ['g++', (source, executable) => ['-o', executable, source, '-lm']], run: (source, executable) => [executable, []] },
    python: { extension: 'py', run: (source) => ['python3', [source]] },
    java: { extension: 'java', compile: ['javac', (source) => [source]], run: (source, executable, tempDir) => ['java', ['-cp', tempDir, 'Main']] },
    javascript: { extension: 'js', run: (source) => ['node', [source]] },
    v: { extension: 'v', run: (source) => ['v', ['run', source]] }
};
const challengeTests = require('./challenge-tests.json');
const challengeCatalog = [
    [1, 'Print Pattern - Triangle', 'Print a triangle pattern with numbers 1 to n', 'easy', 100, '4', '1\n1 2\n1 2 3\n1 2 3 4'],
    [2, 'Factorial', 'Calculate factorial of a number', 'easy', 100, '5', '120'],
    [3, 'String Reversal', 'Reverse a given string', 'easy', 100, 'CHENNAI', 'IANNEHC'],
    [4, 'Prime Number Check', 'Check if number is prime', 'easy', 100, '7', 'PRIME'],
    [5, 'Fibonacci Sequence', 'Print first n Fibonacci numbers', 'medium', 150, '6', '0 1 1 2 3 5'],
    [6, 'Palindrome Check', 'Check if number is palindrome', 'easy', 100, '121', 'PALINDROME'],
    [7, 'Sum of Digits', 'Find sum of all digits', 'easy', 100, '1234', '10'],
    [8, 'Armstrong Number', 'Check if Armstrong number', 'medium', 150, '153', 'ARMSTRONG'],
    [9, 'Find Mode', 'Find most frequent element', 'medium', 150, '5 2 9 1 5', '5'],
    [10, 'Word Frequency', 'Count frequency of words', 'medium', 150, 'hi hello hi', 'hi=2 hello=1'],
    [11, 'Hollow Square', 'Print hollow square pattern', 'medium', 150, '4', '****\n*  *\n*  *\n****'],
    [12, 'Leap Year', 'Check if year is leap year', 'easy', 100, '2024', 'LEAP YEAR'],
    [13, 'Anagram Check', 'Check if strings are anagrams', 'medium', 150, 'listen silent', 'ANAGRAM'],
    [14, 'Remove Duplicates', 'Remove duplicates maintaining order', 'medium', 150, '1 2 2 3 1', '1 2 3'],
    [15, 'Diamond Pattern', 'Print diamond pattern', 'hard', 200, '5', '    *\n   ***\n  *****\n *******\n*********']
].map(([id, title, description, difficulty, points, input, output]) => ({
    id, title, description, difficulty, points, input, output, explanation: description,
    tests: challengeTests[String(id)]
}));

function normalizeOutput(value) {
    return String(value).replace(/\r\n/g, '\n').trim();
}

function runProcess(command, args, input = '') {
    return new Promise((resolve) => {
        const child = spawn(command, args, { shell: false });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, 5000);

        child.stdout.on('data', (data) => { stdout += data; });
        child.stderr.on('data', (data) => { stderr += data; });
        child.on('error', (error) => {
            clearTimeout(timer);
            resolve({ code: 1, stdout, stderr: error.message, timedOut });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code: code ?? 1, stdout, stderr, timedOut });
        });
        child.stdin.end(input);
    });
}

// ===== API ENDPOINTS =====

// Register Participant
app.post('/api/register', requireAuth, async (req, res) => {
    const { fullName, email, rollNo, college } = req.body;
    if (email.toLowerCase() !== String(req.user.email || '').toLowerCase()) {
        return res.status(403).json({ error: 'Email does not match authenticated user' });
    }
    try {
        const result = await pool.query(
            `INSERT INTO participants (firebase_uid, email, name, roll_no, college, timer_deadline)
             VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP + INTERVAL '1 hour')
             ON CONFLICT (email) DO UPDATE SET firebase_uid = EXCLUDED.firebase_uid,
                     name = EXCLUDED.name, roll_no = EXCLUDED.roll_no, college = EXCLUDED.college,
                     timer_deadline = COALESCE(participants.timer_deadline, EXCLUDED.timer_deadline)
             RETURNING *`,
            [req.user.uid, email, fullName, rollNo, college]
        );
        
        await pool.query(
            'INSERT INTO leaderboard (participant_email) VALUES ($1) ON CONFLICT (participant_email) DO NOTHING',
            [email]
        );

        res.json({ success: true, participant: result.rows[0] });
    } catch (error) {
        if (error.code === '23505') {
            res.status(400).json({ error: 'Email already registered' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// Compile and run code in an isolated temporary process.
app.post('/api/compile', requireAuth, compileLimiter, async (req, res) => {
    const { code, language, input } = req.body;
    
    if (!code || !language) {
        return res.status(400).json({ error: 'Code and language required' });
    }

    const config = languageConfigs[language];
    if (!config) {
        return res.status(400).json({ error: 'Unsupported language' });
    }

    const tempDir = path.join('/tmp', 'compile_' + Date.now());
    const sourceFile = path.join(tempDir, `program.${config.extension}`);
    const executableFile = path.join(tempDir, 'program');
    const inputFile = path.join(tempDir, 'input.txt');

    try {
        // Create temp directory
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        // Write source code
        fs.writeFileSync(sourceFile, code);

        // Write input
        if (input) {
            fs.writeFileSync(inputFile, input);
        }

        if (language === 'java') {
            fs.renameSync(sourceFile, path.join(tempDir, 'Main.java'));
        }

        const actualSource = language === 'java' ? path.join(tempDir, 'Main.java') : sourceFile;
        if (config.compile) {
            const [compiler, getArgs] = config.compile;
            const compileResult = await runProcess(compiler, getArgs(actualSource, executableFile));
            if (compileResult.code !== 0) {
                cleanupTemp(tempDir);
                return res.json({ success: false, error: compileResult.stderr || 'Compilation failed' });
            }
        }

        const [runner, args] = config.run(actualSource, executableFile, tempDir);
        const runResult = await runProcess(runner, args, input || '');
        cleanupTemp(tempDir);

        if (runResult.code !== 0) {
            return res.json({ success: false, error: runResult.stderr || (runResult.timedOut ? 'Execution timed out' : 'Execution failed') });
        }

        res.json({ success: true, output: runResult.stdout });

    } catch (error) {
        cleanupTemp(tempDir);
        res.status(500).json({ error: error.message });
    }
});

// Submit Solution
app.post('/api/submit', requireAuth, compileLimiter, async (req, res) => {
    const { challengeId, code, language } = req.body;
    const userId = req.user.email;
    
    if (!userId || !challengeId || !code) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const config = languageConfigs[language];
    if (!config) {
        return res.status(400).json({ error: 'Unsupported language' });
    }

    const challengeRecord = await pool.query('SELECT tests FROM challenges WHERE id = $1', [challengeId]);
    const tests = challengeRecord.rows[0]?.tests?.length ? challengeRecord.rows[0].tests : challengeTests[String(challengeId)];
    if (!tests) {
        return res.status(400).json({ error: 'Challenge test cases not found' });
    }

    const participant = await pool.query('SELECT timer_deadline, disqualified FROM participants WHERE email = $1', [userId]);
    if (!participant.rows[0]) {
        return res.status(403).json({ error: 'Participant registration required' });
    }
    if (participant.rows[0].disqualified || new Date(participant.rows[0].timer_deadline).getTime() <= Date.now()) {
        return res.status(403).json({ error: 'Competition time has ended or participant is disqualified' });
    }

    const tempDir = path.join('/tmp', 'submit_' + Date.now());
    const sourceFile = path.join(tempDir, `solution.${config.extension}`);
    const executableFile = path.join(tempDir, 'solution');

    try {
        // Create temp directory
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        // Write source code
        fs.writeFileSync(sourceFile, code);

        if (language === 'java') {
            fs.renameSync(sourceFile, path.join(tempDir, 'Main.java'));
        }

        const actualSource = language === 'java' ? path.join(tempDir, 'Main.java') : sourceFile;
        if (config.compile) {
            const [compiler, getArgs] = config.compile;
            const compileResult = await runProcess(compiler, getArgs(actualSource, executableFile));
            if (compileResult.code !== 0) {
                cleanupTemp(tempDir);
                await pool.query(
                    'INSERT INTO submissions (participant_email, challenge_id, code, language, status, error_message) VALUES ($1, $2, $3, $4, $5, $6)',
                    [userId, challengeId, code, language, 'compilation_error', compileResult.stderr]
                );
                return res.json({ success: false, error: 'Compilation Error', details: compileResult.stderr });
            }
        }

        const results = [];
        for (const test of tests) {
            const [runner, args] = config.run(actualSource, executableFile, tempDir);
            const runResult = await runProcess(runner, args, test.input);
            const actual = normalizeOutput(runResult.stdout);
            const expected = normalizeOutput(test.output);
            results.push({
                passed: runResult.code === 0 && actual === expected,
                actual,
                expected,
                error: runResult.stderr || null
            });
        }
        cleanupTemp(tempDir);

        const isCorrect = results.every((result) => result.passed);
        const failedTest = results.find((result) => !result.passed);
        const output = JSON.stringify(results);

                    // Get challenge points
                    const challengePoints = {
                        1: 100, 2: 100, 3: 100, 4: 100, 5: 150,
                        6: 100, 7: 100, 8: 150, 9: 150, 10: 150,
                        11: 150, 12: 100, 13: 150, 14: 150, 15: 200
                    };

                    const points = isCorrect ? (challengePoints[challengeId] || 100) : 0;

                    // Save submission
                    await pool.query(
                        'INSERT INTO submissions (participant_email, challenge_id, code, language, status, output, points_earned) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                        [userId, challengeId, code, language, isCorrect ? 'accepted' : 'wrong_answer', output, points]
                    );

                    // Update leaderboard if correct
                    if (isCorrect) {
                        await pool.query(`
                            UPDATE leaderboard 
                            SET challenges_solved = challenges_solved + 1,
                                total_points = total_points + $1,
                                updated_at = CURRENT_TIMESTAMP
                            WHERE participant_email = $2
                        `, [points, userId]);
                        broadcastLeaderboardUpdate();
                    }

        res.json({
            success: isCorrect,
            message: isCorrect ? `Correct! Passed ${tests.length}/${tests.length} tests.` : `Wrong Answer. Failed test ${results.indexOf(failedTest) + 1}/${tests.length}.`,
            actualOutput: failedTest?.actual || '',
            expectedOutput: failedTest?.expected || '',
            pointsEarned: points
        });

    } catch (error) {
        cleanupTemp(tempDir);
        res.status(500).json({ error: error.message });
    }
});

// Get Leaderboard
app.get('/api/leaderboard', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                p.name,
                p.email,
                l.challenges_solved,
                l.total_points,
                ROW_NUMBER() OVER (ORDER BY l.total_points DESC) as rank
            FROM leaderboard l
            JOIN participants p ON l.participant_email = p.email
            WHERE p.disqualified = FALSE
            ORDER BY l.total_points DESC
            LIMIT 50
        `);
        
        res.json({ success: true, leaderboard: result.rows });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get Participant Stats
app.get('/api/stats/:email', async (req, res) => {
    const { email } = req.params;
    try {
        const participant = await pool.query('SELECT * FROM participants WHERE email = $1', [email]);
        const leaderboard = await pool.query('SELECT * FROM leaderboard WHERE participant_email = $1', [email]);
        const submissions = await pool.query(
            'SELECT * FROM submissions WHERE participant_email = $1 ORDER BY submitted_at DESC',
            [email]
        );

        res.json({
            success: true,
            participant: participant.rows[0],
            stats: leaderboard.rows[0],
            submissions: submissions.rows
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Record Warning
app.post('/api/warn', async (req, res) => {
    const { email, count } = req.body;
    try {
        if (count >= 3) {
            await pool.query(
                'UPDATE participants SET disqualified = TRUE WHERE email = $1',
                [email]
            );
            res.json({ success: true, disqualified: true });
        } else {
            await pool.query(
                'UPDATE participants SET warnings = $1 WHERE email = $2',
                [count, email]
            );
            res.json({ success: true, disqualified: false });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get Challenge Details
app.get('/api/challenge/:id', async (req, res) => {
    const { id } = req.params;
    const challenges = require('./challenges.json'); // See separate file
    const challenge = challenges.find(c => c.id === parseInt(id));
    
    if (!challenge) {
        return res.status(404).json({ error: 'Challenge not found' });
    }
    
    res.json({ success: true, challenge });
});

// Health Check
app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'Reverse Coding API is running' });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', message: 'Reverse Coding Backend Running' });
});

// Error Handler
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Server error', message: err.message });
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'connected' }));
});

async function broadcastLeaderboardUpdate() {
    const result = await pool.query(`
        SELECT p.name, l.challenges_solved, l.total_points,
               ROW_NUMBER() OVER (ORDER BY l.total_points DESC) as rank
        FROM leaderboard l JOIN participants p ON l.participant_email = p.email
        WHERE p.disqualified = FALSE ORDER BY l.total_points DESC LIMIT 50
    `);
    const payload = JSON.stringify({ type: 'leaderboard', leaderboard: result.rows });
    wss.clients.forEach((client) => {
        if (client.readyState === 1) client.send(payload);
    });
}

// Cleanup function
function cleanupTemp(dir) {
    try {
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true });
        }
    } catch (error) {
        console.error('Cleanup error:', error);
    }
}

// Start Server
async function start() {
    try {
        await initializeDatabase();
        
        server.listen(PORT, () => {
            console.log(`✓ Server running on http://localhost:${PORT}`);
            console.log('✓ Health check: http://localhost:' + PORT + '/health');
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

start();

// Graceful shutdown
process.on('SIGINT', () => {
    pool.end();
    process.exit(0);
});

app.get('/api/session', requireAuth, async (req, res) => {
    const result = await pool.query('SELECT timer_deadline, warnings, disqualified FROM participants WHERE firebase_uid = $1', [req.user.uid]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Participant not registered' });
    res.json({
        deadline: result.rows[0].timer_deadline,
        remainingSeconds: Math.max(0, Math.floor((new Date(result.rows[0].timer_deadline).getTime() - Date.now()) / 1000)),
        warnings: result.rows[0].warnings,
        disqualified: result.rows[0].disqualified
    });
});

app.get('/api/submissions', requireAuth, async (req, res) => {
    const result = await pool.query(
        'SELECT id, challenge_id, language, status, output, error_message, points_earned, submitted_at FROM submissions WHERE participant_email = $1 ORDER BY submitted_at DESC LIMIT 100',
        [req.user.email]
    );
    res.json({ submissions: result.rows });
});

app.get('/api/admin/challenges', requireAuth, requireAdmin, async (req, res) => {
    const result = await pool.query('SELECT * FROM challenges ORDER BY id');
    res.json({ challenges: result.rows });
});

app.post('/api/admin/challenges', requireAuth, requireAdmin, async (req, res) => {
    const { id, title, description, difficulty, points, input, output, explanation, templates, tests } = req.body;
    if (!id || !title || !description || !difficulty || !points || !Array.isArray(tests)) {
        return res.status(400).json({ error: 'Challenge fields and tests are required' });
    }
    const result = await pool.query(
        `INSERT INTO challenges (id, title, description, difficulty, points, input, output, explanation, templates, tests)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, description=EXCLUDED.description,
         difficulty=EXCLUDED.difficulty, points=EXCLUDED.points, input=EXCLUDED.input, output=EXCLUDED.output,
         explanation=EXCLUDED.explanation, templates=EXCLUDED.templates, tests=EXCLUDED.tests, updated_at=CURRENT_TIMESTAMP
         RETURNING *`,
        [id, title, description, difficulty, points, input || '', output || '', explanation || '', templates || {}, tests]
    );
    res.json({ challenge: result.rows[0] });
});

app.delete('/api/admin/challenges/:id', requireAuth, requireAdmin, async (req, res) => {
    await pool.query('DELETE FROM challenges WHERE id = $1', [req.params.id]);
    res.json({ success: true });
});