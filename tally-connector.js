import admin from 'firebase-admin';
import express from 'express';
import mysql from 'mysql2';
import axios from 'axios';
import serviceAccount from './config/serviceAccountKey.json' with { type: "json" };
import fs from 'fs';
import { parseStringPromise } from 'xml2js';

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

// MySQL Connection
const mysqlDb = mysql.createConnection({
  host: "ballast.proxy.rlwy.net",
  user: "root",
  password: "cAAiaBeGHjxZVSBFbedADrenyDVkESSu",
  database: "railway",
  waitForConnections: true,
  connectionLimit: 10,
});

mysqlDb.connect((err) => {
  if (err) {
    console.error("❌ MySQL connection failed:", err);
  } else {
    console.log("✅ Connected to MySQL Database");
  }
});

const app = express();
const port = 3000;

// Configuration
const TALLY_URL = 'http://localhost:9000';
const COMPANY_NAME = 'CASTOLIN EUTECTIC INDIA';

// Function to save raw XML for debugging
function saveRawXml(xmlData, type) {
  try {
    if (!xmlData) return null;
    const filename = `debug-${type}-${Date.now()}.xml`;
    fs.writeFileSync(filename, typeof xmlData === 'string' ? xmlData : JSON.stringify(xmlData));
    console.log(`📄 Raw ${type} XML saved to ${filename}`);
    return filename;
  } catch (err) {
    console.warn('⚠️ Failed to save raw XML:', err.message);
    return null;
  }
}

// SIMPLE AND EFFECTIVE XML REQUEST
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

// ALTERNATIVE ITEM REQUEST
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

// ✅ ENHANCED MOBILE NUMBER PARSER FUNCTION
function extractMobileNumber(mobileRaw) {
  if (!mobileRaw || mobileRaw === '-' || mobileRaw === 'NA' || mobileRaw === 'N/A') {
    return null;
  }
  console.log(`🔍 Processing mobile: "${mobileRaw}"`);
  // Extract all digits
  const digitsOnly = mobileRaw.replace(/\D/g, '');
  
  // Handle different scenarios
  let extracted = '';
  
  if (digitsOnly.length === 10) {
    extracted = digitsOnly;
  } else if (digitsOnly.length === 11 && digitsOnly.startsWith('0')) {
    // Remove leading 0 (like 09123456789)
    extracted = digitsOnly.slice(1);
  } else if (digitsOnly.length === 12 && digitsOnly.startsWith('91')) {
    // Remove country code 91
    extracted = digitsOnly.slice(2);
  } else if (digitsOnly.length > 10) {
    // Take last 10 digits for longer numbers
    extracted = digitsOnly.slice(-10);
  }
  
  // Final validation
  if (extracted && extracted.length === 10 && /^\d+$/.test(extracted)) {
    console.log(`✅ Mobile extracted successfully: ${extracted}`);
    return extracted;
  }
  
  console.log(`❌ Could not extract valid mobile from: "${mobileRaw}"`);
  return null;
}

// SIMPLIFIED PARSER THAT WILL WORK WITH YOUR XML
async function parseTallyCustomers(xmlData) {
  const customers = [];
  if (!xmlData) {
    console.log('❌ No XML data provided');
    return customers;
  }

  try {
    console.log('🔍 Starting XML parsing...');
    
    const parsed = await parseStringPromise(xmlData, { 
      explicitArray: false, 
      ignoreAttrs: true,
      mergeAttrs: true,
      trim: true
    });

    console.log('📊 XML parsed successfully');

    let ledgers = [];

    if (parsed.ENVELOPE && 
        parsed.ENVELOPE.BODY && 
        parsed.ENVELOPE.BODY.IMPORTDATA && 
        parsed.ENVELOPE.BODY.IMPORTDATA.REQUESTDATA) {
      
      const requestData = parsed.ENVELOPE.BODY.IMPORTDATA.REQUESTDATA;
      
      if (requestData.TALLYMESSAGE) {
        const tallyMessages = Array.isArray(requestData.TALLYMESSAGE) 
          ? requestData.TALLYMESSAGE 
          : [requestData.TALLYMESSAGE];

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
    }

    console.log(`📊 Found ${ledgers.length} ledger nodes`);

    // Process each ledger
    for (const ledger of ledgers) {
      try {
        // 1️⃣ Extract all NAME elements
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

        if (!customerName) {
          console.log('⚠️ Skipping ledger without name');
          continue;
        }

        // 2️⃣ Skip system accounts
        if (shouldSkipLedger(customerName)) {
          console.log(`⏭️ Skipping system account: ${customerName}`);
          continue;
        }

        // 3️⃣ ONLY ACCEPT "Sundry Debtors" parent group
        const parent = ledger.PARENT || '';
        const isSundryDebtor = parent.toLowerCase() === 'sundry debtors';

        if (!isSundryDebtor) {
          console.log(`⏭️ Skipping non-Sundry Debtors customer: ${customerName} (Parent: ${parent})`);
          continue;
        }

        // 4️⃣ Extract mobile number
        let mobileNumber = null;
        if (ledger.LEDGERMOBILE) {
          let mobileRaw = '';

          if (typeof ledger.LEDGERMOBILE === 'object' && ledger.LEDGERMOBILE._) {
            mobileRaw = String(ledger.LEDGERMOBILE._).trim();
          } else {
            mobileRaw = String(ledger.LEDGERMOBILE).trim();
          }

          mobileNumber = extractMobileNumber(mobileRaw);
        }

        // 6️⃣ Extract STATE field
        let state = 'not_applicable'; // Default value
        if (ledger.STATE) {
          let stateRaw = '';
          if (typeof ledger.STATE === 'object' && ledger.STATE._) {
            stateRaw = String(ledger.STATE._).trim();
          } else {
            stateRaw = String(ledger.STATE).trim();
          }

          if (stateRaw && stateRaw !== '-' && stateRaw.toLowerCase() !== 'na') {
            state = stateRaw;
          }
        }

        // 5️⃣ Extract email
        let email = null;
        if (ledger.EMAIL) {
          let emailRaw = '';
          if (typeof ledger.EMAIL === 'object' && ledger.EMAIL._) {
            emailRaw = String(ledger.EMAIL._).trim();
          } else {
            emailRaw = String(ledger.EMAIL).trim();
          }

          if (emailRaw && emailRaw !== '-') {
            email = emailRaw;
          }
        }

        // 6️⃣ ✅ EXTRACT CUSTOMER TYPE FROM UDF:PRODUCTCATEGORY AND CONVERT TO LOWERCASE
        let customerType = 'direct'; // Default value (now lowercase)
        
        if (ledger.UDF_PRODUCTCATEGORY_LIST) {
          console.log('🔍 Found UDF:PRODUCTCATEGORY.LIST structure:', JSON.stringify(ledger.UDF_PRODUCTCATEGORY_LIST, null, 2));
          
          // Handle different possible structures
          if (ledger.UDF_PRODUCTCATEGORY_LIST.UDF_PRODUCTCATEGORY) {
            let extractedType = '';
            if (Array.isArray(ledger.UDF_PRODUCTCATEGORY_LIST.UDF_PRODUCTCATEGORY)) {
              extractedType = String(ledger.UDF_PRODUCTCATEGORY_LIST.UDF_PRODUCTCATEGORY[0]).trim();
            } else {
              extractedType = String(ledger.UDF_PRODUCTCATEGORY_LIST.UDF_PRODUCTCATEGORY).trim();
            }
            
            // Convert to lowercase and clean up
            customerType = extractedType.toLowerCase().trim();
            console.log(`🎯 Extracted customer type: ${extractedType} → ${customerType}`);
          }
        }

        // 7️⃣ Build final customer object with lowercase values
        const customer = {
          customer_code: customerCode || null,
          customer_name: customerName,
          email: email,
          mobile_number: mobileNumber,
          state: state,
          customer_type: customerType,
          role: customerType, // Same lowercase value as customer_type
          parent_group: parent
        };

        console.log(`📝 Sundry Debtor Customer: ${customer.customer_name} | Type: ${customer.customer_type} | Code: ${customer.customer_code || 'N/A'}`);
        customers.push(customer);

      } catch (innerErr) {
        console.warn('⚠️ Error processing ledger:', innerErr.message);
        continue;
      }
    }

  } catch (err) {
    console.error('❌ XML parsing error:', err.message);
    saveRawXml(xmlData, 'customers-parse-error');
  }

  console.log(`✅ Parsing completed: ${customers.length} Sundry Debtors customers found`);
  return customers;
}

// Helper functions
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

// 🧩 PARSE ITEMS - XML PARSER (Fixed item_code extraction)
async function parseTallyItems(xmlData) {
  const items = [];
  if (!xmlData) return items;

  try {
    console.log('🔍 Parsing stock item XML...');
    const parsed = await parseStringPromise(xmlData, {
      explicitArray: false,
      ignoreAttrs: true,
      mergeAttrs: true,
      trim: true,
    });

    let stockItems = [];

    if (
      parsed.ENVELOPE &&
      parsed.ENVELOPE.BODY &&
      parsed.ENVELOPE.BODY.IMPORTDATA &&
      parsed.ENVELOPE.BODY.IMPORTDATA.REQUESTDATA
    ) {
      const requestData = parsed.ENVELOPE.BODY.IMPORTDATA.REQUESTDATA;

      if (requestData.TALLYMESSAGE) {
        const tallyMessages = Array.isArray(requestData.TALLYMESSAGE)
          ? requestData.TALLYMESSAGE
          : [requestData.TALLYMESSAGE];

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
    }

    console.log(`📦 Found ${stockItems.length} <STOCKITEM> nodes`);

    for (const item of stockItems) {
      const itemName = typeof item.NAME === 'string' ? item.NAME.trim() : null;
      const parent = item.PARENT ? item.PARENT.trim() : null;
      const baseUnit = item.BASEUNITS ? item.BASEUNITS.trim() : null;
      const gstRate = item.RATEOFVAT ? item.RATEOFVAT.trim() : null;
      
      // ✅ Extract opening rate value
      let openingRate = null;
      if (item.OPENINGRATE) {
        const rateMatch = item.OPENINGRATE.match(/^([\d.]+)/);
        if (rateMatch) {
          openingRate = parseFloat(rateMatch[1]);
        }
      }

      // ✅ FIXED: Extract item_code from MAILINGNAME.LIST > MAILINGNAME
      let itemCode = null;
      try {
        console.log('🔍 Looking for MAILINGNAME in item:', itemName);
        
        // Method 1: Check MAILINGNAME.LIST structure
        if (item.MAILINGNAME_LIST) {
          console.log('📋 Found MAILINGNAME_LIST structure:', JSON.stringify(item.MAILINGNAME_LIST, null, 2));
          
          // Handle different possible structures
          if (item.MAILINGNAME_LIST.MAILINGNAME) {
            if (Array.isArray(item.MAILINGNAME_LIST.MAILINGNAME)) {
              itemCode = item.MAILINGNAME_LIST.MAILINGNAME[0]?.trim();
              console.log(`📋 Found itemCode from MAILINGNAME array: ${itemCode}`);
            } else {
              itemCode = item.MAILINGNAME_LIST.MAILINGNAME.trim();
              console.log(`📋 Found itemCode from MAILINGNAME: ${itemCode}`);
            }
          }
        }
        
        // Method 2: If still no itemCode, try to find any MAILINGNAME in the object
        if (!itemCode) {
          // Deep search for MAILINGNAME in the item object
          const findMailingName = (obj) => {
            for (let key in obj) {
              if (key === 'MAILINGNAME' && obj[key]) {
                return Array.isArray(obj[key]) ? obj[key][0]?.trim() : obj[key].trim();
              }
              if (typeof obj[key] === 'object' && obj[key] !== null) {
                const result = findMailingName(obj[key]);
                if (result) return result;
              }
            }
            return null;
          };
          
          itemCode = findMailingName(item);
          if (itemCode) {
            console.log(`🔍 Found itemCode via deep search: ${itemCode}`);
          }
        }

        // Method 3: Check if there's a simple MAILINGNAME at root level
        if (!itemCode && item.MAILINGNAME) {
          itemCode = Array.isArray(item.MAILINGNAME) 
            ? item.MAILINGNAME[0]?.trim() 
            : item.MAILINGNAME.trim();
          console.log(`📋 Found itemCode from root MAILINGNAME: ${itemCode}`);
        }

      } catch (err) {
        console.warn('⚠️ Error extracting itemCode from MAILINGNAME:', err.message);
      }

      if (!itemName) continue;

      const stockItem = {
        stock_item_name: itemName,
        item_code: itemCode || null,
        parent_group: parent || 'General',
        uom: baseUnit || null,
        gst: gstRate || null,
        rate: openingRate,
      };

      console.log(`🧾 Item: ${stockItem.stock_item_name} | Code: ${stockItem.item_code || 'NULL'} | Rate: ${stockItem.rate || 'N/A'}`);
      items.push(stockItem);
    }
  } catch (err) {
    console.error('❌ XML parsing error (items):', err.message);
    saveRawXml(xmlData, 'items-parse-error');
  }

  console.log(`✅ Parsed ${items.length} items`);
  
  // Log summary of item codes found
  const itemsWithCodes = items.filter(item => item.item_code);
  console.log(`📊 Items with codes: ${itemsWithCodes.length}/${items.length}`);
  
  return items;
}

// 🧩 ALTERNATIVE STRING-BASED ITEM PARSER (Improved MAILINGNAME extraction)
async function parseTallyItemsAlternative(xmlData) {
  const items = [];
  if (!xmlData) return items;

  try {
    console.log('🔍 Using regex-based fallback parser for stock items...');
    const itemRegex = /<STOCKITEM[\s\S]*?<\/STOCKITEM>/g;
    let match;

    while ((match = itemRegex.exec(xmlData)) !== null) {
      const itemXml = match[0];

      // 🏷️ Basic field extraction
      const nameMatches = [...itemXml.matchAll(/<NAME>(.*?)<\/NAME>/g)];
      const parentMatch = itemXml.match(/<PARENT>(.*?)<\/PARENT>/);
      const unitMatch = itemXml.match(/<BASEUNITS>(.*?)<\/BASEUNITS>/);

      const itemName = nameMatches[0]?.[1]?.trim() || null;
      if (!itemName) continue;

      // ✅ IMPROVED: Extract item_code from MAILINGNAME with better regex
      let itemCode = null;
      
      // Method 1: Look for MAILINGNAME inside MAILINGNAME.LIST
      const mailingNameListMatch = itemXml.match(/<MAILINGNAME\.LIST[\s\S]*?<MAILINGNAME>(.*?)<\/MAILINGNAME>/);
      if (mailingNameListMatch) {
        itemCode = mailingNameListMatch[1].trim();
        console.log(`📋 Found itemCode from MAILINGNAME.LIST: ${itemCode}`);
      }
      
      // Method 2: Look for standalone MAILINGNAME
      if (!itemCode) {
        const mailingNameMatch = itemXml.match(/<MAILINGNAME>(.*?)<\/MAILINGNAME>/);
        if (mailingNameMatch) {
          itemCode = mailingNameMatch[1].trim();
          console.log(`📋 Found itemCode from standalone MAILINGNAME: ${itemCode}`);
        }
      }

      // ✅ Extract opening rate
      let openingRate = null;
      const openingRateMatch = itemXml.match(/<OPENINGRATE>(.*?)<\/OPENINGRATE>/);
      if (openingRateMatch) {
        const rateText = openingRateMatch[1];
        const rateValueMatch = rateText.match(/^([\d.]+)/);
        if (rateValueMatch) {
          openingRate = parseFloat(rateValueMatch[1]);
        }
      }

      // 💡 Extract GST rates
      const gstRateMatches = [...itemXml.matchAll(/<GSTRATE>(.*?)<\/GSTRATE>/g)];
      let gstRate = null;

      if (gstRateMatches.length > 0) {
        const gstValues = gstRateMatches
          .map(m => parseFloat(m[1]?.trim()))
          .filter(v => !isNaN(v) && v > 0);
        gstRate = gstValues.length > 0 ? Math.max(...gstValues) : 0;
      }

      // 🧾 Extract HSN Code
      let hsnCode = null;
      const hsnMatches = [...itemXml.matchAll(/<HSNDETAILS\.LIST>[\s\S]*?<\/HSNDETAILS\.LIST>/g)];

      if (hsnMatches.length > 0) {
        let latestDate = 0;
        for (const match of hsnMatches) {
          const block = match[0];
          const dateMatch = block.match(/<APPLICABLEFROM>(.*?)<\/APPLICABLEFROM>/);
          const codeMatch = block.match(/<HSNCODE>(.*?)<\/HSNCODE>/);
          const applicableFrom = parseInt(dateMatch?.[1] || '0', 10);
          const code = codeMatch?.[1]?.trim() || '';
          if (code && applicableFrom >= latestDate) {
            latestDate = applicableFrom;
            hsnCode = code;
          }
        }
      }

      const item = {
        stock_item_name: itemName,
        item_code: itemCode || null,
        parent_group: parentMatch ? parentMatch[1].trim() : 'General',
        uom: unitMatch ? unitMatch[1].trim() : null,
        gst: gstRate,
        hsn: hsnCode || null,
        rate: openingRate,
      };

      console.log(`🧾 Item (alt): ${item.stock_item_name} | Code: ${itemCode || 'NULL'} | Rate: ${openingRate || 'N/A'}`);
      items.push(item);
    }
  } catch (err) {
    console.error('❌ Alternative item parsing error:', err.message);
  }

  console.log(`✅ Parsed ${items.length} items (alt)`);
  
  // Log summary
  const itemsWithCodes = items.filter(item => item.item_code);
  console.log(`📊 Alternative - Items with codes: ${itemsWithCodes.length}/${items.length}`);
  
  return items;
}

// FUNCTION TO PULL CUSTOMERS FROM TALLY
async function pullCustomersFromTally() {
  console.log('📥 Pulling customers from Tally...');
  console.log(`🏢 Using company: "${COMPANY_NAME}"`);
  
  const xmlRequest = getCustomerXmlRequest();

  try {
    console.log('Sending XML request to Tally...');
    const response = await axios.post(TALLY_URL, xmlRequest, {
      headers: { 'Content-Type': 'application/xml' },
      timeout: 30000
    });
    
    console.log('✅ Received response from Tally');
    console.log('HTTP Status:', response.status);
    console.log('Content length:', response.data?.length || 'unknown');
    
    if (!response.data) {
      console.log('❌ Empty response from Tally');
      return [];
    }

    // Save raw response
    const savedFile = saveRawXml(response.data, `customers-response`);
    
    // Parse customers
    const customers = await parseTallyCustomers(response.data);

    if (customers.length > 0) {
      console.log(`🎉 Success! Found ${customers.length} customers`);
      await saveCustomersToMySQL(customers);
      return customers;
    } else {
      console.log(`❌ No customers found`);
      console.log(`📁 Check saved file for analysis: ${savedFile}`);
      
      // Let's try an alternative parsing approach
      console.log('🔄 Trying alternative parsing...');
      const alternativeCustomers = await parseTallyCustomersAlternative(response.data);
      if (alternativeCustomers.length > 0) {
        console.log(`🎉 Alternative parsing found ${alternativeCustomers.length} customers`);
        await saveCustomersToMySQL(alternativeCustomers);
        return alternativeCustomers;
      }
    }
  } catch (err) {
    console.error(`❌ Request failed:`, err.message);
    if (err.code === 'ECONNREFUSED') {
      console.error('💡 Tally connection refused. Please check:');
      console.error('1. Tally is running');
      console.error('2. ODBC Server is enabled (F12 > Configure > ODBC > Port 9000)');
      console.error('3. Company "XML Demo Data" is opened in Tally');
    }
    if (err.response) {
      console.error('Response status:', err.response.status);
    }
  }

  console.log('❌ Customer request failed');
  return [];
}

// 🧩 FUNCTION TO PULL STOCK ITEMS FROM TALLY
async function pullItemsFromTally() {
  console.log('📥 Pulling stock items from Tally...');
  console.log(`🏢 Using company: "${COMPANY_NAME}"`);

  const xmlRequest = getItemXmlRequest();

  try {
    console.log('Sending XML request to Tally...');
    const response = await axios.post(TALLY_URL, xmlRequest, {
      headers: { 'Content-Type': 'application/xml' },
      timeout: 30000,
    });

    console.log('✅ Received response from Tally');
    console.log('HTTP Status:', response.status);
    console.log('Content length:', response.data?.length || 'unknown');

    if (!response.data) {
      console.log('❌ Empty response from Tally');
      return [];
    }

    // Save raw response for debugging
    const savedFile = saveRawXml(response.data, `items-response`);

    // Try XML parsing first
    const items = await parseTallyItems(response.data);

    if (items.length > 0) {
      console.log(`🎉 Success! Found ${items.length} stock items`);
      await saveItemsToMySQL(items);
      return items;
    } else {
      console.log('❌ No items found using XML parser');
      console.log(`📁 Check saved file: ${savedFile}`);
      console.log('🔄 Trying alternative string-based parser...');
      const altItems = await parseTallyItemsAlternative(response.data);
      if (altItems.length > 0) {
        console.log(`🎉 Alternative parsing found ${altItems.length} items`);
        await saveItemsToMySQL(altItems);
        return altItems;
      }
    }
  } catch (err) {
    console.error('❌ Request failed:', err.message);
    if (err.code === 'ECONNREFUSED') {
      console.error('💡 Check Tally setup:');
      console.error('1. Tally is running');
      console.error('2. ODBC Server is enabled (Port 9000)');
      console.error(`3. Company "${COMPANY_NAME}" is open in Tally`);
    }
  }

  console.log('❌ Item pull failed');
  return [];
}

// ALTERNATIVE PARSING METHOD - DIRECT STRING PARSING
async function parseTallyCustomersAlternative(xmlData) {
  const customers = [];
  if (!xmlData) return customers;

  try {
    console.log('🔍 Trying alternative string-based parsing...');

    const ledgerRegex = /<LEDGER[\s\S]*?<\/LEDGER>/g;
    let match;

    while ((match = ledgerRegex.exec(xmlData)) !== null) {
      const ledgerXml = match[0];

      // Extract key fields
      const nameMatches = [...ledgerXml.matchAll(/<NAME>(.*?)<\/NAME>/g)];
      const parentMatch = ledgerXml.match(/<PARENT>(.*?)<\/PARENT>/);
      const mobileMatch = ledgerXml.match(/<LEDGERMOBILE>(.*?)<\/LEDGERMOBILE>/);
      const emailMatch = ledgerXml.match(/<EMAIL>(.*?)<\/EMAIL>/);

      if (nameMatches.length === 0) continue;

      const customerName = nameMatches[0][1]?.trim() || null;
      const customerCode = nameMatches[1]?.[1]?.trim() || null;
      const parent = parentMatch ? parentMatch[1].trim() : '';

      // ONLY ACCEPT "Sundry Debtors" parent group
      const isSundryDebtor = parent.toLowerCase() === 'sundry debtors';

      if (!isSundryDebtor) {
        console.log(`⏭️ Skipping non-Sundry Debtors customer: ${customerName} (Parent: ${parent})`);
        continue;
      }

      // Extract mobile number
      let mobileNumber = null;
      if (mobileMatch && mobileMatch[1]) {
        const mobileRaw = mobileMatch[1].trim();
        mobileNumber = extractMobileNumber(mobileRaw);
      }

      // Extract STATE
      let state = 'not_applicable';
      const stateMatch = ledgerXml.match(/<STATE>(.*?)<\/STATE>/);
      if (stateMatch && stateMatch[1]) {
        const stateRaw = stateMatch[1].trim();
        if (stateRaw && stateRaw !== '-' && stateRaw.toLowerCase() !== 'na') {
          state = stateRaw;
        }
      }

      // Extract email
      let email = null;
      if (emailMatch && emailMatch[1]) {
        const emailRaw = emailMatch[1].trim();
        if (emailRaw && emailRaw !== '-') {
          email = emailRaw;
        }
      }

      // ✅ EXTRACT CUSTOMER TYPE FROM UDF:PRODUCTCATEGORY AND CONVERT TO LOWERCASE
      let customerType = 'direct'; // Default value (now lowercase)
      
      // Look for UDF:PRODUCTCATEGORY.LIST structure
      const productCategoryMatch = ledgerXml.match(/<UDF:PRODUCTCATEGORY\.LIST[\s\S]*?<UDF:PRODUCTCATEGORY[^>]*>(.*?)<\/UDF:PRODUCTCATEGORY>/);
      if (productCategoryMatch && productCategoryMatch[1]) {
        const extractedType = productCategoryMatch[1].trim();
        customerType = extractedType.toLowerCase().trim();
        console.log(`🎯 Extracted customer type (alt): ${extractedType} → ${customerType}`);
      }

      const customer = {
        customer_name: customerName,
        customer_code: customerCode,
        mobile_number: mobileNumber,
        email: email,
        state: state,
        customer_type: customerType,
        role: customerType, // Same lowercase value as customer_type
        parent_group: parent,
      };

      console.log(`📝 Sundry Debtor Customer (alt): ${customer.customer_name} | Type: ${customer.customer_type} | Code: ${customer.customer_code}`);
      customers.push(customer);
    }

  } catch (err) {
    console.error('❌ Alternative parsing error:', err.message);
  }
  return customers;
}


// UPDATED FUNCTION TO SAVE CUSTOMERS TO MYSQL - EXPLICIT DEFAULTS
async function saveCustomersToMySQL(customers) {
  if (customers.length === 0) {
    console.log('ℹ️ No customers to save');
    return;
  }

  const validCustomers = customers.filter(customer => customer.customer_code && customer.customer_code.trim() !== '');
  
  console.log(`📊 Filtered customers: ${validCustomers.length} valid customers (${customers.length - validCustomers.length} skipped due to empty customer_code)`);
  
  if (validCustomers.length === 0) {
    console.log('ℹ️ No valid customers to save (all customers have empty customer_code)');
    return;
  }
  
  console.log(`💾 Saving ${validCustomers.length} customers to MySQL...`);
  
  let savedCount = 0;
  let errorCount = 0;
  let duplicateCount = 0;
  
  for (const customer of validCustomers) {
    try {
      // ✅ OPTION 2: EXPLICITLY SET DEFAULTS
      const insertSql = `
        INSERT IGNORE INTO customer 
        (customer_code, customer_name, mobile_number, state, email, 
         password, customer_type, role, status, parent_group, firebase_uid)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;
      
      await new Promise((resolve, reject) => {
        mysqlDb.query(insertSql, [
          customer.customer_code,
          customer.customer_name,
          customer.mobile_number,
          customer.state || 'not_applicable',
          customer.email,
          null,                              // password is NULL
          customer.customer_type,            // From UDF:PRODUCTCATEGORY
          customer.role,                     // Same as customer_type
          'inactive',                        // Default status
          customer.parent_group || 'Sundry Debtors',
          null                               // firebase_uid is NULL
        ], (err, result) => {
          if (err) {
            console.error(`❌ Error inserting customer ${customer.customer_name}:`, err.message);
            errorCount++;
          } else {
            if (result.affectedRows > 0) {
              console.log(`✅ Added: ${customer.customer_name} (Code: ${customer.customer_code}, Type: ${customer.customer_type})`);
              savedCount++;
            } else {
              console.log(`⏭️ Skipped duplicate: ${customer.customer_name} (Code: ${customer.customer_code})`);
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
  
  // Log summary of skipped customers
  const skippedCustomers = customers.filter(customer => !customer.customer_code || customer.customer_code.trim() === '');
  if (skippedCustomers.length > 0) {
    console.log(`⏭️ Skipped ${skippedCustomers.length} customers with empty customer_code:`);
    skippedCustomers.forEach(customer => {
      console.log(`   - ${customer.customer_name} (Type: ${customer.customer_type})`);
    });
  }
}

// 🧩 SAVE ITEMS TO MYSQL - SKIP ITEMS WITH EMPTY/NULL ITEM_CODE
async function saveItemsToMySQL(items) {
  if (items.length === 0) {
    console.log('ℹ️ No stock items to save');
    return;
  }

  // Filter out items with empty or null item_code
  const validItems = items.filter(item => item.item_code && item.item_code.trim() !== '');
  
  console.log(`📊 Filtered items: ${validItems.length} valid items (${items.length - validItems.length} skipped due to empty item_code)`);
  
  if (validItems.length === 0) {
    console.log('ℹ️ No valid items to save (all items have empty item_code)');
    return;
  }

  console.log(`💾 Saving ${validItems.length} items to MySQL...`);

  let savedCount = 0;
  let errorCount = 0;

  for (const item of validItems) {
    try {
      const insertSql = `
        INSERT IGNORE INTO stock_item 
        (item_code, stock_item_name, parent_group, uom, gst, hsn, rate)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `;

      await new Promise((resolve) => {
        mysqlDb.query(
          insertSql,
          [
            item.item_code,
            item.stock_item_name,
            item.parent_group,
            item.uom,
            item.gst,
            item.hsn,
            item.rate,
          ],
          (err, result) => {
            if (err) {
              console.error(
                `❌ Error inserting item ${item.stock_item_name}:`,
                err.message
              );
              errorCount++;
            } else {
              if (result.affectedRows > 0) {
                console.log(`✅ Added: ${item.stock_item_name} (Code: ${item.item_code}, Rate: ${item.rate || 'N/A'})`);
                savedCount++;
              } else {
                console.log(`⏭️ Skipped duplicate: ${item.stock_item_name} (Code: ${item.item_code})`);
              }
            }
            resolve();
          }
        );
      });
    } catch (error) {
      console.error(
        `❌ Error processing item ${item.stock_item_name}:`,
        error.message
      );
      errorCount++;
    }
  }

  console.log(`✅ MySQL: ${savedCount} new items added, ${errorCount} errors`);
  
  // Log summary of skipped items
  const skippedItems = items.filter(item => !item.item_code || item.item_code.trim() === '');
  if (skippedItems.length > 0) {
    console.log(`⏭️ Skipped ${skippedItems.length} items with empty item_code:`);
    skippedItems.forEach(item => {
      console.log(`   - ${item.stock_item_name}`);
    });
  }
}

// Main execution
async function main() {
  console.log('🚀 Starting Tally to MySQL sync...');

  try {
    const customers = await pullCustomersFromTally();
    console.log(`📊 Final result: ${customers.length} customers processed`);

    const items = await pullItemsFromTally();
    console.log(`📦 Final result: ${items.length} items processed`);

  } catch (error) {
    console.error('❌ Sync failed:', error);
  }

  console.log('✅ Process completed');
}

// Start the process
main().catch(console.error);