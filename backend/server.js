const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
require('dotenv').config();
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = 'supersecretkey_change_in_production';

// Middleware
app.use(cors());
app.use(express.json());

// Setup Multer for image uploads from ESP32 & design files
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
          cb(null, 'uploads/');
    },
    filename: function (req, file, cb) {
          cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// --- EMAIL CONFIGURATION ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS
    }
});

const sendMailWrapper = (to, subject, text) => {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
          console.log(`[SIMULATED EMAIL TO ${to}] Subject: ${subject} | Body: ${text}`);
          return;
    }
    const mailOptions = { from: process.env.EMAIL_USER, to, subject, text };
    transporter.sendMail(mailOptions, (error, info) => {
          if (error) console.log('Error sending email:', error);
          else console.log('Email sent:', info.response);
    });
};

// --- AUTHENTICATION ROUTES ---
app.post('/api/auth/register', async (req, res) => {
    const { name, email_or_phone, password, role } = req.body;
    if (!name || !email_or_phone || !password || !role) return res.status(400).json({ error: "All fields are required" });

           try {
                 const salt = await bcrypt.genSalt(10);
                 const hashedPassword = await bcrypt.hash(password, salt);

      db.run("INSERT INTO users (name, email_or_phone, password, role) VALUES (?, ?, ?, ?)", 
                   [name, email_or_phone, hashedPassword, role], function(err) {
                           if (err) return res.status(400).json({ error: "User already exists or database error" });

                   const token = jwt.sign({ id: this.lastID, role, name }, JWT_SECRET, { expiresIn: '24h' });

                   // Email Trigger: Account Creation
                   sendMailWrapper(email_or_phone, 'Welcome to 3D Smart Print!', `Hello ${name},\n\nYour account has been successfully created as a ${role}.\n\nWelcome!`);

                   res.json({ token, user: { id: this.lastID, name, role, email_or_phone } });
                   });
           } catch (err) {
                 res.status(500).json({ error: "Server error" });
           }
});

app.post('/api/auth/login', (req, res) => {
    let { email_or_phone, password } = req.body;

           if (!email_or_phone || !password) {
                 return res.status(400).json({ error: "Missing fields" });
           }

           const email = email_or_phone.trim().toLowerCase();
    const pass = password.trim();

           console.log("INPUT:", email, pass);

           db.get(
                 "SELECT * FROM users WHERE LOWER(email_or_phone) = LOWER(?)",
                 [email],
                 async (err, user) => {
                         if (err) return res.status(500).json({ error: "Database error" });

                   console.log("USER:", user);

                   if (!user) {
                             return res.status(400).json({ error: "Invalid credentials" });
                   }

                   const isMatch = await bcrypt.compare(pass, user.password);
                         console.log("MATCH:", isMatch);

                   if (!isMatch) {
                             return res.status(400).json({ error: "Invalid credentials" });
                   }

                   const token = jwt.sign(
                     { id: user.id, role: user.role, name: user.name },
                             JWT_SECRET,
                     { expiresIn: '24h' }
                           );

                   res.json({
                             token,
                             user: {
                                         id: user.id,
                                         name: user.name,
                                         role: user.role,
                                         email_or_phone: user.email_or_phone
                             }
                   });
                 }
               );
});

app.post('/api/auth/forgot-password', (req, res) => {
    const { email_or_phone } = req.body;

           db.get("SELECT * FROM users WHERE email_or_phone = ?", [email_or_phone], (err, user) => {
                 if (err || !user) return res.status(400).json({ error: "If that email exists, a reset link has been sent." }); // Security best practice

                      const resetToken = crypto.randomBytes(32).toString('hex');
                 const expiry = Date.now() + 3600000; // 1 hour

                      db.run("UPDATE users SET reset_token = ?, reset_token_expiry = ? WHERE id = ?", [resetToken, expiry, user.id], (err) => {
                              if (err) return res.status(500).json({ error: "Database error" });

                                   const resetLink = `http://localhost:5173/?reset=${resetToken}`;
                              sendMailWrapper(user.email_or_phone, 'Password Reset Request', `Hello ${user.name},\n\nYou requested a password reset. Click this link to reset your password:\n${resetLink}\n\nIf you did not request this, please ignore this email.`);

                                   res.json({ message: "If that email exists, a reset link has been sent." });
                      });
           });
});

app.post('/api/auth/reset-password', async (req, res) => {
    const { token, new_password } = req.body;
    if (!token || !new_password) return res.status(400).json({ error: "Token and new password required" });

           db.get("SELECT * FROM users WHERE reset_token = ?", [token], async (err, user) => {
                 if (err || !user) return res.status(400).json({ error: "Invalid or expired reset token" });

                      if (Date.now() > user.reset_token_expiry) {
                              return res.status(400).json({ error: "Reset token has expired" });
                      }

                      const salt = await bcrypt.genSalt(10);
                 const hashedPassword = await bcrypt.hash(new_password, salt);

                      db.run("UPDATE users SET password = ?, reset_token = NULL, reset_token_expiry = NULL WHERE id = ?", [hashedPassword, user.id], (err) => {
                              if (err) return res.status(500).json({ error: "Database error" });

                                   sendMailWrapper(user.email_or_phone, 'Password Reset Successful', `Hello ${user.name},\n\nYour password has been successfully reset. You can now log in with your new password.`);
                              res.json({ message: "Password reset successful" });
                      });
           });
});

// --- API ROUTES ---

app.get('/api/printer/status', (req, res) => {
    db.get("SELECT * FROM printer_status WHERE id = 1", (err, row) => {
          if (err) return res.status(500).json({ error: err.message });
          res.json(row);
    });
});

app.get('/api/bookings', (req, res) => {
    const { phone_number } = req.query;
    let query = "SELECT * FROM bookings ORDER BY created_at DESC";
    let params = [];

          if (phone_number) {
                query = "SELECT * FROM bookings WHERE phone_number = ? ORDER BY created_at DESC";
                params = [phone_number];
          }

          db.all(query, params, (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json(rows);
          });
});

app.post('/api/bookings', upload.single('design_file'), (req, res) => {
    const { customer_name, phone_number, design_name, design_notes, scheduled_time } = req.body;
    const file = req.file;

           if (!customer_name || !phone_number || !design_name || !scheduled_time) {
                 return res.status(400).json({ error: "Missing required fields" });
           }

           const designFileUrl = file ? "/uploads/" + file.filename : null;

           const query = "INSERT INTO bookings (customer_name, phone_number, design_name, design_notes, design_file_url, scheduled_time, status) VALUES (?, ?, ?, ?, ?, ?, 'Pending')";

           db.run(query, [customer_name, phone_number, design_name, design_notes, designFileUrl, scheduled_time], function(err) {
                 if (err) return res.status(500).json({ error: err.message });
                 res.json({ id: this.lastID, message: "Booking created successfully, waiting for approval." });
           });
});

app.post('/api/bookings/:id/approve', (req, res) => {
    const bookingId = req.params.id;

           // Check if printer is already reserved or printing
           db.get("SELECT status FROM printer_status WHERE id = 1", (err, printer) => {
                 if (err) return res.status(500).json({ error: err.message });
                 if (printer.status === 'Reserved' || printer.status === 'Printing') {
                         return res.status(400).json({ error: "Cannot approve: Printer is currently busy with another job." });
                 }

                      db.run("UPDATE bookings SET status = 'Approved' WHERE id = ?", [bookingId], function(err) {
                              if (err) return res.status(500).json({ error: err.message });
                              db.run("UPDATE printer_status SET status = 'Reserved', current_job_id = ?, progress_percent = 0 WHERE id = 1", [bookingId]);
                              res.json({ message: "Booking approved. Printer reserved." });
                      });
           });
});

app.post('/api/bookings/:id/reject', (req, res) => {
    const bookingId = req.params.id;
    db.run("UPDATE bookings SET status = 'Rejected' WHERE id = ?", [bookingId], function(err) {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ message: "Booking rejected." });
    });
});

app.post('/api/bookings/:id/cancel', (req, res) => {
    const bookingId = req.params.id;
    db.run("UPDATE bookings SET status = 'Cancelled' WHERE id = ? AND status = 'Pending'", [bookingId], function(err) {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ message: "Booking cancelled successfully." });
    });
});

app.post('/api/bookings/:id/start', (req, res) => {
    const bookingId = req.params.id;
    db.run("UPDATE bookings SET status = 'Printing' WHERE id = ?", [bookingId], function(err) {
          if (err) return res.status(500).json({ error: err.message });
          db.run("UPDATE printer_status SET status = 'Printing', current_job_id = ?, progress_percent = 0 WHERE id = 1", [bookingId]);
          res.json({ message: "Printing started." });
    });
});

app.post('/api/printer/progress', (req, res) => {
    const { progress } = req.body;

           if (parseInt(progress) === 100) {
                 // Get the current job to complete it
      db.get("SELECT current_job_id FROM printer_status WHERE id = 1", (err, row) => {
              if (err || !row || !row.current_job_id) return res.status(500).json({ error: "No active job found." });
              const bookingId = row.current_job_id;

                   // Mark booking as completed
                   db.run("UPDATE bookings SET status = 'Completed' WHERE id = ?", [bookingId], function(err) {
                             if (err) return res.status(500).json({ error: err.message });

                                  // Update printer status to Bed Occupied instead of Free
                                  db.run("UPDATE printer_status SET status = 'Bed Occupied', progress_percent = 100 WHERE id = 1");

                                  // SMS Logging
                                  db.get("SELECT * FROM bookings WHERE id = ?", [bookingId], (err, booking) => {
                                              if (booking) {
                                                            console.log("\n=========================================");
                                                            console.log("[SMS SENDING TO: " + booking.phone_number + "]");
                                                            console.log("Message: Hello " + booking.customer_name + ", your 3D print for '" + booking.design_name + "' is finished!");
                                                            console.log("Please wait for the Admin to remove it from the bed.");
                                                            console.log("=========================================\n");
                                              }
                                  });

                                  res.json({ message: "Progress at 100%, print finished! Bed is now occupied." });
                   });
      });
           } else {
                 db.run("UPDATE printer_status SET progress_percent = ? WHERE id = 1", [progress], function(err) {
                         if (err) return res.status(500).json({ error: err.message });
                         res.json({ message: "Progress updated" });
                 });
           }
});

app.post('/api/printer/finish/:bookingId', upload.single('image'), (req, res) => {
    const bookingId = req.params.bookingId;
    const file = req.file;

           if (!file) return res.status(400).json({ error: "No image file provided." });
    const imageUrl = "/uploads/" + file.filename;

           db.run("UPDATE bookings SET status = 'Completed', final_image_url = ? WHERE id = ?", [imageUrl, bookingId], function(err) {
                 if (err) return res.status(500).json({ error: err.message });

                      // Set printer status to Bed Occupied
                      db.run("UPDATE printer_status SET status = 'Bed Occupied', progress_percent = 100 WHERE id = 1");

                      // SMS Logging
                      db.get("SELECT * FROM bookings WHERE id = ?", [bookingId], (err, booking) => {
                              if (booking) {
                                        console.log("\n=========================================");
                                        console.log("[SMS SENDING TO: " + booking.phone_number + "]");
                                        console.log("Message: Hello " + booking.customer_name + ", your 3D print for '" + booking.design_name + "' is finished!");
                                        console.log("View final result here: " + imageUrl);
                                        console.log("=========================================\n");
                              }
                      });

                      res.json({ message: "Print finished successfully, image saved and SMS sent. Bed Occupied." });
           });
});

app.post('/api/printer/clear-bed', (req, res) => {
    // Reset printer to Free first
           db.run("UPDATE printer_status SET status = 'Free', current_job_id = NULL, progress_percent = 0 WHERE id = 1", function(err) {
                 if (err) return res.status(500).json({ error: err.message });

                      // Check if there is a next approved job in the queue
                      db.get("SELECT * FROM bookings WHERE status = 'Approved' ORDER BY created_at ASC LIMIT 1", (err, nextJob) => {
                              if (nextJob) {
                                        // Auto-start the next approved job
                                db.run("UPDATE bookings SET status = 'Printing' WHERE id = ?", [nextJob.id]);
                                        db.run("UPDATE printer_status SET status = 'Printing', current_job_id = ?, progress_percent = 0 WHERE id = 1", [nextJob.id]);

                                // Notify Admin via email
                                sendMailWrapper(
                                            process.env.EMAIL_USER,
                                            'Next Print Job Started Automatically',
                                            `Hello Admin,\n\nThe bed has been cleared and the next job has started automatically.\n\nJob Details:\n- Customer: ${nextJob.customer_name}\n- Design: ${nextJob.design_name}\n- Scheduled: ${nextJob.scheduled_time}\n\nPlease monitor the printer.`
                                          );

                                return res.json({ message: `Bed cleared! Next job "${nextJob.design_name}" for ${nextJob.customer_name} has started automatically.`, nextJob });
                              }

                                   res.json({ message: "Bed cleared successfully. Printer is now Free. No pending jobs in queue." });
                      });
           });
});

app.get('/api/download', (req, res) => {
    const file = path.resolve(__dirname, '../../3d-printer-app-final.zip');
    if (fs.existsSync(file)) {
          res.setHeader('Content-Disposition', 'attachment; filename="3d-printer-app.zip"');
          res.setHeader('Content-Type', 'application/zip');
          fs.createReadStream(file).pipe(res);
    } else {
          res.status(404).json({ error: "Download file not found. Please wait for zip generation." });
    }
});

// Serve built React frontend (must be AFTER all API routes)
const frontendDist = path.join(__dirname, '../frontend/dist');
if (fs.existsSync(frontendDist)) {
    app.use(express.static(frontendDist));
    app.get('/{*splat}', (req, res) => {
          res.sendFile(path.join(frontendDist, 'index.html'));
    });
    console.log("Serving frontend from:", frontendDist);
} else {
    console.log("No frontend build found. Run 'npm run build' in the frontend folder.");
}

app.listen(PORT, '0.0.0.0', () => {
    console.log("Server running on port " + PORT);
});
