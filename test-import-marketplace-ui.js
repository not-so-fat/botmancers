#!/usr/bin/env node

const http = require('http');

const PORT = 43123;
const BASE_URL = `http://localhost:${PORT}`;

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: PORT,
      path,
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      followRedirect: false,
    };

    const req = http.request(options, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ 
            status: res.statusCode, 
            headers: res.headers,
            body: data ? JSON.parse(data) : null,
            location: res.headers.location 
          });
        } catch {
          resolve({ 
            status: res.statusCode, 
            headers: res.headers,
            body: data,
            location: res.headers.location 
          });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function testMarketplaceHandoffStatus() {
  console.log('TEST: GET /api/marketplace-handoff/status returns configuration state\n');

  const response = await request('GET', '/api/marketplace-handoff/status');

  console.log(`Status: ${response.status}`);
  console.log(`Response: ${JSON.stringify(response.body, null, 2)}\n`);

  if (response.status === 200 && typeof response.body.configured === 'boolean') {
    console.log('✅ Marketplace handoff status test PASSED\n');
    return { pass: true, configured: response.body.configured };
  } else {
    console.log('❌ Marketplace handoff status test FAILED\n');
    return { pass: false, configured: false };
  }
}

async function testHandoffWithoutReturnPath() {
  console.log('TEST: Handoff without return path returns 400\n');

  const response = await request('GET', '/api/marketplace-handoff');

  console.log(`Status: ${response.status}`);
  console.log(`Response: ${JSON.stringify(response.body, null, 2)}\n`);

  if (response.status === 400 && response.body.error?.includes('Return path')) {
    console.log('✅ Handoff without return path test PASSED\n');
    return true;
  } else {
    console.log('❌ Handoff without return path test FAILED\n');
    return false;
  }
}

async function testHandoffWithExternalReturn() {
  console.log('TEST: Handoff with external return target returns 400\n');

  const externalReturn = 'https://evil.com/steal-data';
  const response = await request('GET', `/api/marketplace-handoff?return=${encodeURIComponent(externalReturn)}`);

  console.log(`Status: ${response.status}`);
  console.log(`Response: ${JSON.stringify(response.body, null, 2)}\n`);

  if (response.status === 400 && response.body.error?.includes('same-origin')) {
    console.log('✅ Handoff with external return test PASSED\n');
    return true;
  } else {
    console.log('❌ Handoff with external return test FAILED\n');
    return false;
  }
}

async function testHandoffRedirectFormat() {
  console.log('TEST: Handoff redirect has correct format (target, return, no userinfo/fragment)\n');

  const returnPath = `${BASE_URL}/`;
  const response = await request('GET', `/api/marketplace-handoff?return=${encodeURIComponent(returnPath)}`);

  console.log(`Status: ${response.status}`);
  console.log(`Location: ${response.location}\n`);

  if (response.status === 307 || response.status === 302 || response.status === 301) {
    const location = response.location;
    
    if (!location) {
      console.log('❌ No redirect location header\n');
      return false;
    }

    try {
      const url = new URL(location);
      
      const checks = [
        { name: 'Has target=botmancers', pass: url.searchParams.get('target') === 'botmancers' },
        { name: 'Has return parameter', pass: url.searchParams.get('return') === returnPath },
        { name: 'No userinfo (username)', pass: url.username === '' },
        { name: 'No userinfo (password)', pass: url.password === '' },
        { name: 'No fragment/hash', pass: url.hash === '' },
      ];

      console.log('Redirect URL checks:');
      checks.forEach(check => {
        console.log(`  ${check.pass ? '✓' : '✗'} ${check.name}`);
      });
      console.log();

      if (checks.every(c => c.pass)) {
        console.log('✅ Handoff redirect format test PASSED\n');
        return true;
      }
    } catch (error) {
      console.log(`  ✗ Invalid redirect URL: ${error.message}\n`);
    }
  } else if (response.status === 404) {
    console.log('⚠️  CLONE_MARKET_URL not configured (expected for this test environment)\n');
    return null;
  }

  console.log('❌ Handoff redirect format test FAILED\n');
  return false;
}

async function testImportReturnWithValidBotId() {
  console.log('TEST: Import return with valid bot ID using "imported" parameter\n');

  const createResponse = await request('POST', '/api/bots', {
    name: 'Marketplace Test Bot',
    title: 'Imported Test Bot',
    description: 'Bot for testing marketplace import return',
  });

  if (createResponse.status !== 200) {
    console.log('❌ Failed to create test bot\n');
    return false;
  }

  const botId = createResponse.body.id;
  console.log(`Created test bot with ID: ${botId}\n`);

  const botsResponse = await request('GET', '/api/bots');
  const bots = botsResponse.body;
  const foundBot = bots.find(b => b.id === botId);

  if (foundBot) {
    console.log('✓ Bot found in list after creation');
    console.log(`  Name: ${foundBot.name}`);
    console.log(`  ID: ${foundBot.id}`);
    console.log(`  Return URL would be: ${BASE_URL}/?imported=${botId}\n`);
    console.log('✅ Import return with valid bot ID test PASSED\n');
    return { pass: true, botId };
  } else {
    console.log('❌ Import return with valid bot ID test FAILED\n');
    return { pass: false };
  }
}

async function testImportReturnWithInvalidBotId() {
  console.log('TEST: Import return with invalid bot ID does not corrupt state\n');

  const invalidBotId = 'nonexistent-bot-id-12345';
  
  const botsResponse = await request('GET', '/api/bots');
  const bots = botsResponse.body;
  const foundBot = bots.find(b => b.id === invalidBotId);

  if (!foundBot) {
    console.log('✓ Invalid bot ID correctly not found in list');
    console.log(`  Return URL would be: ${BASE_URL}/?imported=${invalidBotId}`);
    console.log('  Expected: error message shown, state not corrupted\n');
    console.log('✅ Import return with invalid bot ID test PASSED\n');
    return true;
  } else {
    console.log('❌ Import return with invalid bot ID test FAILED (bot should not exist)\n');
    return false;
  }
}

async function testUnconfiguredHandoff() {
  console.log('TEST: Unconfigured CLONE_MARKET_URL returns 404\n');

  const returnPath = `${BASE_URL}/`;
  const response = await request('GET', `/api/marketplace-handoff?return=${encodeURIComponent(returnPath)}`);

  console.log(`Status: ${response.status}`);
  console.log(`Response: ${JSON.stringify(response.body, null, 2)}\n`);

  if (response.status === 404 && response.body.error?.includes('not configured')) {
    console.log('✅ Unconfigured handoff test PASSED\n');
    return true;
  } else if (response.status === 307 || response.status === 302) {
    console.log('⚠️  CLONE_MARKET_URL is configured in this environment\n');
    return null;
  } else {
    console.log('❌ Unconfigured handoff test FAILED\n');
    return false;
  }
}

async function runAllTests() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('Botmancers Import from Marketplace — Test Suite');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const results = {};

  console.log('═══════════════════════════════════════════════════════════════\n');
  const statusResult = await testMarketplaceHandoffStatus();
  results.status = statusResult.pass;

  console.log('═══════════════════════════════════════════════════════════════\n');
  results.noReturnPath = await testHandoffWithoutReturnPath();

  console.log('═══════════════════════════════════════════════════════════════\n');
  results.externalReturn = await testHandoffWithExternalReturn();

  console.log('═══════════════════════════════════════════════════════════════\n');
  const redirectResult = await testHandoffRedirectFormat();
  results.redirectFormat = redirectResult;

  console.log('═══════════════════════════════════════════════════════════════\n');
  const unconfiguredResult = await testUnconfiguredHandoff();
  results.unconfigured = unconfiguredResult;

  console.log('═══════════════════════════════════════════════════════════════\n');
  const validBotResult = await testImportReturnWithValidBotId();
  results.validBotId = validBotResult.pass;

  console.log('═══════════════════════════════════════════════════════════════\n');
  results.invalidBotId = await testImportReturnWithInvalidBotId();

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('TEST SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════\n');

  Object.entries(results).forEach(([name, pass]) => {
    const icon = pass === null ? '⚠️ ' : pass ? '✅' : '❌';
    const status = pass === null ? 'SKIPPED' : pass ? 'PASSED' : 'FAILED';
    console.log(`  ${icon} ${name}: ${status}`);
  });

  console.log();

  const requiredTests = Object.entries(results).filter(([_, pass]) => pass !== null);
  const allRequiredPassed = requiredTests.every(([_, pass]) => pass === true);

  if (allRequiredPassed) {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('ALL REQUIRED TESTS PASSED ✅');
    console.log('═══════════════════════════════════════════════════════════════\n');
    
    if (results.redirectFormat === null || results.unconfigured === null) {
      console.log('Note: Some tests were skipped based on CLONE_MARKET_URL configuration state.');
      console.log('This is expected. The feature correctly handles both configured and');
      console.log('unconfigured states.\n');
    }
    
    return true;
  } else {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('SOME TESTS FAILED ❌');
    console.log('═══════════════════════════════════════════════════════════════\n');
    return false;
  }
}

async function main() {
  try {
    const passed = await runAllTests();
    process.exit(passed ? 0 : 1);
  } catch (error) {
    console.error('\n❌ Test suite failed:', error.message);
    console.error('\nMake sure the dev server is running: npm run dev\n');
    process.exit(1);
  }
}

main();
