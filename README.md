# REVERSE_CODING

## Required Render configuration

Enable **Email/Password** in Firebase Authentication, then add these Render environment variables:

- `DATABASE_URL`: Neon pooled PostgreSQL connection string.
- `FIREBASE_SERVICE_ACCOUNT_JSON`: the Firebase service-account JSON as one-line JSON.
- `ADMIN_EMAILS`: comma-separated Firebase account emails allowed to manage challenges.

The browser signs users in with Firebase, the API verifies bearer tokens, and the server owns timer deadlines, hidden tests, submissions, and leaderboard state.