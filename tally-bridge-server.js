import express from 'express';
import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.BRIDGE_PORT || 5000;

// Middleware
app.use(cors({
  origin: '*', // In production, restrict to your Vercel URL
  credentials: true
}));
app.use(express.json());

// Security: Add API key validation
const API_KEY = process.env.BRIDGE_API_KEY || 'f2b400bb8283089bd36f42da88c5074852503bd236158c760b7443a0cf1edc88';

// Tally Configuration
const TALLY_URL = 'http://localhost:9000';
const COMPANY_NAME = process.env.TALLY_COMPANY_NAME || 'CASTOLIN EUTECTIC INDIA';

// XML Requests
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
<SVCURRENTCOMPANY>${COMPANY_NAME}</SVCURRENTCOMPANY>
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

// Validate API Key middleware
const validateApiKey = (req, res, next) => {
  const providedKey = req.headers['x-api-key'];
  if (!providedKey || providedKey !== API_KEY) {
    return res.status(401).json({ 
      error: 'Unauthorized',
      message: 'Invalid or missing API key' 
    });
  }
  next();
};

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'tally-bridge',
    tallyConnected: true,
    company: COMPANY_NAME,
    timestamp: new Date().toISOString() 
  });
});

// Test Tally connection
app.get('/test-tally', validateApiKey, async (req, res) => {
  try {
    const xmlRequest = `<?xml version="1.0"?>
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
    
    const response = await axios.post(TALLY_URL, xmlRequest, {
      headers: { 'Content-Type': 'application/xml' },
      timeout: 10000
    });
    
    res.json({
      success: true,
      message: 'Tally connection successful',
      status: response.status,
      dataLength: response.data?.length || 0
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to connect to Tally',
      details: error.message,
      code: error.code
    });
  }
});

// Fetch customers from Tally
app.post('/api/tally/customers', validateApiKey, async (req, res) => {
  try {
    console.log('📥 Bridge: Fetching customers from Tally...');
    
    const xmlRequest = getCustomerXmlRequest();
    const response = await axios.post(TALLY_URL, xmlRequest, {
      headers: { 'Content-Type': 'application/xml' },
      timeout: 30000
    });
    
    if (!response.data) {
      return res.status(500).json({ 
        error: 'Empty response from Tally' 
      });
    }
    
    // Return as XML
    res.set('Content-Type', 'application/xml');
    res.send(response.data);
    
    console.log('✅ Bridge: Customers fetched successfully');
  } catch (error) {
    console.error('❌ Bridge error (customers):', error.message);
    res.status(500).json({ 
      error: 'Failed to fetch from Tally',
      details: error.message,
      code: error.code
    });
  }
});

// Fetch items from Tally
app.post('/api/tally/items', validateApiKey, async (req, res) => {
  try {
    console.log('📥 Bridge: Fetching items from Tally...');
    
    const xmlRequest = getItemXmlRequest();
    const response = await axios.post(TALLY_URL, xmlRequest, {
      headers: { 'Content-Type': 'application/xml' },
      timeout: 30000
    });
    
    if (!response.data) {
      return res.status(500).json({ 
        error: 'Empty response from Tally' 
      });
    }
    
    // Return as XML
    res.set('Content-Type', 'application/xml');
    res.send(response.data);
    
    console.log('✅ Bridge: Items fetched successfully');
  } catch (error) {
    console.error('❌ Bridge error (items):', error.message);
    res.status(500).json({ 
      error: 'Failed to fetch from Tally',
      details: error.message,
      code: error.code
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🌉 Tally Bridge Server running on port ${PORT}`);
  console.log(`🔗 Tally URL: ${TALLY_URL}`);
  console.log(`🏢 Company: ${COMPANY_NAME}`);
  console.log(`🔐 API Key: ${API_KEY}`);
  console.log(`📡 Bridge URL: http://localhost:${PORT}`);
});