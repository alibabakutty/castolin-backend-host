import express from "express";
import mysql from "mysql2";
import cors from "cors";
import admin from 'firebase-admin';
import dotenv from 'dotenv';
import axios from 'axios';
import { parseStringPromise } from 'xml2js';

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
      '/login-admin',
      '/api/tally/test',
      '/api/tally/sync/customers',
      '/api/tally/sync/items',
      '/api/tally/sync/all'
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
    console.log("✅ Firebase admin initialized successfully!!");
  } catch (error) {
    console.error("❌ Failed to decode firebase base64 key:", error);
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

// Database configuration
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

const db = mysql.createPool(dbConfig);

// Test database connection
db.getConnection((err, connection) => {
  if (err) {
    console.error("❌ Database connection failed:", err.message);
  } else {
    console.log("✅ Connected to MySQL Database");
    connection.release();
  }
});

// Configuration
const TALLY_BRIDGE_URL = process.env.TALLY_BRIDGE_URL || 'https://semicrystalline-kennith-bombastically.ngrok-free.dev';
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || 'f2b400bb8283089bd36f42da88c5074852503bd236158c760b7443a0cf1edc88';
const COMPANY_NAME = 'CASTOLIN EUTECTIC INDIA';

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

// ==================== XML PARSING FUNCTIONS ====================

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

  console.log(`✅ Parsing completed: ${customers.length} Sundry Debtors customers found`);
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

  console.log(`✅ Parsed ${items.length} items`);
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
      
      await new Promise((resolve, reject) => {
        db.query(insertSql, [
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
        ], (err, result) => {
          if (err) {
            console.error(`❌ Error inserting customer ${customer.customer_name}:`, err.message);
            errorCount++;
          } else {
            if (result.affectedRows > 0) {
              console.log(`✅ Added: ${customer.customer_name} (Code: ${customer.customer_code}, Type: ${customer.customer_type})`);
              savedCount++;
            } else {
              duplicateCount++;
            }
          }
          resolve();
        });
      });
    } catch (error) {
      console.error(`❌ Error processing customer ${customer.customer_name}:`, error.message);
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

      await new Promise((resolve) => {
        db.query(
          insertSql,
          [
            item.item_code,
            item.stock_item_name,
            item.parent_group,
            item.uom,
            item.gst,
            null,
            item.rate,
          ],
          (err, result) => {
            if (err) {
              console.error(`❌ Error inserting item ${item.stock_item_name}:`, err.message);
              errorCount++;
            } else {
              if (result.affectedRows > 0) {
                console.log(`✅ Added: ${item.stock_item_name} (Code: ${item.item_code}, Rate: ${item.rate || 'N/A'})`);
                savedCount++;
              } else {
                duplicateCount++;
              }
            }
            resolve();
          }
        );
      });
    } catch (error) {
      console.error(`❌ Error processing item ${item.stock_item_name}:`, error.message);
      errorCount++;
    }
  }

  console.log(`✅ MySQL: ${savedCount} new items added, ${duplicateCount} duplicates skipped, ${errorCount} errors`);
  return { saved: savedCount, duplicates: duplicateCount, errors: errorCount };
}

// ==================== BRIDGE FUNCTIONS ====================

async function fetchFromTallyBridge(endpoint) {
  try {
    console.log(`📡 Connecting to Tally bridge: ${TALLY_BRIDGE_URL}/api/tally/${endpoint}`);
    
    // For ngrok-free.dev, we need to handle it differently
    // Direct XML request to Tally via ngrok
    const xmlRequest = endpoint === 'customers' 
      ? `<?xml version="1.0"?>
<ENVELOPE>
<HEADER>
<TALLYREQUEST>Export Data</TALLYREQUEST>
</HEADER>
<BODY>
<EXPORTDATA>
<REQUESTDESC>
<REPORTNAME>List of Accounts</REPORTNAME>
<STATICVARIABLES>
<SVCURRENTCOMPANY>${COMPANY_NAME}</SVCURRENTCOMPANY>
</STATICVARIABLES>
</REQUESTDESC>
</EXPORTDATA>
</BODY>
</ENVELOPE>`
      : `<?xml version="1.0"?>
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
    
    console.log('Sending XML request to Tally via ngrok...');
    const response = await axios.post(TALLY_BRIDGE_URL, xmlRequest, {
      headers: { 
        'Content-Type': 'application/xml',
        'Accept': 'application/xml'
      },
      timeout: 45000
    });
    
    if (response.status !== 200) {
      throw new Error(`Tally responded with status ${response.status}`);
    }
    
    if (!response.data) {
      throw new Error('Empty response from Tally');
    }
    
    console.log(`✅ Successfully received ${endpoint} data from Tally via ngrok`);
    return response.data;
    
  } catch (error) {
    console.error(`❌ Failed to fetch ${endpoint} from Tally:`, error.message);
    
    if (error.code === 'ECONNREFUSED') {
      throw new Error(`Cannot connect to Tally at ${TALLY_BRIDGE_URL}. Make sure Tally is running and ngrok is active.`);
    } else if (error.code === 'ETIMEDOUT') {
      throw new Error('Tally connection timeout. Tally might be offline or slow.');
    } else if (error.response) {
      throw new Error(`Tally error: ${error.response.status} - ${error.response.statusText}`);
    }
    
    throw error;
  }
}

async function pullCustomersFromTally() {
  console.log('📥 Pulling customers from Tally via ngrok...');
  console.log(`🌉 Ngrok URL: ${TALLY_BRIDGE_URL}`);
  
  try {
    const xmlData = await fetchFromTallyBridge('customers');
    
    // Parse customers
    const customers = await parseTallyCustomers(xmlData);

    if (customers.length > 0) {
      console.log(`🎉 Success! Found ${customers.length} customers via ngrok`);
      const saveResult = await saveCustomersToMySQL(customers);
      return { customers, saveResult };
    } else {
      console.log(`❌ No customers found via ngrok`);
      return { customers: [], saveResult: { saved: 0, duplicates: 0, errors: 0 } };
    }
  } catch (err) {
    console.error(`❌ Tally request failed:`, err.message);
    
    if (err.message.includes('ECONNREFUSED')) {
      console.error('💡 Tally connection refused. Please check:');
      console.error('1. Tally is running on port 9000');
      console.error('2. ODBC Server is enabled (F12 > Configure > ODBC)');
      console.error('3. ngrok is running: ngrok http 9000');
      console.error('4. Company is opened in Tally');
    }
    
    return { customers: [], saveResult: { saved: 0, duplicates: 0, errors: 1 } };
  }
}

async function pullItemsFromTally() {
  console.log('📥 Pulling stock items from Tally via ngrok...');
  console.log(`🌉 Ngrok URL: ${TALLY_BRIDGE_URL}`);

  try {
    const xmlData = await fetchFromTallyBridge('items');

    // Parse items
    const items = await parseTallyItems(xmlData);

    if (items.length > 0) {
      console.log(`🎉 Success! Found ${items.length} items via ngrok`);
      const saveResult = await saveItemsToMySQL(items);
      return { items, saveResult };
    } else {
      console.log('❌ No items found via ngrok');
      return { items: [], saveResult: { saved: 0, duplicates: 0, errors: 0 } };
    }
  } catch (err) {
    console.error('❌ Tally items request failed:', err.message);
    
    if (err.message.includes('ECONNREFUSED')) {
      console.error('💡 Check Tally setup:');
      console.error('1. Tally is running');
      console.error('2. ODBC Server is enabled (Port 9000)');
      console.error(`3. Company "${COMPANY_NAME}" is open in Tally`);
    }
    
    return { items: [], saveResult: { saved: 0, duplicates: 0, errors: 1 } };
  }
}

// ==================== API ROUTES ====================

// Health endpoints
app.get("/api/health", (req, res) => {
  res.status(200).json({
    status: 'OK',
    message: 'Backend is running successfully',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    tallyBridge: TALLY_BRIDGE_URL
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

// Test Tally connection
app.get('/api/tally/test', async (req, res) => {
  try {
    console.log('🧪 Testing Tally connection via ngrok...');
    
    const testXml = `<?xml version="1.0"?>
<ENVELOPE>
<HEADER>
<TALLYREQUEST>Export Data</TALLYREQUEST>
</HEADER>
<BODY>
<EXPORTDATA>
<REQUESTDESC>
<REPORTNAME>Company</REPORTNAME>
<STATICVARIABLES>
<SVCURRENTCOMPANY>${COMPANY_NAME}</SVCURRENTCOMPANY>
</STATICVARIABLES>
</REQUESTDESC>
</EXPORTDATA>
</BODY>
</ENVELOPE>`;
    
    const response = await axios.post(TALLY_BRIDGE_URL, testXml, {
      headers: { 
        'Content-Type': 'application/xml',
        'Accept': 'application/xml'
      },
      timeout: 10000
    });
    
    const isSuccessful = response.status === 200 && response.data;
    
    res.json({
      success: isSuccessful,
      message: isSuccessful ? 'Tally connection successful' : 'Tally responded but no data',
      status: response.status,
      dataLength: response.data?.length || 0,
      ngrokUrl: TALLY_BRIDGE_URL,
      company: COMPANY_NAME,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Tally test failed:', error.message);
    
    const errorResponse = {
      success: false,
      error: 'Tally connection failed',
      message: error.message,
      code: error.code,
      ngrokUrl: TALLY_BRIDGE_URL,
      timestamp: new Date().toISOString(),
      troubleshooting: [
        '1. Ensure Tally ERP 9 is running',
        '2. Verify ODBC Server is enabled (F12 > Configure > ODBC)',
        '3. Check if company is open in Tally',
        '4. Verify ngrok is running: ngrok http 9000'
      ]
    };
    
    res.status(500).json(errorResponse);
  }
});

// Manual sync trigger via API
app.post('/api/tally/sync/customers', async (req, res) => {
  try {
    console.log('🔄 Manual customer sync triggered via API');
    
    const { customers, saveResult } = await pullCustomersFromTally();
    
    res.json({
      success: true,
      message: 'Customer sync completed',
      results: {
        customersFound: customers.length,
        customersSaved: saveResult.saved,
        duplicatesSkipped: saveResult.duplicates,
        errors: saveResult.errors,
        ngrokUrl: TALLY_BRIDGE_URL
      }
    });
  } catch (error) {
    console.error('❌ API sync error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Sync failed',
      message: error.message,
      ngrokUrl: TALLY_BRIDGE_URL
    });
  }
});

app.post('/api/tally/sync/items', async (req, res) => {
  try {
    console.log('🔄 Manual item sync triggered via API');
    
    const { items, saveResult } = await pullItemsFromTally();
    
    res.json({
      success: true,
      message: 'Item sync completed',
      results: {
        itemsFound: items.length,
        itemsSaved: saveResult.saved,
        duplicatesSkipped: saveResult.duplicates,
        errors: saveResult.errors,
        ngrokUrl: TALLY_BRIDGE_URL
      }
    });
  } catch (error) {
    console.error('❌ API sync error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Sync failed',
      message: error.message,
      ngrokUrl: TALLY_BRIDGE_URL
    });
  }
});

// Full sync
app.post('/api/tally/sync/all', async (req, res) => {
  try {
    console.log('🔄 Full sync triggered via API');
    
    const customersResult = await pullCustomersFromTally();
    const itemsResult = await pullItemsFromTally();
    
    res.json({
      success: true,
      message: 'Full sync completed',
      results: {
        customers: {
          found: customersResult.customers.length,
          saved: customersResult.saveResult.saved,
          duplicates: customersResult.saveResult.duplicates,
          errors: customersResult.saveResult.errors
        },
        items: {
          found: itemsResult.items.length,
          saved: itemsResult.saveResult.saved,
          duplicates: itemsResult.saveResult.duplicates,
          errors: itemsResult.saveResult.errors
        },
        ngrokUrl: TALLY_BRIDGE_URL
      }
    });
  } catch (error) {
    console.error('❌ Full sync error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Sync failed',
      message: error.message,
      ngrokUrl: TALLY_BRIDGE_URL
    });
  }
});

// 📌 Get all customers
app.get("/customers", (req, res) => {
  const sql = "SELECT * FROM customer";

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

// Main sync function
async function main() {
  console.log('🚀 Starting Tally to MySQL sync via ngrok...');
  console.log(`🌉 Using ngrok: ${TALLY_BRIDGE_URL}`);

  try {
    const customersResult = await pullCustomersFromTally();
    console.log(`📊 Customers: ${customersResult.customers.length} found, ${customersResult.saveResult.saved} saved`);

    const itemsResult = await pullItemsFromTally();
    console.log(`📦 Items: ${itemsResult.items.length} found, ${itemsResult.saveResult.saved} saved`);

  } catch (error) {
    console.error('❌ Sync failed:', error);
  }

  console.log('✅ Process completed');
}

// ✅ For Vercel: Only listen locally, export app for serverless
if (process.env.VERCEL !== '1') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Local server running on port ${PORT}`);
    console.log(`🌉 Tally Bridge URL: ${TALLY_BRIDGE_URL}`);
    console.log(`🏢 Company: ${COMPANY_NAME}`);
    
    // Run sync on startup (optional)
    // main().catch(console.error);
  });
}

// ✅ Export for Vercel serverless function
export default app;