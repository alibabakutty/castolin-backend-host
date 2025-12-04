import express from "express";
import mysql from "mysql2";
import cors from "cors";
import admin from 'firebase-admin';
import dotenv from 'dotenv';

const app = express(); 
dotenv.config();

// ✅ Root route for Vercel (MUST add this)
app.get('/', (req, res) => {
  res.json({
    message: 'Castolin Backend API',
    status: 'running',
    endpoints: [
      '/api/health',
      '/api/health/db',
      '/me-admin',
      '/login-admin'
    ],
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString()
  });
});

// Firebase initialization
const firebaseBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;

if (firebaseBase64) {
  try {
    const serviceAccount = JSON.parse(Buffer.from(firebaseBase64, "base64").toString('utf8'));
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
    }
    console.log("Firebase admin initialized successfully!!");
  } catch (error) {
    console.error("Failed to decode firebase base64 key:", error);
  }
}
// CORS configuration
const allowedOrigins = [
  'https://friendly-heliotrope-401618.netlify.app',
  'http://localhost:5173',
  'http://localhost:3000'
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(express.json());

// Database configuration (simplified for now)
const dbConfig = {
  host: process.env.MYSQLHOST || "ballast.proxy.rlwy.net",
  user: process.env.MYSQLUSER || "root",
  password: process.env.MYSQLPASSWORD || "cAAiaBeGHjxZVSBFbedADrenyDVkESSu",
  database: process.env.MYSQLDATABASE || "railway",
  port: process.env.MYSQLPORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

const db = mysql.createPool(dbConfig);

// Test database connection (non-blocking)
db.getConnection((err, connection) => {
  if (err) {
    console.error("❌ Database connection failed:", err.message);
  } else {
    console.log("✅ Connected to MySQL Database");
    connection.release();
  }
});
// Health endpoints
app.get("/api/health", (req, res) => {
  res.status(200).json({
    status: 'OK',
    message: 'Backend is running successfully',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});
// 📌 Get all customers
app.get("/customers", (req, res) => {
  const sql = "SELECT * FROM customer";   // your Railway table name

  db.query(sql, (err, results) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }

    res.json({
      success: true,
      count: results.length,
      customers: results
    });
  });
});

app.get("/api/health/db", (req, res) => {
  db.query('SELECT 1 as test', (err, results) => {
    if (err) {
      return res.status(500).json({
        status: 'ERROR',
        database: 'Connection failed',
        error: err.message
      });
    }
    res.json({
      status: 'OK',
      database: 'Connected successfully',
      test: results[0].test
    });
  });
});
// Firebase token verification middleware
const verifyToken = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token provided" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.uid = decoded.uid;
    req.user = decoded;
    next();
  } catch (err) {
    console.error("Token verification error:", err);
    res.status(401).json({ error: "Invalid token" });
  }
};
// API routes
app.get("/me-admin", verifyToken, (req, res) => {
  db.query(
    "SELECT role FROM admins WHERE firebase_uid = ?",
    [req.uid],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});
app.post("/login-admin", verifyToken, (req, res) => {
  db.query(
    "SELECT id, username, mobile_number, email, role, firebase_uid FROM admins WHERE firebase_uid = ?",
    [req.uid],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ 
          success: false,
          error: "Database error" 
        });
      }
      if (rows.length === 0) {
        return res.status(404).json({ 
          success: false,
          error: "Admin not found" 
        });
      }
      res.json({
        success: true,
        message: "Admin login successful",
        user: rows[0],
        userType: 'admin'
      });
    }
  );
});
app.get("/admins/:id", (req, res) => {
  const sql = "SELECT * FROM admins WHERE id = ?";
  db.query(sql, [req.params.id], (err, results) => {
    if (err) return res.status(500).json({ error: "Internal server error" });
    if (results.length === 0) return res.status(404).json({ error: "Admin not found" });
    res.json(results[0]);
  });
});
// ✅ For Vercel: Only listen locally, export app for serverless
if (process.env.VERCEL !== '1') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Local server running on port ${PORT}`);
  });
}
// ✅ Export for Vercel serverless function
export default app;