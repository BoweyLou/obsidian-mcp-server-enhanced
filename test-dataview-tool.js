#!/usr/bin/env node

// Test script to verify the Dataview query tool is working
import https from 'https';

const API_KEY = '9ff227bd9a3700574d08b33044d7ba1d426431fa457ded7d4594c63affc3b2b4';
const BASE_URL = 'https://yannicks-mac-mini.tail9cf43d.ts.net/mcp';

async function makeRequest(data, sessionId = null) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Authorization': API_KEY
  };
  
  if (sessionId) {
    headers['Mcp-Session-Id'] = sessionId;
  }

  const postData = JSON.stringify(data);
  
  return new Promise((resolve, reject) => {
    const req = https.request(BASE_URL, {
      method: 'POST',
      headers: headers
    }, (res) => {
      let responseData = '';
      
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      
      res.on('end', () => {
        try {
          // Handle SSE format
          if (responseData.startsWith('event: message')) {
            const jsonPart = responseData.split('data: ')[1];
            resolve(JSON.parse(jsonPart));
          } else {
            resolve(JSON.parse(responseData));
          }
        } catch (error) {
          console.log('Raw response:', responseData);
          reject(error);
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.write(postData);
    req.end();
  });
}

async function testDataviewTool() {
  console.log('🧪 Testing Dataview Query Tool...\n');
  
  try {
    // Step 1: Initialize session
    console.log('1. Initializing MCP session...');
    const initResponse = await makeRequest({
      jsonrpc: '2.0',
      method: 'initialize',
      id: 1,
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'dataview-test', version: '1.0.0' }
      }
    });
    
    console.log('✅ Session initialized');
    console.log(`   Server: ${initResponse.result.serverInfo.name} v${initResponse.result.serverInfo.version}`);
    
    // Step 2: List tools to verify dataview tool is there
    console.log('\n2. Listing available tools...');
    const toolsResponse = await makeRequest({
      jsonrpc: '2.0',
      method: 'tools/list',
      id: 2
    });
    
    const tools = toolsResponse.result.tools;
    console.log(`✅ Found ${tools.length} tools:`);
    
    const dataviewTool = tools.find(tool => tool.name === 'obsidian_dataview_query');
    if (dataviewTool) {
      console.log('🎯 obsidian_dataview_query tool found!');
      console.log(`   Description: ${dataviewTool.description.substring(0, 100)}...`);
    } else {
      console.log('❌ obsidian_dataview_query tool NOT found');
      console.log('Available tools:', tools.map(t => t.name));
      return;
    }
    
    // Step 3: Test a simple Dataview query
    console.log('\n3. Testing Dataview query execution...');
    try {
      const queryResponse = await makeRequest({
        jsonrpc: '2.0',
        method: 'tools/call',
        id: 3,
        params: {
          name: 'obsidian_dataview_query',
          arguments: {
            query: 'TABLE file.name FROM "Daily Notes" LIMIT 3',
            format: 'list'
          }
        }
      });
      
      console.log('✅ Dataview query executed successfully!');
      const result = JSON.parse(queryResponse.result.content[0].text);
      console.log(`   Query: ${result.query}`);
      console.log(`   Results: ${result.resultCount} items`);
      console.log(`   Execution time: ${result.executionTime}`);
      
      if (result.success) {
        console.log('🎉 Dataview query tool is working perfectly!');
      } else {
        console.log('⚠️  Query execution failed (might be expected if no Dataview plugin)');
        console.log(`   Error: ${result.error}`);
      }
      
    } catch (queryError) {
      console.log('❌ Dataview query test failed:', queryError.message);
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

// Run the test
testDataviewTool().then(() => {
  console.log('\n✅ Dataview tool test completed!');
}).catch((err) => {
  console.error('\n❌ Test suite failed:', err.message);
});