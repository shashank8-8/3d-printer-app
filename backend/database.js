const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'printer.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
          console.error('Error connecting to the database', err.message);
    } else {
          console.log('Connected to the SQLite database.');
    }
});

// Initialize tables
db.serialize(() => {
    // Users table
               db.run(`
                   CREATE TABLE IF NOT EXISTS users (
                         id INTEGER PRIMARY KEY AUTOINCREMENT,
                               name TEXT NOT NULL,
                                     email_or_phone TEXT UNIQUE NOT NULL,
                                           password TEXT NOT NULL,
                                                 role TEXT DEFAULT 'customer', -- 'customer' or 'admin'
                                                       reset_token TEXT,
                                                             reset_token_expiry INTEGER
                                                                 )
                                                                   `);

               // Printer Status Table
               db.run(`
                   CREATE TABLE IF NOT EXISTS printer_status (
                         id INTEGER PRIMARY KEY CHECK (id = 1),
                               status TEXT DEFAULT 'Free', -- 'Free', 'Reserved', 'Printing', 'Offline'
                                     current_job_id INTEGER,
                                           progress_percent INTEGER DEFAULT 0
                                               )
                                                 `);

               // Insert initial printer status
               db.run(`INSERT OR IGNORE INTO printer_status (id, status, current_job_id, progress_percent) VALUES (1, 'Free', NULL, 0)`);

               // Bookings table
               db.run(`
                   CREATE TABLE IF NOT EXISTS bookings (
                         id INTEGER PRIMARY KEY AUTOINCREMENT,
                               customer_name TEXT NOT NULL,
                                     phone_number TEXT NOT NULL,
                                           design_name TEXT NOT NULL,
                                                 design_notes TEXT,
                                                       design_file_url TEXT,
                                                             scheduled_time TEXT NOT NULL,
                                                                   status TEXT DEFAULT 'Pending', -- 'Pending', 'Approved', 'Printing', 'Completed', 'Rejected'
                                                                         final_image_url TEXT,
                                                                               created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                                                                                   )
                                                                                     `);
});

module.exports = db;
