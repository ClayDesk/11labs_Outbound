import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import Twilio from "twilio";
import { v4 as uuidv4 } from "uuid";

// Load environment variables from .env file
dotenv.config();

const {
  ELEVENLABS_AGENT_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  NODE_ENV = "development",
} = process.env;

// Check for the required environment variables
if (!ELEVENLABS_AGENT_ID || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
  console.error("Missing required environment variables");
  process.exit(1);
}

// Initialize Fastify server with enhanced configuration
const fastify = Fastify({
  logger: {
    level: NODE_ENV === "production" ? "info" : "debug",
    prettyPrint: NODE_ENV === "development",
  },
  trustProxy: true, // For proper IP handling behind proxies
});

fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Call rate limiter
const rateLimiter = {
  maxCallsPerMinute: 10,
  callTimestamps: [],
};

function canMakeCall() {
  const now = Date.now();
  // Remove timestamps older than 1 minute
  rateLimiter.callTimestamps = rateLimiter.callTimestamps.filter(t => now - t < 60000);
  return rateLimiter.callTimestamps.length < rateLimiter.maxCallsPerMinute;
}

function recordCallAttempt() {
  rateLimiter.callTimestamps.push(Date.now());
}
// Initialize Twilio client
const twilioClient = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Enhanced call analytics tracking with call sessions
const callAnalytics = {
  totalCalls: 0,
  activeCalls: 0,
  failedCalls: 0,
  completedCalls: 0,
  averageCallDuration: 0,
  callSessions: new Map(), // Track individual call sessions
};

// Call session management
class CallSession {
  constructor(callSid, streamSid) {
    this.id = uuidv4();
    this.callSid = callSid;
    this.streamSid = streamSid;
    this.startTime = Date.now();
    this.endTime = null;
    this.duration = 0;
    this.status = "active";
    this.elevenLabsConnected = false;
    this.messagesExchanged = 0;
  }

  end() {
    this.endTime = Date.now();
    this.duration = this.endTime - this.startTime;
    this.status = "ended";
  }

  markFailed() {
    this.status = "failed";
    this.endTime = Date.now();
    this.duration = this.endTime - this.startTime;
  }

  incrementMessages() {
    this.messagesExchanged++;
  }

  setElevenLabsConnected(connected) {
    this.elevenLabsConnected = connected;
  }
}

function trackCallStart(callSid, streamSid) {
  callAnalytics.totalCalls++;
  callAnalytics.activeCalls++;
  
  const session = new CallSession(callSid, streamSid);
  callAnalytics.callSessions.set(callSid, session);
  
  console.log(`[Analytics] Call started. Active: ${callAnalytics.activeCalls}, Total: ${callAnalytics.totalCalls}, CallSid: ${callSid}`);
  return session;
}

function trackCallEnd(callSid) {
  callAnalytics.activeCalls--;
  callAnalytics.completedCalls++;
  
  const session = callAnalytics.callSessions.get(callSid);
  if (session) {
    session.end();
    // Update average call duration
    const totalDuration = Array.from(callAnalytics.callSessions.values())
      .filter(s => s.duration > 0)
      .reduce((sum, s) => sum + s.duration, 0);
    const completedCalls = Array.from(callAnalytics.callSessions.values())
      .filter(s => s.duration > 0).length;
    
    callAnalytics.averageCallDuration = completedCalls > 0 ? totalDuration / completedCalls : 0;
  }
  
  console.log(`[Analytics] Call ended. Active: ${callAnalytics.activeCalls}, Completed: ${callAnalytics.completedCalls}`);
}

function trackCallFailed(callSid) {
  callAnalytics.failedCalls++;
  callAnalytics.activeCalls--;
  
  const session = callAnalytics.callSessions.get(callSid);
  if (session) {
    session.markFailed();
  }
  
  console.log(`[Analytics] Call failed. Total failures: ${callAnalytics.failedCalls}`);
}

function cleanupOldSessions(maxAge = 24 * 60 * 60 * 1000) { // 24 hours default
  const now = Date.now();
  let cleaned = 0;
  
  for (const [callSid, session] of callAnalytics.callSessions.entries()) {
    if (session.endTime && (now - session.endTime) > maxAge) {
      callAnalytics.callSessions.delete(callSid);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`[Analytics] Cleaned up ${cleaned} old call sessions`);
  }
}

// Schedule session cleanup every hour
setInterval(() => cleanupOldSessions(), 60 * 60 * 1000);

const PORT = process.env.PORT || 8000;

// Enhanced health check with system info
fastify.get("/", async (_, reply) => {
  const healthInfo = {
    status: "healthy",
    message: "Server is running",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    callAnalytics: {
      totalCalls: callAnalytics.totalCalls,
      activeCalls: callAnalytics.activeCalls,
      failedCalls: callAnalytics.failedCalls,
      completedCalls: callAnalytics.completedCalls,
      averageCallDuration: Math.round(callAnalytics.averageCallDuration / 1000), // in seconds
    },
  };
  reply.send(healthInfo);
});

// Enhanced analytics endpoint
fastify.get("/analytics", async (_, reply) => {
  const activeSessions = Array.from(callAnalytics.callSessions.values())
    .filter(session => session.status === "active")
    .map(session => ({
      callSid: session.callSid,
      duration: Date.now() - session.startTime,
      messagesExchanged: session.messagesExchanged,
      elevenLabsConnected: session.elevenLabsConnected,
    }));

  const analytics = {
    ...callAnalytics,
    activeSessions,
    // Convert Map to Array for JSON serialization
    recentSessions: Array.from(callAnalytics.callSessions.values())
      .filter(session => session.status !== "active")
      .sort((a, b) => b.endTime - a.endTime)
      .slice(0, 10) // Last 10 sessions
      .map(session => ({
        callSid: session.callSid,
        duration: session.duration,
        status: session.status,
        messagesExchanged: session.messagesExchanged,
        startTime: new Date(session.startTime).toISOString(),
        endTime: session.endTime ? new Date(session.endTime).toISOString() : null,
      })),
  };

  reply.send(analytics);
});

// Route to get specific call session details
fastify.get("/analytics/call/:callSid", async (request, reply) => {
  const { callSid } = request.params;
  const session = callAnalytics.callSessions.get(callSid);
  
  if (!session) {
    return reply.status(404).send({ error: "Call session not found" });
  }
  
  reply.send(session);
});

// Enhanced incoming call handler with error handling
fastify.all("/incoming-call-eleven", async (request, reply) => {
  try {
    // Generate TwiML response to connect the call to a WebSocket stream
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${request.headers.host}/media-stream" />
        </Connect>
      </Response>`;

    reply.type("text/xml").send(twimlResponse);
  } catch (error) {
    console.error("[Error] Incoming call handler:", error);
    reply.status(500).type("text/xml").send(
      `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Say>Sorry, we are experiencing technical difficulties. Please try again later.</Say>
        <Hangup/>
      </Response>`
    );
  }
});

// Enhanced WebSocket route for handling media streams
fastify.register(async (fastifyInstance) => {
  fastifyInstance.get("/media-stream", { websocket: true }, (connection, req) => {
    console.info("[Server] Twilio connected to media stream.");

    let streamSid = null;
    let callSid = null;
    let callSession = null;

    // Connect to ElevenLabs Conversational AI WebSocket
    const elevenLabsWs = new WebSocket(
      `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${ELEVENLABS_AGENT_ID}`,
      {
        headers: {
          'User-Agent': 'Twilio-ElevenLabs-Integration/1.0'
        }
      }
    );

    elevenLabsWs.on("open", () => {
      console.log("[ElevenLabs] Connected to Conversational AI.");
      if (callSession) {
        callSession.setElevenLabsConnected(true);
      }
    });

    elevenLabsWs.on("message", (data) => {
      try {
        const message = JSON.parse(data);
        handleElevenLabsMessage(message, connection);
        
        // Track message exchange
        if (callSession && (message.type === "audio" || message.type === "conversation_initiation_metadata")) {
          callSession.incrementMessages();
        }
      } catch (error) {
        console.error("[ElevenLabs] Error parsing message:", error);
      }
    });

    elevenLabsWs.on("error", (error) => {
      console.error("[ElevenLabs] WebSocket error:", error);
      trackCallFailed(callSid);
    });

    elevenLabsWs.on("close", (code, reason) => {
      console.log(`[ElevenLabs] Disconnected. Code: ${code}, Reason: ${reason}`);
      if (callSession) {
        callSession.setElevenLabsConnected(false);
      }
    });

    const handleElevenLabsMessage = (message, connection) => {
      switch (message.type) {
        case "conversation_initiation_metadata":
          console.info("[ElevenLabs] Received conversation initiation metadata.");
          break;
        case "audio":
          if (message.audio_event?.audio_base_64) {
            const audioData = {
              event: "media",
              streamSid,
              media: {
                payload: message.audio_event.audio_base_64,
              },
            };
            if (connection.socket.readyState === WebSocket.OPEN) {
              connection.send(JSON.stringify(audioData));
            }
          }
          break;
        case "interruption":
          if (connection.socket.readyState === WebSocket.OPEN) {
            connection.send(JSON.stringify({ event: "clear", streamSid }));
          }
          break;
        case "ping":
          if (message.ping_event?.event_id) {
            const pongResponse = {
              type: "pong",
              event_id: message.ping_event.event_id,
            };
            if (elevenLabsWs.readyState === WebSocket.OPEN) {
              elevenLabsWs.send(JSON.stringify(pongResponse));
            }
          }
          break;
        case "error":
          console.error("[ElevenLabs] Received error:", message.error);
          break;
        default:
          console.log(`[ElevenLabs] Received unhandled message type: ${message.type}`);
      }
    };

    connection.on("message", async (message) => {
      try {
        const data = JSON.parse(message);
        switch (data.event) {
          case "start":
            streamSid = data.start.streamSid;
            callSid = data.start.callSid;
            callSession = trackCallStart(callSid, streamSid);
            console.log(`[Twilio] Stream started with ID: ${streamSid}, CallSid: ${callSid}`);
            break;
          case "media":
            if (elevenLabsWs.readyState === WebSocket.OPEN) {
              const audioMessage = {
                user_audio_chunk: Buffer.from(data.media.payload, "base64").toString("base64"),
              };
              elevenLabsWs.send(JSON.stringify(audioMessage));
              
              if (callSession) {
                callSession.incrementMessages();
              }
            }
            break;
          case "stop":
            console.log(`[Twilio] Stream stopped for CallSid: ${callSid}`);
            if (callSession) {
              trackCallEnd(callSid);
            }
            elevenLabsWs.close();
            break;
          case "mark":
            // Handle markers if needed
            console.log(`[Twilio] Marker received: ${data.mark.name}`);
            break;
          default:
            console.log(`[Twilio] Received unhandled event: ${data.event}`);
        }
      } catch (error) {
        console.error("[Twilio] Error processing message:", error);
      }
    });

    connection.on("close", () => {
      console.log(`[Twilio] Client disconnected for CallSid: ${callSid}`);
      if (callSession) {
        trackCallEnd(callSid);
      }
      elevenLabsWs.close();
    });

    connection.on("error", (error) => {
      console.error(`[Twilio] WebSocket error for CallSid: ${callSid}:`, error);
      if (callSession) {
        trackCallFailed(callSid);
      }
      elevenLabsWs.close();
    });
  });
});

// Enhanced outbound call with input validation
fastify.post("/make-outbound-call", async (request, reply) => {
  const { to, from = TWILIO_PHONE_NUMBER } = request.body;

  // Input validation
  if (!to) {
    return reply.status(400).send({ error: "Destination phone number is required" });
  }

  // Basic phone number validation
  const phoneRegex = /^\+?[1-9]\d{1,14}$/;
  if (!phoneRegex.test(to)) {
    return reply.status(400).send({ error: "Invalid destination phone number format" });
  }

  try {
    const call = await twilioClient.calls.create({
      url: `https://${request.headers.host}/incoming-call-eleven`,
      to: to,
      from: from,
      statusCallback: `https://${request.headers.host}/call-status`, // Optional: for status updates
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      timeout: 30, // 30 seconds timeout
    });

    console.log(`[Twilio] Outbound call initiated: ${call.sid} to ${to}`);
    reply.send({ 
      message: "Call initiated", 
      callSid: call.sid,
      status: call.status,
      from: call.from,
      to: call.to
    });
  } catch (error) {
    console.error("[Twilio] Error initiating call:", error);
    trackCallFailed(); // Track failed call attempt
    
    let errorMessage = "Failed to initiate call";
    let statusCode = 500;
    
    // More specific error handling
    if (error.code === 21211) {
      errorMessage = "Invalid phone number format";
      statusCode = 400;
    } else if (error.code === 21421) {
      errorMessage = "Twilio phone number not verified for this destination";
      statusCode = 400;
    }
    
    reply.status(statusCode).send({ error: errorMessage, details: error.message });
  }
});

// Optional: Call status webhook for tracking call lifecycle
fastify.post("/call-status", async (request, reply) => {
  const { CallSid, CallStatus } = request.body;
  console.log(`[Twilio] Call ${CallSid} status: ${CallStatus}`);
  
  // You can add more sophisticated status tracking here
  reply.send({ status: "received" });
});

// Graceful shutdown handler
const gracefulShutdown = async (signal) => {
  console.log(`\n[Server] Received ${signal}. Starting graceful shutdown...`);
  
  try {
    // Close Fastify server
    await fastify.close();
    console.log("[Server] HTTP server closed.");
    
    // Additional cleanup can go here
    
    console.log("[Server] Graceful shutdown completed.");
    process.exit(0);
  } catch (error) {
    console.error("[Server] Error during shutdown:", error);
    process.exit(1);
  }
};

// Handle various shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGUSR2', () => gracefulShutdown('SIGUSR2')); // For nodemon

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('[Server] Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Server] Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Start the Fastify server
fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error("Error starting server:", err);
    process.exit(1);
  }
  console.log(`[Server] Listening on port ${PORT}`);
  console.log(`[Server] Environment: ${NODE_ENV}`);
  console.log(`[Server] Health check: http://localhost:${PORT}/`);
  console.log(`[Server] Analytics: http://localhost:${PORT}/analytics`);
});

