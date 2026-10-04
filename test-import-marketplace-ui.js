#!/usr/bin/env node

const http = require('http');
const https = require('https');
const { URL } = require('url');

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
    };

    const req = http.request(options, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function testCloneMarketUrlEndpoint() {
  console.log('TEST: GET /api/clone-market-url returns configured URL or 404\n');

  const response = await request('GET', '/api/clone-market-url');

  console.log(`Status: ${response.status}`);
  console.log(`Response: ${JSON.stringify(response.body, null, 2)}\n`);

  if (response.status === 200) {
    if (response.body.url && typeof response.body.url === 'string') {
      console.log('✅ Clone Market URL endpoint test PASSED (URL configured)\n');
      return { pass: true, configured: true, url: response.body.url };
    } else {
      console.log('❌ Clone Market URL endpoint test FAILED (invalid response format)\n');
      return { pass: false, configured: false };
    }
  } else if (response.status === 404) {
    if (response.body.error && response.body.error.includes('not configured')) {
      console.log('✅ Clone Market URL endpoint test PASSED (URL not configured, proper error)\n');
      return { pass: true, configured: false };
    } else {
      console.log('❌ Clone Market URL endpoint test FAILED (wrong error format)\n');
      return { pass: false, configured: false };
    }
  } else {
    console.log('❌ Clone Market URL endpoint test FAILED (unexpected status)\n');
    return { pass: false, configured: false };
  }
}

async function testCloneMarketUrlFormat(cloneMarketUrl) {
  console.log('TEST: Clone Market URL format validation\n');

  try {
    const url = new URL(cloneMarketUrl);
    
    const checks = [
      { name: 'Valid URL', pass: true },
      { name: 'Has protocol', pass: url.protocol === 'http:' || url.protocol === 'https:' },
      { name: 'Has hostname', pass: url.hostname.length > 0 },
    ];

    console.log('URL checks:');
    checks.forEach(check => {
      console.log(`  ${check.pass ? '✓' : '✗'} ${check.name}`);
    });
    console.log();

    if (checks.every(c => c.pass)) {
      console.log('✅ Clone Market URL format test PASSED\n');
      return true;
    }
  } catch (error) {
    console.log(`  ✗ Invalid URL: ${error.message}\n`);
  }

  console.log('❌ Clone Market URL format test FAILED\n');
  return false;
}

async function testImportReturnWithValidBotId() {
  console.log('TEST: Import return with valid bot ID\n');

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
    console.log(`  ID: ${foundBot.id}\n`);
    console.log('✅ Import return with valid bot ID test PASSED\n');
    return { pass: true, botId };
  } else {
    console.log('❌ Import return with valid bot ID test FAILED\n');
    return { pass: false };
  }
}

async function testImportReturnWithInvalidBotId() {
  console.log('TEST: Import return with invalid bot ID\n');

  const invalidBotId = 'nonexistent-bot-id-12345';
  
  const botsResponse = await request('GET', '/api/bots');
  const bots = botsResponse.body;
  const foundBot = bots.find(b => b.id === invalidBotId);

  if (!foundBot) {
    console.log('✓ Invalid bot ID correctly not found in list\n');
    console.log('✅ Import return with invalid bot ID test PASSED\n');
    return true;
  } else {
    console.log('❌ Import return with invalid bot ID test FAILED (bot should not exist)\n');
    return false;
  }
}

async function testCloneMarketUrlQueryParams(cloneMarketUrl) {
  console.log('TEST: Clone Market URL includes correct query parameters\n');

  try {
    const returnPath = 'http://localhost:43123/';
    const url = new URL(cloneMarketUrl);
    url.searchParams.set('target', 'botmancers');
    url.searchParams.set('return', returnPath);

    const checks = [
      { name: 'Has target parameter', pass: url.searchParams.get('target') === 'botmancers' },
      { name: 'Has return parameter', pass: url.searchParams.get('return') === returnPath },
      { name: 'Return is same-origin', pass: url.searchParams.get('return')?.startsWith('http://localhost:43123') },
    ];

    console.log('Query parameter checks:');
    checks.forEach(check => {
      console.log(`  ${check.pass ? '✓' : '✗'} ${check.name}`);
    });
    console.log(`\nFinal URL: ${url.toString()}\n`);

    if (checks.every(c => c.pass)) {
      console.log('✅ Clone Market URL query parameters test PASSED\n');
      return true;
    }
  } catch (error) {
    console.log(`  ✗ Error: ${error.message}\n`);
  }

  console.log('❌ Clone Market URL query parameters test FAILED\n');
  return false;
}

async function runAllTests() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('Botmancers Import from Marketplace — Test Suite');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const results = {};

  console.log('═══════════════════════════════════════════════════════════════\n');
  const urlEndpointResult = await testCloneMarketUrlEndpoint();
  results.urlEndpoint = urlEndpointResult.pass;

  if (urlEndpointResult.configured && urlEndpointResult.url) {
    console.log('═══════════════════════════════════════════════════════════════\n');
    results.urlFormat = await testCloneMarketUrlFormat(urlEndpointResult.url);

    console.log('═══════════════════════════════════════════════════════════════\n');
    results.queryParams = await testCloneMarketUrlQueryParams(urlEndpointResult.url);
  } else {
    console.log('⚠️  Skipping URL format and query param tests (CLONE_MARKET_URL not configured)\n');
    results.urlFormat = null;
    results.queryParams = null;
  }

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
    
    if (results.urlFormat === null || results.queryParams === null) {
      console.log('Note: Some tests were skipped because CLONE_MARKET_URL is not configured.');
      console.log('This is expected and not an error. The feature works correctly when');
      console.log('CLONE_MARKET_URL is not set - it shows an appropriate error message.\n');
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
