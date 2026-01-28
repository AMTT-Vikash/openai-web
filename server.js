// Production WebSocket Server for OpenAI Realtime API
// Handles ephemeral token generation and WebSocket proxying

const http = require('http');
const WebSocket = require('ws');
const https = require('https');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 3000;

console.log('🔑 OPENAI_API_KEY configured:', OPENAI_API_KEY ? 'YES' : 'NO');

if (!OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY not configured');
  process.exit(1);
}

// Create ephemeral token for Realtime API
async function getRealtimeToken() {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      model: 'gpt-4o-realtime-preview-2024-10-01',
      voice: 'alloy'
    });

    const options = {
      hostname: 'api.openai.com',
      path: '/v1/realtime/sessions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
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
            console.log('✅ Got ephemeral token');
            resolve(json.client_secret.value);
          } catch (e) {
            reject(new Error('Failed to parse token response: ' + e.message));
          }
        } else {
          reject(new Error(`Token request failed: ${res.statusCode} - ${data}`));
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
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'voice-streaming' }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OpenAI Realtime Voice Server');
  }
});

// Create WebSocket server
const wss = new WebSocket.Server({ server });

wss.on('connection', async (clientSocket, req) => {
  console.log('📞 Client connected');
  
  // Parse user email from URL
  const url = new URL(req.url, `http://${req.headers.host}`);
  const userEmail = url.searchParams.get('user_email') || 'anonymous';
  console.log('👤 User:', userEmail);
  
  let openaiWs = null;
  let sessionReady = false;
  let audioChunkCount = 0;
  
  try {
    // Get ephemeral token
    console.log('🔑 Requesting ephemeral token...');
    const ephemeralToken = await getRealtimeToken();
    console.log('✅ Ephemeral token received');
    
    // Connect to OpenAI Realtime API with ephemeral token
    const openaiUrl = `wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01`;
    
    console.log('🔌 Connecting to OpenAI Realtime API...');
    openaiWs = new WebSocket(openaiUrl, {
      headers: {
        'Authorization': `Bearer ${ephemeralToken}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });
    
    // OpenAI WebSocket handlers
    openaiWs.on('open', () => {
      console.log('✅ Connected to OpenAI Realtime API');
      
      // Configure session - Use server VAD with sensitive settings
      const sessionConfig = {
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: 'You are Life AI, a warm and conversational AI companion. Keep responses concise (1-3 sentences) unless asked for more. Be natural, friendly, and helpful.',
          voice: 'alloy',
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          input_audio_transcription: {
            model: 'whisper-1'
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.3,  // More sensitive
            prefix_padding_ms: 300,
            silence_duration_ms: 500  // Shorter silence = faster response
          },
          temperature: 0.8,
          max_response_output_tokens: 4096
        }
      };
      
      openaiWs.send(JSON.stringify(sessionConfig));
      console.log('📤 Session configuration sent with server VAD');
      
      // Notify client
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(JSON.stringify({
          type: 'connection.established',
          status: 'connected'
        }));
      }
    });
    
    openaiWs.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        
        // Log ALL events for debugging
        console.log('📨 OpenAI Event:', message.type);
        
        // Session events
        if (message.type === 'session.created') {
          console.log('✅ Session created');
        } else if (message.type === 'session.updated') {
          console.log('✅ Session updated - VAD enabled, ready for conversation');
          sessionReady = true;
          
          // Send initial greeting AFTER session is ready
          setTimeout(() => {
            if (openaiWs.readyState === WebSocket.OPEN) {
              console.log('📤 Triggering greeting response...');
              openaiWs.send(JSON.stringify({
                type: 'response.create',
                response: {
                  modalities: ['text', 'audio'],
                  instructions: 'Say "Hello! I\'m listening. How can I help you today?" in a warm, friendly tone.'
                }
              }));
            }
          }, 100);
        }
        
        // VAD events
        else if (message.type === 'input_audio_buffer.speech_started') {
          console.log('🎤 User started speaking');
          audioChunkCount = 0;
        } else if (message.type === 'input_audio_buffer.speech_stopped') {
          console.log('🎤 User stopped speaking - VAD will auto-respond');
        } else if (message.type === 'input_audio_buffer.committed') {
          console.log('✅ Audio committed by VAD');
        }
        
        // Transcription events
        else if (message.type === 'conversation.item.input_audio_transcription.completed') {
          console.log('📝 User said:', message.transcript || '(empty)');
          if (clientSocket.readyState === WebSocket.OPEN) {
            clientSocket.send(JSON.stringify({
              type: 'transcript',
              role: 'user',
              text: message.transcript || ''
            }));
          }
        }
        
        // Response events
        else if (message.type === 'response.created') {
          console.log('✅ Response created:', message.response?.id);
          audioChunkCount = 0;
        } else if (message.type === 'response.output_item.added') {
          console.log('✅ Output item added');
        } else if (message.type === 'response.content_part.added') {
          console.log('✅ Content part added');
        } else if (message.type === 'response.audio.delta') {
          audioChunkCount++;
          const len = message.delta ? message.delta.length : 0;
          
          if (audioChunkCount === 1 || audioChunkCount % 10 === 0) {
            console.log(`🔊 Audio chunk #${audioChunkCount}: ${len} bytes`);
          }
          
          // Forward audio to client
          if (message.delta && clientSocket.readyState === WebSocket.OPEN) {
            clientSocket.send(JSON.stringify({
              type: 'audio',
              data: message.delta
            }));
          }
        } else if (message.type === 'response.audio.done') {
          console.log(`✅ Audio complete - sent ${audioChunkCount} chunks total`);
        } else if (message.type === 'response.audio_transcript.delta') {
          process.stdout.write(message.delta || '');
        } else if (message.type === 'response.audio_transcript.done') {
          console.log('\n🤖 AI said:', message.transcript);
          if (clientSocket.readyState === WebSocket.OPEN) {
            clientSocket.send(JSON.stringify({
              type: 'transcript',
              role: 'assistant',
              text: message.transcript
            }));
          }
        } else if (message.type === 'response.done') {
          console.log('✅ Response completed');
        }
        
        // Error events
        else if (message.type === 'error') {
          console.error('❌ OpenAI error:', JSON.stringify(message.error));
          if (clientSocket.readyState === WebSocket.OPEN) {
            clientSocket.send(JSON.stringify({
              type: 'error',
              message: message.error?.message || 'Unknown error'
            }));
          }
        }
        
      } catch (e) {
        console.error('❌ Error processing message:', e);
      }
    });
    
    openaiWs.on('error', (error) => {
      console.error('❌ OpenAI WebSocket error:', error.message);
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(JSON.stringify({
          type: 'error',
          message: 'OpenAI connection failed'
        }));
      }
    });
    
    openaiWs.on('close', (code, reason) => {
      console.log('🔴 OpenAI closed:', code, reason.toString());
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.close();
      }
    });
    
  } catch (error) {
    console.error('❌ Setup error:', error.message);
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.send(JSON.stringify({
        type: 'error',
        message: `Setup failed: ${error.message}`
      }));
      clientSocket.close();
    }
    return;
  }
  
  // Client handlers
  clientSocket.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      // Forward audio to OpenAI
      if (message.type === 'audio' && message.data) {
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: message.data
          }));
        }
      }
      
    } catch (e) {
      console.error('❌ Client message error:', e);
    }
  });
  
  clientSocket.on('close', () => {
    console.log('🔴 Client disconnected');
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });
  
  clientSocket.on('error', (error) => {
    console.error('❌ Client error:', error);
  });
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server listening on port ${PORT}`);
  console.log(`🎤 Ready for voice connections`);
});