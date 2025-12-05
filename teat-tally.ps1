Write-Host "=== TALLYPRIME CORRECT XML TEST ===" -ForegroundColor Cyan

# TallyPrime expects specific XML format
$tests = @(
    @{
        Name = "Company List"
        XML = @'
<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
<HEADER>
<TALLYREQUEST>Export Data</TALLYREQUEST>
</HEADER>
<BODY>
<EXPORTDATA>
<REQUESTDESC>
<REPORTNAME>List of Companies</REPORTNAME>
</REQUESTDESC>
</EXPORTDATA>
</BODY>
</ENVELOPE>
'@
    },
    @{
        Name = "Ledger Masters"
        XML = @'
<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
<HEADER>
<TALLYREQUEST>Export Data</TALLYREQUEST>
</HEADER>
<BODY>
<EXPORTDATA>
<REQUESTDESC>
<REPORTNAME>List of Ledgers</REPORTNAME>
<STATICVARIABLES>
<SVCURRENTCOMPANY>$$SysName:Current Company</SVCURRENTCOMPANY>
</STATICVARIABLES>
</REQUESTDESC>
</EXPORTDATA>
</BODY>
</ENVELOPE>
'@
    },
    @{
        Name = "Stock Items"
        XML = @'
<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
<HEADER>
<TALLYREQUEST>Export Data</TALLYREQUEST>
</HEADER>
<BODY>
<EXPORTDATA>
<REQUESTDESC>
<REPORTNAME>List of Stock Items</REPORTNAME>
<STATICVARIABLES>
<SVCURRENTCOMPANY>$$SysName:Current Company</SVCURRENTCOMPANY>
</STATICVARIABLES>
</REQUESTDESC>
</EXPORTDATA>
</BODY>
</ENVELOPE>
'@
    },
    @{
        Name = "Simple Test"
        XML = @'
<?xml version="1.0"?>
<ENVELOPE>
<HEADER>
<TALLYREQUEST>Export</TALLYREQUEST>
</HEADER>
<BODY>
<DESC>
<STATICVARIABLES>
<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
</STATICVARIABLES>
</DESC>
</BODY>
</ENVELOPE>
'@
    }
)

foreach ($test in $tests) {
    Write-Host "`nTesting: $($test.Name)..." -ForegroundColor Yellow
    
    try {
        $start = Get-Date
        $response = Invoke-WebRequest -Uri "http://localhost:9000" `
                                     -Method Post `
                                     -Body $test.XML `
                                     -ContentType "application/xml" `
                                     -TimeoutSec 30 `
                                     -UseBasicParsing
        
        $time = (Get-Date) - $start
        
        Write-Host "   ✅ Success! Time: $($time.TotalSeconds.ToString('0.00'))s" -ForegroundColor Green
        Write-Host "   Status: $($response.StatusCode)" -ForegroundColor Green
        Write-Host "   Length: $($response.Content.Length) chars" -ForegroundColor Green
        
        # Check if valid response
        if ($response.Content -match "<ENVELOPE>" -or $response.Content -match "<TALLYMESSAGE>") {
            Write-Host "   🎉 VALID TALLY RESPONSE!" -ForegroundColor Green
            
            # Save to file
            $filename = "tally-response-$($test.Name.Replace(' ', '-')).xml"
            $response.Content | Out-File -FilePath $filename -Encoding UTF8
            Write-Host "   💾 Saved to: $filename" -ForegroundColor Green
            
            # Show preview
            Write-Host "   Preview (first 500 chars):" -ForegroundColor Gray
            Write-Host $response.Content.Substring(0, [Math]::Min(500, $response.Content.Length)) -ForegroundColor Gray
            
            break # Stop after first successful test
        } else {
            Write-Host "   ⚠️ Response but not valid Tally XML" -ForegroundColor Yellow
            Write-Host "   Response: $($response.Content)" -ForegroundColor Gray
        }
        
    } catch {
        Write-Host "   ❌ Failed: $($_.Exception.Message)" -ForegroundColor Red
    }
}

Write-Host "`n=== NEXT STEPS ===" -ForegroundColor Cyan
Write-Host "1. If any test succeeded, Tally is READY for ngrok" -ForegroundColor Green
Write-Host "2. Start ngrok: ngrok http 9000" -ForegroundColor Yellow
Write-Host "3. Update Vercel with new ngrok URL" -ForegroundColor Yellow
Write-Host "4. Test Vercel connection" -ForegroundColor Yellow

Pause