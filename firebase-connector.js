import express from "express";
import mysql from "mysql2";
import cors from "cors";
import admin from 'firebase-admin';
import serviceAccount from "./config/serviceAccountKey.json" with { type: "json" }; 

const app = express(); 
// app.use(cors());

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
      // Add more origins as needed
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

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// const db = mysql.createConnection({
//   host: "localhost",
//   user: "root",
//   password: "Rup@@.123$",
//   database: "order_management",
// });

// db.connect((err) => {
//   if (err) {
//     console.error("❌ Database connection failed:", err);
//   } else {
//     console.log("✅ Connected to MySQL Database");
//   }
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

app.get("/me-distributor", verifyToken, async (req, res) => {
  db.query(
    "SELECT username, role FROM distributors WHERE firebase_uid = ?",
    [req.uid],
    (err, rows) => {
      if (err) return res.status(500).json({errror: err.message})
      res.json(rows);
    },);
});

app.get("/me-corporate", verifyToken, async (req, res) => {
  db.query(
    "SELECT username, role FROM corporates WHERE firebase_uid = ?",
    [req.uid],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message })
        res.json(rows);
    },);
});

// Admin signup (only for admins table)
app.post("/signup-admin", verifyToken, async (req, res) => {
  const { username, email, mobile_number } = req.body;
  const firebaseUid = req.uid; // Get UID from verified token

  console.log("Admin signup request:", { username, email, firebaseUid });

  if (!username || !email) {
    return res.status(400).json({ 
      success: false,
      error: "Username and email are required" 
    });
  }

  // Validate email
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ 
      success: false,
      error: "Invalid email format" 
    });
  }

  try {
    const checkSql = "SELECT * FROM admins WHERE firebase_uid = ? OR email = ?";
    db.query(checkSql, [firebaseUid, email], (err, rows) => {
      if (err) {
        console.error("Database check error:", err);
        return res.status(500).json({ success: false, error: "Database error" });
      }

      if (rows.length > 0) {
        const existingAdmin = rows[0];
        return res.status(200).json({ 
          success: true,
          message: "Admin already exists", 
          role: existingAdmin.role,
          userType: "admin"
        });
      }

      const insertSql = `
        INSERT INTO admins (username, email, firebase_uid, role, mobile_number)
        VALUES (?, ?, ?, ?, ?)
      `;
      const role = "admin";

      db.query(insertSql, [username, email, firebaseUid, role, mobile_number || null], (err, result) => {
        if (err) {
          console.error("Database insert error:", err);
          return res.status(500).json({ 
            success: false,
            error: "Failed to create admin account" 
          });
        }

        console.log("New admin added to MySQL, ID:", result.insertId);
        res.status(201).json({ 
          success: true,
          message: "Admin signup successful", 
          role,
          userType: "admin",
          userId: result.insertId
        });
      });
    });
  } catch (error) {
    console.error("Signup error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// User signup (only for distributors table)
app.post("/signup-distributor", verifyToken, async (req, res) => {
  const { username, email, mobile_number } = req.body;
  const firebaseUid = req.uid; // Get UID from verified token

  console.log("Distributor signup request:", { username, email, firebaseUid });

  if (!username || !email) {
    return res.status(400).json({ 
      success: false,
      error: "Username and email are required" 
    });
  }

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ 
      success: false,
      error: "Invalid email format" 
    });
  }

  try {
    // Check if user already exists in users table
    const checkSql = "SELECT * FROM distributors WHERE firebase_uid = ? OR email = ?";
    db.query(checkSql, [firebaseUid, email], async (err, rows) => {
      if (err) {
        console.error("Database check error:", err);
        return res.status(500).json({ 
          success: false,
          error: "Database error" 
        });
      }

      if (rows.length > 0) {
        const existingDistributor = rows[0];
        return res.status(200).json({ 
          success: true,
          message: "Distributor already exists", 
          role: existingDistributor.role,
          userType: 'distributor'
        });
      }

      // Insert new distributor into distributors table
      const insertSql = `
        INSERT INTO distributors (username, email, firebase_uid, role, mobile_number)
        VALUES (?, ?, ?, ?, ?)
      `;
      const role = "distributor";

      db.query(insertSql, [username, email, firebaseUid, role, mobile_number], (err, result) => {
        if (err) {
          console.error("Database insert error:", err);
          return res.status(500).json({ 
            success: false,
            error: "Failed to create distributor account" 
          });
        }
        
        console.log("New distributor added to MySQL, ID:", result.insertId);
        res.status(201).json({ 
          success: true,
          message: "Distributor signup successful", 
          role: role,
          userType: 'distributor',
          userId: result.insertId
        });
      });
    });
  } catch (error) {
    console.error("Signup error:", error);
    res.status(500).json({ 
      success: false,
      error: "Internal server error" 
    });
  }
});

// Corporate signup
  app.post("/signup-corporate", verifyToken, async (req, res) => {
    const { username, email, mobile_number } = req.body;
    const firebaseUid = req.uid;  // Get id from verified token

    console.log("Corporate signup request:", { username, email, firebaseUid });

    if (!username || !email) {
      return res.status(400).json({
        success: false,
        error: "Username and email are required"
      });
    }

    // validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        error: "Invalid email format"
      });
    }

    try {
      // check if user already exists in corporates table
      const checkSql = "SELECT * FROM corporates WHERE firebase_uid = ? OR email = ?";
      db.query(checkSql, [firebaseUid, email], async (err, rows) => {
        if (err) {
          console.error("Database check error:", err);
          return res.status(500).json({
            success: false,
            error: "Database error"
          });
        }

        if (rows.length > 0) {
          const existingCorporate = rows[0];
          return res.status(200).json({
            success: true,
            message: "Corporate already exists",
            role: existingCorporate.role,
            userType: 'corporate'
          });
        }

        // Insert new corporate into corporates table
        const insertSql = `
          INSERT INTO corporates (username, email, firebase_uid, role, mobile_number)
          VALUES (?, ?, ?, ?, ?)
        `;
        const role = "corporate";

        db.query(insertSql, [username, email, firebaseUid, role, mobile_number], (err, result) => {
          if (err) {
            console.error("Database insert error:", err);
            return res.status(500).json({
              success: false,
              error: "Failed to create corporate account"
            });
          }

          console.log("New Corporate added to MySQL, ID:", result.insertId);
          res.status(201).json({
            success: true,
            message: "Corporate signup successful",
            role: role,
            userType: 'corporate',
            userId: result.insertId,
          })
        })
      });
    } catch (error) {
      console.error("Signup Error:", error);
      res.status(500).json({
        success: false,
        error: "Internal server error"
      })
    }
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

// Distributor login (checks only distributors table)
app.post("/login-distributor", verifyToken, async (req, res) => {
  const firebaseUid = req.uid;

  try {
    db.query(
      "SELECT id, username, mobile_number, email, role, firebase_uid FROM distributors WHERE firebase_uid = ?",
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
            error: "Distributor not found. Please sign up first." 
          });
        }

        const user = rows[0];
        res.json({
          success: true,
          message: "Distributor login successful",
          user: user,
          userType: 'distributor'
        });
      }
    );
  } catch (error) {
    console.error("Distributor login error:", error);
    res.status(500).json({ 
      success: false,
      error: "Internal server error" 
    });
  }
});

// Corporate Login (checks only corporates table)
app.post("/login-corporate", verifyToken, async (req, res) => {
  const firebaseUid = req.uid;

  try {
    db.query(
      "SELECT id, username, mobile_number, email, role, firebase_uid FROM  corporates WHERE firebase_uid = ?",
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
            error: "Corporate not found. Please signup first."
          })
        }

        const user = rows[0];
        res.json({
          success: true,
          message: "Corporate login successful",
          user: user,
          userType: 'corporate'
        });
      }
    )
  } catch (error) {
    console.error("Corporate login error:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error"
    })
  }
});

// Get specific executive by id
app.get("/distributors/:id", (req, res) => {
  const userId = req.params.id;

  // check if ID is valid
  if (!userId) {
    return res.status(400).json({ error: "Distributor ID is required" });
  }

  // Use parameterized query to prevent SQL injection
  const sql = "SELECT * FROM distributors WHERE id = ?";

  db.query(sql, [userId], (err, results) => {
    if (err) {
      console.error("Database query error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }

    if (results.length === 0) {
      return res.status(400).json({ error: "Distributor not found" });
    }

    // Return the single item object
    res.json(results[0]);
  })
});

// Get specific corporate by id
app.get("/corporates/:id", (req, res) => {
  const userId = req.params.id;

  // check if ID is valid
  if (!userId) {
    return res.status(400).json({ error: "Corporate ID is required!"});
  }

  // use parameterized query to prevent SQL injection
  const sql = "SELECT * FROM corporates WHERE id = ?";

  db.query(sql, [userId], (err, results) => {
    if (err) {
      console.error("Database query error:", err);
      return res.status(500).json({
        error: "Internal server error"
      });
    }

    if (results.length === 0) {
      return res.status(400).json({
        error: "Corporate not found"
      });
    }
    // return the single item object
    res.json(results[0]);
  })
});

app.get("/stock_item", (req, res) => {
  db.query("SELECT * FROM stock_item", (err, results) => {
    if (err) return res.status(500).json({ error: err });
    res.json(results);
  });
});

app.get("/customer", (req, res) => {
  db.query("SELECT * FROM customer", (err, results) => {
    if (err) return res.status(500).json({ error: err });
    res.json(results);
  })
});

app.get("/admins", (req, res) => {
  db.query("SELECT * FROM admins", (err, results) => {
    if (err) return res.status(500).json({ error: err });
    res.json(results);
  });
});

app.get("/distributors", (req, res) => {
  db.query("SELECT * FROM distributors", (err, results) => {
    if (err) return res.status(500).json({ error: err });
    res.json(results);
  })
});

app.get("/corporates", (req, res) => {
  db.query("SELECT * FROM corporates", (err, results) => {
    if (err) return res.status(500).json({ error: err });
    res.json(results);
  })
});

app.get("/orders", (req, res) => {
  db.query("SELECT * FROM orders", (err, results) => {
    if (err) return res.status(500).json({ error: err });
    res.json(results);
  })
});

// Get specific stock item by item code
app.get("/stock_item/:item_code", (req, res) => {
  const { item_code } = req.params;

  if (!item_code) {
    return res.status(400).json({ error: "Stock Item Code is required" });
  }

  const sql = "SELECT * FROM stock_item WHERE item_code = ?";

  db.query(sql, [item_code], (err, results) => {
    if (err) {
      console.error("Database query error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }

    if (results.length === 0) {
      return res.status(404).json({ error: "Stock item not found" });
    }

    res.json(results[0]);
  })
});

// Get specific customer by customer_code only
app.get("/customer/:customer_code", (req, res) => {
  const { customer_code } = req.params;

  if (!customer_code) {
    return res.status(400).json({ error: "Customer code is required" });
  }

  const sql = "SELECT * FROM customer WHERE customer_code = ?";

  db.query(sql, [customer_code], (err, results) => {
    if (err) {
      console.error("Database query error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }

    if (results.length === 0) {
      return res.status(404).json({ error: "Customer not found" });
    }

    res.json(results[0]);
  });
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

// get specific order by id
app.get("/orders/:id", (req, res) => {
  const orderId = req.params.id;

  if (!orderId) {
    return res.status(400).json({ error: "Order ID is required" });
  }

  const sql = "SELECT * FROM orders WHERE id = ?";

  db.query(sql, [orderId], (err, results) => {
    if (err) {
      console.error("Database query error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }

    if (results.length === 0) {
      return res.status(404).json({ error: "Order not found" });
    }

    res.json(results[0]);
  });
});

// get all orders by order number (optionally filter by created_at)
app.get("/orders-by-number/:order_no", (req, res) => {
  const { order_no } = req.params;
  const { created_at } = req.query; // optional filter

  if (!order_no) {
    return res.status(400).json({ error: "Order Number is required" });
  }

  // Base query
  let sql = "SELECT * FROM orders WHERE order_no = ?";
  const params = [order_no];

  // Optional created_at filter
  if (created_at) {
    sql += " AND created_at = ?";
    params.push(created_at);
  }

  db.query(sql, params, (err, results) => {
    if (err) {
      console.error("Database query error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }

    if (results.length === 0) {
      return res.status(404).json({ error: "No orders found" });
    }

    // ✅ Return all matching rows, not just the first one
    res.json(results);
  });
});

app.post('/orders', (req, res) => {
  const data = req.body;

  if (!Array.isArray(data) || data.length === 0) {
    return res.status(400).json({ error: "No orders provided" });
  }

  const sql = `
    INSERT INTO orders 
    (voucher_type, order_no, order_date, status, customer_code, executive, role, customer_name, item_code, item_name, hsn, gst, quantity, uom, rate, amount, net_rate, gross_amount, disc_percentage, disc_amount, spl_disc_percentage, spl_disc_amount, total_quantity, total_amount, remarks) 
    VALUES ?
  `;

  const values = data.map(item => [
    item.voucher_type,
    item.order_no,
    item.date,
    item.status,
    item.customer_code,
    item.executive,
    item.role,
    item.customer_name,
    item.item_code,
    item.item_name,
    item.hsn,
    String(item.gst).replace(/\s*%/, ''),
    item.quantity,
    item.uom,
    item.rate,
    item.amount,
    item.net_rate,
    item.gross_amount,
    item.disc_percentage,
    item.disc_amount,
    item.spl_disc_percentage,
    item.spl_disc_amount,
    item.total_quantity ?? 0.00,
    item.total_amount ?? 0.00,
    item.remarks ?? '',
  ]);

  db.query(sql, [values], (err, result) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: err.message });
    }
    res.json({ message: "Orders inserted successfully", result });
  });
});

// ✅ Update specific fields of orders by order number (but match by ID)
app.put("/orders-by-number/:order_no", async (req, res) => {
  const { order_no } = req.params;
  const updates = req.body;

  // 🔹 Basic validation
  if (!order_no || order_no.trim() === "") {
    return res.status(400).json({ error: "Order Number is required" });
  }

  if (!Array.isArray(updates) || updates.length === 0) {
    return res.status(400).json({ error: "No update data provided" });
  }

  // 🔹 Validate each update object
  const validationErrors = [];
  updates.forEach((update, index) => {
    if (!update || typeof update !== "object") {
      validationErrors.push(`Update ${index}: Invalid update object`);
      return;
    }

    if (!update.id || isNaN(update.id)) {
      validationErrors.push(`Update ${index}: Valid numeric Order ID is required`);
    }

    const numericFields = [
      "disc_percentage",
      "disc_amount",
      "spl_disc_percentage",
      "spl_disc_amount",
      "net_rate",
      "gross_amount",
      "total_quantity",
      "total_amount",
      "quantity"
    ];

    numericFields.forEach((field) => {
      if (update[field] !== undefined && isNaN(update[field])) {
        validationErrors.push(`Update ${index}: ${field} must be a number`);
      }
    });
  });

  if (validationErrors.length > 0) {
    return res.status(400).json({
      error: "Validation failed",
      details: validationErrors,
    });
  }

  // ✅ Proceed with transaction safely using async/await
  try {
    await new Promise((resolve, reject) => {
      db.beginTransaction((err) => (err ? reject(err) : resolve()));
    });

    const allowedFields = [
      "status",
      "disc_percentage",
      "disc_amount",
      "spl_disc_percentage",
      "spl_disc_amount",
      "net_rate",
      "gross_amount",
      "total_quantity",
      "total_amount",
      "remarks",
      "quantity"
    ];

    for (const [index, update] of updates.entries()) {
      const { id, ...fields } = update;

      // Filter only allowed fields
      const filteredFields = {};
      for (const key of Object.keys(fields)) {
        if (allowedFields.includes(key)) {
          filteredFields[key] = fields[key];
        }
      }

      if (Object.keys(filteredFields).length === 0) {
        console.warn(`Skipping update ${index}: No valid fields`);
        continue;
      }

      // Build SQL dynamically but safely
      const setClause = Object.keys(filteredFields)
        .map((field) => `\`${field}\` = ?`)
        .join(", ");

      const values = Object.values(filteredFields);

      // ✅ Update only by ID (order_no not used in WHERE)
      const sql = `UPDATE orders SET ${setClause} WHERE id = ?`;
      const params = [...values, id];

      console.log(`Executing update ${index}:`, sql, params);

      await new Promise((resolve, reject) => {
        db.query(sql, params, (err, result) => {
          if (err) {
            console.error(`Database error in update ${index}:`, err);
            return reject(err);
          }
          if (result.affectedRows === 0) {
            return reject(new Error(`No record found for id ${id}`));
          }
          resolve();
        });
      });
    }

    // ✅ Commit transaction
    await new Promise((resolve, reject) => {
      db.commit((err) => (err ? reject(err) : resolve()));
    });

    res.json({
      message: "Orders updated successfully",
      updatedCount: updates.length,
    });
  } catch (err) {
    console.error("Transaction failed:", err.message);
    await new Promise((resolve) => db.rollback(() => resolve()));
    res.status(400).json({
      error: "Update failed",
      details: err.message,
    });
  }
});

// app.listen(5000, () => {
//   console.log("Backend running on http://localhost:5000");
// });


// ✅ USE PORT FROM ENVIRONMENT VARIABLE (RAILWAY PROVIDES THIS)
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/api/health`);
});