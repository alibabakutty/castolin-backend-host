import express from "express";
import mysql from "mysql2";
import cors from "cors";
import admin from 'firebase-admin';
// import serviceAccount from "./config/serviceAccountKey.json" with { type: "json" }; 
import dotenv from 'dotenv';

const app = express(); 
dotenv.config();

const firebaseBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;

if (!firebaseBase64) {
  console.error('Missing firebase env variable');
  process.exit(1);
}

let serviceAccount = null;

try {
  serviceAccount = JSON.parse(Buffer.from(firebaseBase64, "base64").toString('utf8'))
} catch (error) {
  console.error("Failed to decode firebase base64 key:", error);
  process.exit(1); 
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

console.log("Firebase admin initialized successfully!!");

// ✅ PROPER CORS CONFIGURATION FOR RAILWAY
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, Postman, server-to-server)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      'https://castolin-frontend-production.up.railway.app', // Your frontend Railway URL
      'http://localhost:5173', // Vite dev server
      'http://localhost:3000', // React dev server
      process.env.CLIENT_URL, // From environment variable
    ].filter(Boolean); // Remove any undefined values

    // Check if the origin is in allowed list
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.log('CORS blocked origin:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: [
    'Content-Type', 
    'Authorization', 
    'X-Requested-With',
    'Accept',
    'Origin',
    'Access-Control-Request-Method',
    'Access-Control-Request-Headers'
  ],
  optionsSuccessStatus: 200
};
// Apply CORS middleware
app.use(cors(corsOptions));
app.use(express.json());
// ✅ DATABASE CONFIGURATION FOR RAILWAY
const dbConfig = {
  host: process.env.MYSQLHOST || "localhost",
  user: process.env.MYSQLUSER || "root",
  password: process.env.MYSQLPASSWORD || "Rup@@.123$",
  database: process.env.MYSQLDATABASE || "order_management",
  port: process.env.MYSQLPORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

const db = mysql.createPool(dbConfig);

// Test database connection
db.getConnection((err, connection) => {
  if (err) {
    console.error("❌ Database connection failed:", err);
  } else {
    console.log("✅ Connected to MySQL Database");
    connection.release();
  }
});

// admin.initializeApp({
//   credential: admin.credential.cert(serviceAccount),
// });

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

// ✅ HEALTH CHECK ENDPOINT (IMPORTANT FOR RAILWAY)
app.get("/api/health", (req, res) => {
  res.status(200).json({
    status: 'OK',
    message: 'Backend is running successfully',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    cors: {
      allowedOrigins: corsOptions.origin.toString()
    }
  });
});

// ✅ DATABASE HEALTH CHECK
app.get("/api/health/db", (req, res) => {
  db.query('SELECT 1 as test', (err, results) => {
    if (err) {
      console.error('Database health check failed:', err);
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

app.get("/me-admin", verifyToken, async (req, res) => {
  
      db.query(
      "SELECT role FROM admins WHERE firebase_uid = ?",
      [req.uid],
      (err, rows) => {
        if (err) return res.status(500).json({errror: err.message})
        res.json(rows);
        
      },);
});

// Admin login (checks only admins table)
app.post("/login-admin", verifyToken, async (req, res) => {
  const firebaseUid = req.uid;

  try {
    db.query(
      "SELECT id, username, mobile_number, email, role, firebase_uid FROM admins WHERE firebase_uid = ?",
      [firebaseUid],
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
            error: "Admin not found. Please sign up first." 
          });
        }

        const admin = rows[0];
        res.json({
          success: true,
          message: "Admin login successful",
          user: admin,
          userType: 'admin'
        });
      }
    );
  } catch (error) {
    console.error("Admin login error:", error);
    res.status(500).json({ 
      success: false,
      error: "Internal server error" 
    });
  }
});

// Get specific admin by id
app.get("/admins/:id", (req, res) => {
  const userId = req.params.id;

  if (!userId) {
    return res.status(400).json({ error: "Admin ID is required" });
  }

  const sql = "SELECT * FROM admins WHERE id = ?";

  db.query(sql, [userId], (err, results) => {
    if (err) {
      console.error("Database query error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }

    if (results.length === 0) {
      return res.status(400).json({ error: "Admin not found" });
    }

    res.json(results[0]);
  })
});

// ✅ USE PORT FROM ENVIRONMENT VARIABLE (RAILWAY PROVIDES THIS)
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/api/health`);
});