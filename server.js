// server.js - Production WebSocket Server for OpenAI Realtime API
const http = require('http');
const WebSocket = require('ws');
const https = require('https');
const { v4: uuidv4 } = require('uuid');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 3000;

console.log('🚀 Starting Voice Server...');
console.log('🔑 OPENAI_API_KEY configured:', OPENAI_API_KEY ? 'YES' : 'NO');

if (!OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY not configured');
  console.error('Set it with: export OPENAI_API_KEY="your-key-here"');
  process.exit(1);
}

// Create ephemeral token for Realtime API
async function getRealtimeToken() {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      model: 'gpt-4o-realtime-preview-2024-12-17', // Updated to latest model
      voice: 'alloy'
    });

    const options = {
      hostname: 'api.openai.com',
      port: 443,
      path: '/v1/realtime/sessions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'OpenAI-Beta': 'realtime=v1'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(data);
            console.log('✅ Ephemeral token generated');
            resolve(json.client_secret.value);
          } catch (e) {
            reject(new Error('Failed to parse token response'));
          }
        } else {
          reject(new Error(`Token request failed: ${res.statusCode}`));
        }
      });
    });

    req.on('error', (e) => {
      reject(e);
    });

    req.write(postData);
    req.end();
  });
}

// Create HTTP server
const server = http.createServer((req, res) => {
  // CORS headers for all responses
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'ok', 
      service: 'voice-server',
      timestamp: new Date().toISOString()
    }));
  } else if (req.url === '/test') {
    // Test endpoint to verify OpenAI connection
    getRealtimeToken()
      .then(token => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          status: 'success', 
          message: 'OpenAI Realtime API is accessible',
          token_preview: token.substring(0, 20) + '...'
        }));
      })
      .catch(error => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          status: 'error', 
          message: error.message 
        }));
      });
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OpenAI Realtime Voice Server\n\nEndpoints:\n- /health - Server status\n- /test - Test OpenAI connection\n\nConnect via WebSocket: ws://' + req.headers.host);
  }
});

// Create WebSocket server
const wss = new WebSocket.Server({ 
  server,
  // Handle CORS for WebSocket connections
  handleProtocols: (protocols) => {
    return 'realtime';
  }
});

wss.on('connection', async (clientSocket, req) => {
  const clientId = uuidv4().substring(0, 8);
  console.log(`\n📞 [${clientId}] New client connected from ${req.socket.remoteAddress}`);
  
  let openaiWs = null;
  let sessionReady = false;
  
  try {
    // Get ephemeral token
    console.log(`🔑 [${clientId}] Requesting ephemeral token...`);
    const ephemeralToken = await getRealtimeToken();
    console.log(`✅ [${clientId}] Token received`);
    
    // Connect to OpenAI Realtime API
    const openaiUrl = 'wss://api.openai.com/v1/realtime';
    
    console.log(`🔌 [${clientId}] Connecting to OpenAI...`);
    openaiWs = new WebSocket(openaiUrl, {
      headers: {
        'Authorization': `Bearer ${ephemeralToken}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });
    
    // OpenAI WebSocket event handlers
    openaiWs.on('open', () => {
      console.log(`✅ [${clientId}] Connected to OpenAI Realtime API`);
      
      // Send session configuration
      const sessionConfig = {
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: 'You are a helpful, friendly voice assistant. Keep responses natural and conversational. Be concise (1-2 sentences).',
          voice: 'alloy', // alloy, echo, fable, onyx, nova, shimmer
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          input_audio_transcription: {
            model: 'whisper-1',
            language: 'en'
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,           // Lower = more sensitive (0.3-0.7)
            prefix_padding_ms: 300,   // Audio before speech starts
            silence_duration_ms: 500  // Wait time after speech ends
          },
          temperature: 0.8,
          max_response_output_tokens: 1000
        }
      };
      
      openaiWs.send(JSON.stringify(sessionConfig));
      console.log(`⚙️ [${clientId}] Session configuration sent`);
      
      // Notify client
      clientSocket.send(JSON.stringify({
        type: 'connection.established',
        status: 'connected_to_openai',
        timestamp: new Date().toISOString()
      }));
    });
    
    openaiWs.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        
        // Handle session events
        if (message.type === 'session.created') {
          console.log(`📋 [${clientId}] Session created: ${message.session?.id}`);
        }
        
        if (message.type === 'session.updated') {
          if (message.session?.status === 'ready') {
            sessionReady = true;
            console.log(`✅ [${clientId}] Session ready - VAD is active`);
            
            // Send initial greeting
            setTimeout(() => {
              if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                openaiWs.send(JSON.stringify({
                  type: 'response.create',
                  response: {
                    modalities: ['text', 'audio'],
                    instructions: 'Greet the user in a friendly, welcoming tone. Say "Hello! I\'m ready to help. What would you like to talk about?"'
                  }
                }));
              }
            }, 500);
          }
        }
        
        // Handle VAD events
        if (message.type === 'input_audio_buffer.speech_started') {
          console.log(`🎤 [${clientId}] User started speaking`);
          clientSocket.send(JSON.stringify({
            type: 'vad',
            status: 'speaking'
          }));
        }
        
        if (message.type === 'input_audio_buffer.speech_stopped') {
          console.log(`🎤 [${clientId}] User stopped speaking`);
          clientSocket.send(JSON.stringify({
            type: 'vad',
            status: 'silent'
          }));
        }
        
        // Handle audio from OpenAI
        if (message.type === 'response.audio.delta' && message.delta) {
          // Forward audio chunk to client
          clientSocket.send(JSON.stringify({
            type: 'audio',
            data: message.delta
          }));
        }
        
        // Handle transcription
        if (message.type === 'conversation.item.input_audio_transcription.completed') {
          console.log(`📝 [${clientId}] User said: "${message.transcript}"`);
          clientSocket.send(JSON.stringify({
            type: 'transcript',
            role: 'user',
            text: message.transcript
          }));
        }
        
        if (message.type === 'response.audio_transcript.delta') {
          // Stream AI text response
          clientSocket.send(JSON.stringify({
            type: 'response_text_delta',
            text: message.delta
          }));
        }
        
        if (message.type === 'response.audio_transcript.done') {
          console.log(`🤖 [${clientId}] AI said: "${message.transcript}"`);
          clientSocket.send(JSON.stringify({
            type: 'transcript',
            role: 'assistant',
            text: message.transcript
          }));
        }
        
        // Handle response completion
        if (message.type === 'response.done') {
          console.log(`✅ [${clientId}] Response completed`);
          clientSocket.send(JSON.stringify({
            type: 'response_done'
          }));
        }
        
        // Handle errors
        if (message.type === 'error') {
          console.error(`❌ [${clientId}] OpenAI error:`, message.error);
          clientSocket.send(JSON.stringify({
            type: 'error',
            message: message.error?.message || 'Unknown error'
          }));
        }
        
      } catch (error) {
        console.error(`❌ [${clientId}] Error processing OpenAI message:`, error);
      }
    });
    
    openaiWs.on('error', (error) => {
      console.error(`❌ [${clientId}] OpenAI WebSocket error:`, error.message);
      clientSocket.send(JSON.stringify({
        type: 'error',
        message: `OpenAI connection error: ${error.message}`
      }));
    });
    
    openaiWs.on('close', (code, reason) => {
      console.log(`🔴 [${clientId}] OpenAI connection closed: ${code} - ${reason.toString()}`);
      clientSocket.send(JSON.stringify({
        type: 'connection_closed',
        message: 'OpenAI connection lost'
      }));
      clientSocket.close();
    });
    
  } catch (error) {
    console.error(`❌ [${clientId}] Setup error:`, error.message);
    clientSocket.send(JSON.stringify({
      type: 'error',
      message: `Server setup failed: ${error.message}`
    }));
    clientSocket.close();
    return;
  }
  
  // Handle messages from client
  clientSocket.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      // Forward audio data to OpenAI
      if (message.type === 'audio' && message.data) {
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: message.data
          }));
        }
      }
      
      // Handle client commands
      else if (message.type === 'start') {
        console.log(`▶️ [${clientId}] Client requested start`);
        clientSocket.send(JSON.stringify({
          type: 'status',
          message: 'Ready - start speaking'
        }));
      }
      
      else if (message.type === 'stop') {
        console.log(`⏹️ [${clientId}] Client requested stop`);
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({
            type: 'input_audio_buffer.commit'
          }));
        }
      }
      
    } catch (error) {
      console.error(`❌ [${clientId}] Error processing client message:`, error);
    }
  });
  
  clientSocket.on('close', () => {
    console.log(`🔴 [${clientId}] Client disconnected`);
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });
  
  clientSocket.on('error', (error) => {
    console.error(`❌ [${clientId}] Client WebSocket error:`, error);
  });
  
  // Send welcome message
  clientSocket.send(JSON.stringify({
    type: 'connected',
    clientId: clientId,
    timestamp: new Date().toISOString(),
    message: 'Connected to voice server'
  }));
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Server running on port ${PORT}`);
  console.log(`🌐 HTTP: http://localhost:${PORT}`);
  console.log(`🔗 WebSocket: ws://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🔍 Test endpoint: http://localhost:${PORT}/test`);
  console.log('\n🎤 Ready for voice connections...');
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🔴 Shutting down server...');
  wss.close(() => {
    console.log('WebSocket server closed');
    server.close(() => {
      console.log('HTTP server closed');
      process.exit(0);
    });
  });
});
