import express from "express";
import mysql from "mysql2/promise"; // Using promise-based MySQL
import cors from "cors";
import admin from 'firebase-admin';
import dotenv from 'dotenv';
import axios from "axios";
import { parseStringPromise } from 'xml2js';

// Initialize Express
const app = express();
dotenv.config();

// ✅ Root route for Vercel
app.get('/', (req, res) => {
  res.json({
    message: 'Castolin Backend API with Tally Integration',
    status: 'running',
    endpoints: [
      '/api/health',
      '/api/health/db',
      '/me-admin',
      '/login-admin',
      '/api/tally/sync/customers',
      '/api/tally/sync/items'
    ],
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString()
  });
});

// ==================== FIREBASE INITIALIZATION ====================
const firebaseBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;

if (firebaseBase64) {
  try {
    const serviceAccount = JSON.parse(Buffer.from(firebaseBase64, "base64").toString('utf8'));
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
    }
    console.log("✅ Firebase admin initialized successfully!!");
  } catch (error) {
    console.error("❌ Failed to decode firebase base64 key:", error);
  }
}

// ==================== CORS CONFIGURATION ====================
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

// ==================== DATABASE CONFIGURATION ====================
const dbConfig = {
  host: process.env.MYSQLHOST || "ballast.proxy.rlwy.net",
  user: process.env.MYSQLUSER || "root",
  password: process.env.MYSQLPASSWORD || "cAAiaBeGHjxZVSBFbedADrenyDVkESSu",
  database: process.env.MYSQLDATABASE || "railway",
  port: process.env.MYSQLPORT || 45718,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

// Create connection pool
const db = mysql.createPool(dbConfig);

// Test database connection
(async () => {
  try {
    const connection = await db.getConnection();
    console.log("✅ Connected to MySQL Database");
    connection.release();
  } catch (err) {
    console.error("❌ Database connection failed:", err.message);
  }
})();

// ==================== TALLY CONFIGURATION ====================
const TALLY_CONFIG = {
  URL: process.env.TALLY_URL || 'http://localhost:9000',
  COMPANY_NAME: process.env.TALLY_COMPANY_NAME || 'CASTOLIN EUTECTIC INDIA',
  TIMEOUT: 30000
};

// ==================== FIREBASE MIDDLEWARE ====================
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

const verifyAdmin = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) {
      return res.status(401).json({ error: "No token provided" });
    }
    
    const decoded = await admin.auth().verifyIdToken(token);
    const [rows] = await db.execute(
      "SELECT role FROM admins WHERE firebase_uid = ?",
      [decoded.uid]
    );
    
    if (rows.length === 0 || rows[0].role !== 'admin') {
      return res.status(403).json({ error: "Admin access required" });
    }
    
    req.user = decoded;
    req.adminId = rows[0].id;
    next();
  } catch (err) {
    console.error("Admin verification error:", err);
    res.status(401).json({ error: "Unauthorized" });
  }
};

// ==================== HELPER FUNCTIONS ====================
function extractMobileNumber(mobileRaw) {
  if (!mobileRaw || mobileRaw === '-' || mobileRaw === 'NA' || mobileRaw === 'N/A') {
    return null;
  }
  
  const digitsOnly = mobileRaw.replace(/\D/g, '');
  let extracted = '';
  
  if (digitsOnly.length === 10) {
    extracted = digitsOnly;
  } else if (digitsOnly.length === 11 && digitsOnly.startsWith('0')) {
    extracted = digitsOnly.slice(1);
  } else if (digitsOnly.length === 12 && digitsOnly.startsWith('91')) {
    extracted = digitsOnly.slice(2);
  } else if (digitsOnly.length > 10) {
    extracted = digitsOnly.slice(-10);
  }
  
  if (extracted && extracted.length === 10 && /^\d+$/.test(extracted)) {
    return extracted;
  }
  
  return null;
}

function shouldSkipLedger(ledgerName) {
  const lowerName = ledgerName.toLowerCase();
  const skipPatterns = [
    'cash', 'bank', 'profit', 'loss', 'suspense', 'fixed asset',
    'loan', 'capital', 'reserve', 'depreciation', 'purchase',
    'sale', 'income', 'expense', 'duty', 'tax', 'gst',
    'discount', 'commission', 'interest', 'salary', 'wages',
    'opening balance', 'closing stock', 'stock', 'vat',
    'cgst', 'sgst', 'igst', 'rounding', 'miscellaneous'
  ];
  
  return skipPatterns.some(pattern => lowerName.includes(pattern));
}

// ==================== TALLY XML REQUESTS ====================
const getCustomerXmlRequest = () => {
  return `<?xml version="1.0"?>
<ENVELOPE>
<HEADER>
<TALLYREQUEST>Export Data</TALLYREQUEST>
</HEADER>
<BODY>
<EXPORTDATA>
<REQUESTDESC>
<REPORTNAME>List of Accounts</REPORTNAME>
<STATICVARIABLES>
<SVCURRENTCOMPANY>${TALLY_CONFIG.COMPANY_NAME}</SVCURRENTCOMPANY>
</STATICVARIABLES>
</REQUESTDESC>
</EXPORTDATA>
</BODY>
</ENVELOPE>`;
};

const getItemXmlRequest = () => {
  return `<?xml version="1.0"?>
<ENVELOPE>
    <HEADER>
      <TALLYREQUEST>Export Data</TALLYREQUEST>
    </HEADER>
    <BODY>
      <EXPORTDATA>
        <REQUESTDESC>
          <REPORTNAME>List of Accounts</REPORTNAME>
          <STATICVARIABLES>
            <MStockGroup>$$SysName:Allitems</MStockGroup>
            <IsListofAccountsItemWise>Yes</IsListofAccountsItemWise>
            <AccountType>$$SysName:Stockitems</AccountType>
            <IsItemWise>Yes</IsItemWise>
            <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
          </STATICVARIABLES>
        </REQUESTDESC>
      </EXPORTDATA>
    </BODY>
  </ENVELOPE>`;
};

// ==================== TALLY PARSING FUNCTIONS ====================
async function parseTallyCustomers(xmlData) {
  const customers = [];
  if (!xmlData) return customers;

  try {
    const parsed = await parseStringPromise(xmlData, { 
      explicitArray: false, 
      ignoreAttrs: true,
      mergeAttrs: true,
      trim: true
    });

    let ledgers = [];

    if (parsed.ENVELOPE?.BODY?.IMPORTDATA?.REQUESTDATA?.TALLYMESSAGE) {
      const tallyMessages = Array.isArray(parsed.ENVELOPE.BODY.IMPORTDATA.REQUESTDATA.TALLYMESSAGE)
        ? parsed.ENVELOPE.BODY.IMPORTDATA.REQUESTDATA.TALLYMESSAGE
        : [parsed.ENVELOPE.BODY.IMPORTDATA.REQUESTDATA.TALLYMESSAGE];

      for (const message of tallyMessages) {
        if (message.LEDGER) {
          if (Array.isArray(message.LEDGER)) {
            ledgers = ledgers.concat(message.LEDGER);
          } else {
            ledgers.push(message.LEDGER);
          }
        }
      }
    }

    for (const ledger of ledgers) {
      try {
        let customerName = '';
        let customerCode = '';

        if (Array.isArray(ledger.NAME)) {
          customerName = String(ledger.NAME[0]).trim();
          if (ledger.NAME.length > 1) {
            customerCode = String(ledger.NAME[1]).trim();
          }
        } else if (typeof ledger.NAME === 'string') {
          customerName = String(ledger.NAME).trim();
        }

        if (!customerName || shouldSkipLedger(customerName)) {
          continue;
        }

        const parent = ledger.PARENT || '';
        const isSundryDebtor = parent.toLowerCase() === 'sundry debtors';

        if (!isSundryDebtor) {
          continue;
        }

        let mobileNumber = null;
        if (ledger.LEDGERMOBILE) {
          const mobileRaw = typeof ledger.LEDGERMOBILE === 'object' && ledger.LEDGERMOBILE._
            ? String(ledger.LEDGERMOBILE._).trim()
            : String(ledger.LEDGERMOBILE).trim();
          mobileNumber = extractMobileNumber(mobileRaw);
        }

        let state = 'not_applicable';
        if (ledger.STATE) {
          const stateRaw = typeof ledger.STATE === 'object' && ledger.STATE._
            ? String(ledger.STATE._).trim()
            : String(ledger.STATE).trim();
          if (stateRaw && stateRaw !== '-' && stateRaw.toLowerCase() !== 'na') {
            state = stateRaw;
          }
        }

        let email = null;
        if (ledger.EMAIL) {
          const emailRaw = typeof ledger.EMAIL === 'object' && ledger.EMAIL._
            ? String(ledger.EMAIL._).trim()
            : String(ledger.EMAIL).trim();
          if (emailRaw && emailRaw !== '-') {
            email = emailRaw;
          }
        }

        let customerType = 'direct';
        if (ledger.UDF_PRODUCTCATEGORY_LIST?.UDF_PRODUCTCATEGORY) {
          const extractedType = Array.isArray(ledger.UDF_PRODUCTCATEGORY_LIST.UDF_PRODUCTCATEGORY)
            ? String(ledger.UDF_PRODUCTCATEGORY_LIST.UDF_PRODUCTCATEGORY[0]).trim()
            : String(ledger.UDF_PRODUCTCATEGORY_LIST.UDF_PRODUCTCATEGORY).trim();
          customerType = extractedType.toLowerCase().trim();
        }

        const customer = {
          customer_code: customerCode || null,
          customer_name: customerName,
          email: email,
          mobile_number: mobileNumber,
          state: state,
          customer_type: customerType,
          role: customerType,
          parent_group: parent
        };

        customers.push(customer);
      } catch (innerErr) {
        console.warn('⚠️ Error processing ledger:', innerErr.message);
      }
    }
  } catch (err) {
    console.error('❌ XML parsing error:', err.message);
  }

  return customers;
}

async function parseTallyItems(xmlData) {
  const items = [];
  if (!xmlData) return items;

  try {
    const parsed = await parseStringPromise(xmlData, {
      explicitArray: false,
      ignoreAttrs: true,
      mergeAttrs: true,
      trim: true,
    });

    let stockItems = [];

    if (parsed.ENVELOPE?.BODY?.IMPORTDATA?.REQUESTDATA?.TALLYMESSAGE) {
      const tallyMessages = Array.isArray(parsed.ENVELOPE.BODY.IMPORTDATA.REQUESTDATA.TALLYMESSAGE)
        ? parsed.ENVELOPE.BODY.IMPORTDATA.REQUESTDATA.TALLYMESSAGE
        : [parsed.ENVELOPE.BODY.IMPORTDATA.REQUESTDATA.TALLYMESSAGE];

      for (const message of tallyMessages) {
        if (message.STOCKITEM) {
          if (Array.isArray(message.STOCKITEM)) {
            stockItems = stockItems.concat(message.STOCKITEM);
          } else {
            stockItems.push(message.STOCKITEM);
          }
        }
      }
    }

    for (const item of stockItems) {
      try {
        const itemName = typeof item.NAME === 'string' ? item.NAME.trim() : null;
        if (!itemName) continue;

        const parent = item.PARENT ? item.PARENT.trim() : null;
        const baseUnit = item.BASEUNITS ? item.BASEUNITS.trim() : null;
        const gstRate = item.RATEOFVAT ? item.RATEOFVAT.trim() : null;
        
        let openingRate = null;
        if (item.OPENINGRATE) {
          const rateMatch = item.OPENINGRATE.match(/^([\d.]+)/);
          if (rateMatch) {
            openingRate = parseFloat(rateMatch[1]);
          }
        }

        let itemCode = null;
        if (item.MAILINGNAME_LIST?.MAILINGNAME) {
          itemCode = Array.isArray(item.MAILINGNAME_LIST.MAILINGNAME)
            ? item.MAILINGNAME_LIST.MAILINGNAME[0]?.trim()
            : item.MAILINGNAME_LIST.MAILINGNAME.trim();
        } else if (item.MAILINGNAME) {
          itemCode = Array.isArray(item.MAILINGNAME)
            ? item.MAILINGNAME[0]?.trim()
            : item.MAILINGNAME.trim();
        }

        const stockItem = {
          stock_item_name: itemName,
          item_code: itemCode || null,
          parent_group: parent || 'General',
          uom: baseUnit || null,
          gst: gstRate || null,
          rate: openingRate,
        };

        items.push(stockItem);
      } catch (err) {
        console.warn('⚠️ Error processing stock item:', err.message);
      }
    }
  } catch (err) {
    console.error('❌ XML parsing error (items):', err.message);
  }

  return items;
}

// ==================== DATABASE SAVE FUNCTIONS ====================
async function saveCustomersToMySQL(customers) {
  if (customers.length === 0) {
    console.log('ℹ️ No customers to save');
    return { saved: 0, duplicates: 0, errors: 0 };
  }

  const validCustomers = customers.filter(customer => customer.customer_code && customer.customer_code.trim() !== '');
  
  if (validCustomers.length === 0) {
    console.log('ℹ️ No valid customers to save');
    return { saved: 0, duplicates: 0, errors: 0 };
  }
  
  let savedCount = 0;
  let duplicateCount = 0;
  let errorCount = 0;
  
  for (const customer of validCustomers) {
    try {
      const insertSql = `
        INSERT IGNORE INTO customer 
        (customer_code, customer_name, mobile_number, state, email, 
         password, customer_type, role, status, parent_group, firebase_uid)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;
      
      const [result] = await db.execute(insertSql, [
        customer.customer_code,
        customer.customer_name,
        customer.mobile_number,
        customer.state || 'not_applicable',
        customer.email,
        null,
        customer.customer_type,
        customer.role,
        'inactive',
        customer.parent_group || 'Sundry Debtors',
        null
      ]);
      
      if (result.affectedRows > 0) {
        savedCount++;
      } else {
        duplicateCount++;
      }
    } catch (error) {
      console.error(`❌ Error inserting customer ${customer.customer_name}:`, error.message);
      errorCount++;
    }
  }
  
  console.log(`✅ MySQL: ${savedCount} new customers added, ${duplicateCount} duplicates skipped, ${errorCount} errors`);
  return { saved: savedCount, duplicates: duplicateCount, errors: errorCount };
}

async function saveItemsToMySQL(items) {
  if (items.length === 0) {
    console.log('ℹ️ No stock items to save');
    return { saved: 0, duplicates: 0, errors: 0 };
  }

  const validItems = items.filter(item => item.item_code && item.item_code.trim() !== '');
  
  if (validItems.length === 0) {
    console.log('ℹ️ No valid items to save');
    return { saved: 0, duplicates: 0, errors: 0 };
  }

  let savedCount = 0;
  let duplicateCount = 0;
  let errorCount = 0;

  for (const item of validItems) {
    try {
      const insertSql = `
        INSERT IGNORE INTO stock_item 
        (item_code, stock_item_name, parent_group, uom, gst, hsn, rate)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `;

      const [result] = await db.execute(insertSql, [
        item.item_code,
        item.stock_item_name,
        item.parent_group,
        item.uom,
        item.gst,
        null, // hsn - you can add extraction logic for this
        item.rate,
      ]);

      if (result.affectedRows > 0) {
        savedCount++;
      } else {
        duplicateCount++;
      }
    } catch (error) {
      console.error(`❌ Error inserting item ${item.stock_item_name}:`, error.message);
      errorCount++;
    }
  }

  console.log(`✅ MySQL: ${savedCount} new items added, ${duplicateCount} duplicates skipped, ${errorCount} errors`);
  return { saved: savedCount, duplicates: duplicateCount, errors: errorCount };
}

// ==================== API ROUTES ====================

// Health endpoints
app.get("/api/health", (req, res) => {
  res.status(200).json({
    status: 'OK',
    message: 'Backend is running successfully',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

app.get("/api/health/db", async (req, res) => {
  try {
    const [results] = await db.query('SELECT 1 as test');
    res.json({
      status: 'OK',
      database: 'Connected successfully',
      test: results[0].test
    });
  } catch (err) {
    res.status(500).json({
      status: 'ERROR',
      database: 'Connection failed',
      error: err.message
    });
  }
});

// Get all customers
app.get("/customers", verifyToken, async (req, res) => {
  try {
    const [results] = await db.query("SELECT * FROM customer");
    res.json({
      success: true,
      count: results.length,
      customers: results
    });
  } catch (err) {
    console.error("Database error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Admin routes
app.get("/me-admin", verifyToken, async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT role FROM admins WHERE firebase_uid = ?",
      [req.uid]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/login-admin", verifyToken, async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT id, username, mobile_number, email, role, firebase_uid FROM admins WHERE firebase_uid = ?",
      [req.uid]
    );
    
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
  } catch (err) {
    res.status(500).json({ 
      success: false,
      error: "Database error" 
    });
  }
});

app.get("/admins/:id", verifyToken, async (req, res) => {
  try {
    const [results] = await db.query("SELECT * FROM admins WHERE id = ?", [req.params.id]);
    if (results.length === 0) {
      return res.status(404).json({ error: "Admin not found" });
    }
    res.json(results[0]);
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// ==================== TALLY SYNC ROUTES ====================

// Sync customers from Tally
app.post("/api/tally/sync/customers", verifyAdmin, async (req, res) => {
  try {
    console.log('📥 Pulling customers from Tally...');
    
    const xmlRequest = getCustomerXmlRequest();
    const response = await axios.post(TALLY_CONFIG.URL, xmlRequest, {
      headers: { 'Content-Type': 'application/xml' },
      timeout: TALLY_CONFIG.TIMEOUT
    });
    
    if (!response.data) {
      return res.status(500).json({ 
        success: false, 
        error: 'Empty response from Tally' 
      });
    }
    
    const customers = await parseTallyCustomers(response.data);
    const saveResult = await saveCustomersToMySQL(customers);
    
    res.json({
      success: true,
      message: 'Customers synced successfully',
      tallyResponse: {
        customersFound: customers.length,
        customersSaved: saveResult.saved,
        duplicatesSkipped: saveResult.duplicates,
        errors: saveResult.errors
      }
    });
    
  } catch (err) {
    console.error('❌ Tally sync error:', err.message);
    
    let errorMessage = 'Tally sync failed';
    let statusCode = 500;
    
    if (err.code === 'ECONNREFUSED') {
      errorMessage = 'Cannot connect to Tally. Make sure Tally is running and ODBC server is enabled on port 9000.';
      statusCode = 503;
    } else if (err.response) {
      errorMessage = `Tally responded with error: ${err.response.status}`;
      statusCode = err.response.status;
    }
    
    res.status(statusCode).json({ 
      success: false, 
      error: errorMessage,
      details: err.message 
    });
  }
});

// Sync items from Tally
app.post("/api/tally/sync/items", verifyAdmin, async (req, res) => {
  try {
    console.log('📥 Pulling stock items from Tally...');
    
    const xmlRequest = getItemXmlRequest();
    const response = await axios.post(TALLY_CONFIG.URL, xmlRequest, {
      headers: { 'Content-Type': 'application/xml' },
      timeout: TALLY_CONFIG.TIMEOUT
    });
    
    if (!response.data) {
      return res.status(500).json({ 
        success: false, 
        error: 'Empty response from Tally' 
      });
    }
    
    const items = await parseTallyItems(response.data);
    const saveResult = await saveItemsToMySQL(items);
    
    res.json({
      success: true,
      message: 'Stock items synced successfully',
      tallyResponse: {
        itemsFound: items.length,
        itemsSaved: saveResult.saved,
        duplicatesSkipped: saveResult.duplicates,
        errors: saveResult.errors
      }
    });
    
  } catch (err) {
    console.error('❌ Tally items sync error:', err.message);
    
    let errorMessage = 'Tally items sync failed';
    let statusCode = 500;
    
    if (err.code === 'ECONNREFUSED') {
      errorMessage = 'Cannot connect to Tally. Make sure Tally is running and ODBC server is enabled on port 9000.';
      statusCode = 503;
    }
    
    res.status(statusCode).json({ 
      success: false, 
      error: errorMessage,
      details: err.message 
    });
  }
});

// Manual sync both customers and items
app.post("/api/tally/sync/all", verifyAdmin, async (req, res) => {
  try {
    console.log('🔄 Starting full sync from Tally...');
    
    // Sync customers
    const customerXml = getCustomerXmlRequest();
    const customerResponse = await axios.post(TALLY_CONFIG.URL, customerXml, {
      headers: { 'Content-Type': 'application/xml' },
      timeout: TALLY_CONFIG.TIMEOUT
    });
    
    const customers = await parseTallyCustomers(customerResponse.data);
    const customerSaveResult = await saveCustomersToMySQL(customers);
    
    // Sync items
    const itemXml = getItemXmlRequest();
    const itemResponse = await axios.post(TALLY_CONFIG.URL, itemXml, {
      headers: { 'Content-Type': 'application/xml' },
      timeout: TALLY_CONFIG.TIMEOUT
    });
    
    const items = await parseTallyItems(itemResponse.data);
    const itemSaveResult = await saveItemsToMySQL(items);
    
    res.json({
      success: true,
      message: 'Full sync completed successfully',
      summary: {
        customers: {
          found: customers.length,
          saved: customerSaveResult.saved,
          duplicates: customerSaveResult.duplicates,
          errors: customerSaveResult.errors
        },
        items: {
          found: items.length,
          saved: itemSaveResult.saved,
          duplicates: itemSaveResult.duplicates,
          errors: itemSaveResult.errors
        }
      }
    });
    
  } catch (err) {
    console.error('❌ Full sync error:', err.message);
    res.status(500).json({ 
      success: false, 
      error: 'Full sync failed',
      details: err.message 
    });
  }
});

// Get sync status
app.get("/api/tally/sync/status", verifyToken, async (req, res) => {
  try {
    const [customerCount] = await db.query("SELECT COUNT(*) as count FROM customer");
    const [itemCount] = await db.query("SELECT COUNT(*) as count FROM stock_item");
    
    res.json({
      success: true,
      databaseStats: {
        totalCustomers: customerCount[0].count,
        totalItems: itemCount[0].count,
        lastSyncTime: new Date().toISOString()
      },
      tallyConfig: {
        url: TALLY_CONFIG.URL,
        companyName: TALLY_CONFIG.COMPANY_NAME,
        isConfigured: !!TALLY_CONFIG.URL && !!TALLY_CONFIG.COMPANY_NAME
      }
    });
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get sync status' 
    });
  }
});
// ==================== SERVER STARTUP ====================

// ✅ For Vercel: Only listen locally, export app for serverless
if (process.env.VERCEL !== '1') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📊 Tally URL: ${TALLY_CONFIG.URL}`);
    console.log(`🏢 Tally Company: ${TALLY_CONFIG.COMPANY_NAME}`);
  });
}
// ✅ Export for Vercel serverless function
export default app;