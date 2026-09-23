// ====== REVERSE CODING PORTAL - BACKEND SERVER ======
// Setup: npm install express pg cors dotenv axios child_process fs
// Configure .env file with DATABASE_URL and JUDGE0_API_KEY
// Run: node server.js

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const axios = require('axios');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb' }));

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
                email VARCHAR(255) UNIQUE NOT NULL,
                name VARCHAR(255) NOT NULL,
                roll_no VARCHAR(50) NOT NULL,
                college VARCHAR(255),
                start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                warnings INT DEFAULT 0,
                disqualified BOOLEAN DEFAULT FALSE
            )
        `);

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

        console.log('✓ Database initialized');
    } catch (error) {
        console.error('Database init error:', error.message);
    }
}

// ===== API ENDPOINTS =====

// Register Participant
app.post('/api/register', async (req, res) => {
    const { fullName, email, rollNo, college } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO participants (email, name, roll_no, college) VALUES ($1, $2, $3, $4) RETURNING *',
            [email, fullName, rollNo, college]
        );
        
        await pool.query(
            'INSERT INTO leaderboard (participant_email) VALUES ($1)',
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

// Compile and Run C Code
app.post('/api/compile', async (req, res) => {
    const { code, language, input } = req.body;
    
    if (!code || !language) {
        return res.status(400).json({ error: 'Code and language required' });
    }

    const tempDir = path.join('/tmp', 'compile_' + Date.now());
    const sourceFile = path.join(tempDir, `program.${language === 'c' ? 'c' : 'cpp'}`);
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

        // Compile
        return new Promise((resolve) => {
            const compileCmd = language === 'c'
                ? `gcc -o ${executableFile} ${sourceFile} -lm`
                : `g++ -o ${executableFile} ${sourceFile} -lm`;

            exec(compileCmd, { timeout: 5000 }, (error, stdout, stderr) => {
                if (error) {
                    cleanupTemp(tempDir);
                    return resolve(res.json({ success: false, error: stderr || error.message }));
                }

                // Run executable
                exec(input ? `${executableFile} < ${inputFile}` : executableFile, 
                    { timeout: 5000 }, (error, stdout, stderr) => {
                    
                    cleanupTemp(tempDir);
                    
                    if (error && error.code !== 0) {
                        return resolve(res.json({ 
                            success: false, 
                            error: stderr || error.message 
                        }));
                    }

                    resolve(res.json({ 
                        success: true, 
                        output: stdout 
                    }));
                });
            });
        });

    } catch (error) {
        cleanupTemp(tempDir);
        res.status(500).json({ error: error.message });
    }
});

// Submit Solution
app.post('/api/submit', async (req, res) => {
    const { userId, challengeId, code, expectedOutput } = req.body;
    
    if (!userId || !challengeId || !code) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const tempDir = path.join('/tmp', 'submit_' + Date.now());
    const sourceFile = path.join(tempDir, 'solution.c');
    const executableFile = path.join(tempDir, 'solution');

    try {
        // Create temp directory
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        // Write source code
        fs.writeFileSync(sourceFile, code);

        // Compile
        return new Promise((resolve) => {
            exec(`gcc -o ${executableFile} ${sourceFile} -lm`, 
                { timeout: 5000 }, (error, stdout, stderr) => {
                
                if (error) {
                    cleanupTemp(tempDir);
                    
                    // Save failed submission
                    pool.query(
                        'INSERT INTO submissions (participant_email, challenge_id, code, language, status, error_message) VALUES ($1, $2, $3, $4, $5, $6)',
                        [userId, challengeId, code, 'c', 'compilation_error', stderr || error.message]
                    );

                    return resolve(res.json({ 
                        success: false, 
                        error: 'Compilation Error',
                        details: stderr 
                    }));
                }

                // Run executable with simple test input
                exec(`echo "${expectedOutput}" | ${executableFile}`, 
                    { timeout: 5000, shell: '/bin/bash' }, 
                    (error, stdout, stderr) => {
                    
                    cleanupTemp(tempDir);

                    const output = stdout.trim();
                    const expected = expectedOutput.trim();
                    const isCorrect = output === expected;

                    // Get challenge points
                    const challengePoints = {
                        1: 100, 2: 100, 3: 100, 4: 100, 5: 150,
                        6: 100, 7: 100, 8: 150, 9: 150, 10: 150,
                        11: 150, 12: 100, 13: 150, 14: 150, 15: 200
                    };

                    const points = isCorrect ? (challengePoints[challengeId] || 100) : 0;

                    // Save submission
                    pool.query(
                        'INSERT INTO submissions (participant_email, challenge_id, code, language, status, output, points_earned) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                        [userId, challengeId, code, 'c', isCorrect ? 'accepted' : 'wrong_answer', output, points]
                    );

                    // Update leaderboard if correct
                    if (isCorrect) {
                        pool.query(`
                            UPDATE leaderboard 
                            SET challenges_solved = challenges_solved + 1,
                                total_points = total_points + $1,
                                updated_at = CURRENT_TIMESTAMP
                            WHERE participant_email = $2
                        `, [points, userId]);
                    }

                    resolve(res.json({ 
                        success: isCorrect,
                        message: isCorrect ? 'Correct!' : 'Wrong Answer',
                        actualOutput: output,
                        expectedOutput: expected,
                        pointsEarned: points
                    }));
                });
            });
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
app.get('/health', (req, res) => {
    res.json({ status: 'ok', message: 'Reverse Coding Backend Running' });
});

// Error Handler
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Server error', message: err.message });
});

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
        
        app.listen(PORT, () => {
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