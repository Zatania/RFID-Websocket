require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    waitForConnections: true,
    connectionLimit: 20,
    idleTimeout: 60000,
    queueLimit: 0
  })

async function testConnection() {
    try {
        const connection = await pool.getConnection();
        console.log('Connected to MySQL database.');
        connection.release(); // Release the connection back to the pool
    } catch (err) {
        console.error('Database connection failed:', err);
    }
}

testConnection();

module.exports = pool;