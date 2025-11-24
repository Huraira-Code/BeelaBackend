const express = require('express');
const router = express.Router();
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager } = require('@google/generative-ai/server');
const { auth } = require('../middleware/authMiddleware');
const Conversation = require('../models/Conversation');
const Reminder = require('../models/reminderModel');
const User = require('../models/userModel');
const fs = require('fs');
const path = require('path');

const { suggestFullScheduleWithGemini } = require('../services/geminiService');

// Initialize Google's Generative AI
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GEMINI_API_KEY);
const fileManager = new GoogleAIFileManager(process.env.GOOGLE_GEMINI_API_KEY);

// Configure multer for file uploads
// Use /tmp directory for serverless environments (Vercel, Lambda, etc.)
const tmpDir = process.env.VERCEL ? '/tmp' : path.join(__dirname, '../uploads');

// Ensure tmp directory exists (only for local development)
if (!process.env.VERCEL && !fs.existsSync(tmpDir)) {
  fs.mkdirSync(tmpDir, { recursive: true });
}

const upload = multer({ 
  dest: tmpDir,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// genAI already initialized above; avoid redeclaration here

// System prompt for the AI assistant
const SYSTEM_PROMPT = `You are Bela, a helpful AI assistant. 
Your main functions are:
1. Answer general questions helpfully and concisely
2. Help users create tasks and meetings
3. Provide productivity tips and suggestions

CRITICAL LANGUAGE RULES:
- You MUST ALWAYS respond in English, regardless of what language the user uses
- If user speaks in any language other than English, understand their intent but respond in English
- For greetings: 
  * If user says "Assalam o alaikum" (or variations), greet with "Walaikum Assalam" and ask how you can assist
  * For all other greetings in any language, greet with "Hi" and ask if they need help with anything

When creating tasks or meetings, you should:
- Ask for any missing information (title, time, date, etc.)
- Confirm details before creating
- Be friendly and professional in all responses
- Always communicate in English only`;

// Chat with the AI assistant
router.post('/chat', auth, upload.single('audio'), async (req, res) => {
  console.log('\n--- New Chat Request ---');
  console.log('Headers:', req.headers);
  console.log('Body:', req.body);
  console.log('File:', req.file);
  console.log('User:', req.user);
  
  let uploadedFilePath = null;
  let geminiFile = null;
  
  try {
    const userId = req.user?.id || req.user?._id;
    
    // Get user's timezone offset (in minutes) from the request
    // Frontend MUST send this as: new Date().getTimezoneOffset()
    // This is critical for correct time conversion across all timezones
    const timezoneOffset = req.body.timezoneOffset;
    
    // Validate timezoneOffset is provided
    if (timezoneOffset === undefined || timezoneOffset === null) {
      console.warn('⚠️ WARNING: timezoneOffset not provided by frontend! Defaulting to 0 (UTC)');
      console.warn('⚠️ This may cause incorrect time conversion for users not in UTC timezone');
    }
    
    const userTimezoneOffset = timezoneOffset || 0;
    console.log(`🌍 User timezone offset: ${userTimezoneOffset} minutes (${userTimezoneOffset > 0 ? 'UTC-' : 'UTC+'}${Math.abs(userTimezoneOffset/60)})`);

    // Get or create conversation
    let conversation = await Conversation.findOne({ userId });
    if (!conversation) {
      conversation = new Conversation({
        userId,
        messages: [] // Don't save system prompt in DB
      });
    }
    
    // Always use the latest system prompt from code, not from DB
    // This ensures all users get the updated prompt even if they have existing conversations

    let message = req.body.message;
    let transcription = '';

    // If audio file is uploaded, process it with Gemini
    if (req.file) {
      console.log('📁 Processing audio file:', req.file.path);
      uploadedFilePath = req.file.path;
      
      try {
        // Upload the audio file to Gemini
        console.log('⬆️ Uploading audio to Gemini...');
        geminiFile = await fileManager.uploadFile(uploadedFilePath, {
          mimeType: req.file.mimetype || 'audio/m4a',
          displayName: 'Voice Input',
        });
        
        console.log('✅ File uploaded to Gemini:', geminiFile.file.uri);

        // Use Gemini to transcribe and understand the audio
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        
        const transcriptionPrompt = `Please transcribe this audio clearly and accurately. Provide only the transcribed text without any additional commentary.`;
        
        const transcriptionResult = await model.generateContent([
          {
            fileData: {
              mimeType: geminiFile.file.mimeType,
              fileUri: geminiFile.file.uri
            }
          },
          { text: transcriptionPrompt }
        ]);
        
        const transcriptionResponse = await transcriptionResult.response;
        transcription = transcriptionResponse.text().trim();
        message = transcription;
        
        console.log('📝 Transcription:', transcription);
        
      } catch (audioError) {
        console.error('❌ Error processing audio:', audioError);
        throw new Error(`Failed to process audio: ${audioError.message}`);
      }
    }

    if (!message || message.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'No message or audio provided'
      });
    }

    // Add user message to conversation
    conversation.messages.push({ role: 'user', content: message });
    
    // Check for pending action first
    if (conversation.pendingAction && conversation.pendingAction.type) {
      console.log('🔔 Pending action exists:', JSON.stringify(conversation.pendingAction, null, 2));
      console.log('🔔 Handling user response:', message);
      
      // Check if user is asking about the pending reminder specifically
      const userIntent = await analyzeUserIntentForPendingAction(message, conversation.pendingAction);
      
      console.log('🤖 User intent for pending action:', userIntent);
      
      if (userIntent.intent === 'unrelated') {
        // User is asking something unrelated to the pending reminder
        console.log('⚠️ User message is unrelated to pending action. Asking for confirmation...');
        
        // Set a flag to track that we've asked about the pending action
        conversation.pendingAction.askedAboutPending = true;
        await conversation.save();
        
        const pendingReminderSummary = getPendingReminderSummary(conversation.pendingAction);
        const response = `I notice you have a pending reminder: **${pendingReminderSummary}**\n\nWould you like to:\n1. Continue creating this reminder\n2. Cancel it and chat about something else\n3. Get more details about this pending reminder\n\nPlease let me know your preference.`;
        
        conversation.messages.push({ role: 'assistant', content: response });
        await conversation.save();
        
        return res.json({
          success: true,
          response: response,
          action: 'pending_reminder_notification',
          data: { pendingReminder: pendingReminderSummary }
        });
      } else if (userIntent.intent === 'continue') {
        // User wants to continue with the pending reminder
        console.log('✅ User wants to continue with pending reminder');
        const result = await handlePendingAction(conversation, message, userId, req.user);
        if (result) {
          conversation.messages.push({ role: 'assistant', content: result.response });
          await conversation.save();
          console.log('✅ Response sent and conversation saved');
          return res.json(result);
        }
      } else if (userIntent.intent === 'cancel') {
        // User wants to cancel the pending reminder
        console.log('❌ User wants to cancel pending reminder');
        conversation.pendingAction = null;
        await conversation.save();
        
        const response = "No problem! I've cancelled the pending reminder. How can I help you today?";
        conversation.messages.push({ role: 'assistant', content: response });
        await conversation.save();
        
        return res.json({
          success: true,
          response: response,
          action: 'pending_reminder_cancelled'
        });
      } else if (userIntent.intent === 'details') {
        // User wants details about the pending reminder
        console.log('ℹ️ User wants details about pending reminder');
        const detailedSummary = getPendingReminderDetailedSummary(conversation.pendingAction);
        const response = `Here are the details of your pending reminder:\n\n${detailedSummary}\n\nWould you like to continue creating this reminder? (Yes/No)`;
        
        conversation.messages.push({ role: 'assistant', content: response });
        await conversation.save();
        
        return res.json({
          success: true,
          response: response,
          action: 'pending_reminder_details',
          data: conversation.pendingAction
        });
      } else {
        // User's message is related to the pending action (answering questions, confirming, etc.)
        console.log('✅ User message is related to pending action. Processing...');
        const result = await handlePendingAction(conversation, message, userId, req.user);
        if (result) {
          conversation.messages.push({ role: 'assistant', content: result.response });
          await conversation.save();
          console.log('✅ Response sent and conversation saved');
          return res.json(result);
        }
      }
    }
const lastAssistantResponse =
  conversation.messages[conversation.messages.length - 1]?.content || '';
    // Detect action from the message
    const action = await detectAction(lastAssistantResponse, message, userId, userTimezoneOffset);
    
    if (action) {
      console.log('🔍 Action detected:', { type: action.type, confirmationNeeded: action.confirmationNeeded });
      
      // If we need to ask about routine scheduling
      if (action.needsRoutineConfirmation) {
        conversation.pendingAction = {
          type: action.type,
          data: action.data,
          needsRoutineConfirmation: true
        };
        await conversation.save();
        
        return res.json({
          success: true,
          response: action.question,
          action: 'needs_routine_confirmation',
          data: action.data
        });
      }
      
      // If we need more info, ask for it
      if (action.needsMoreInfo) {
        conversation.pendingAction = {
          type: action.type,
          data: action.data,
          missingFields: action.missingFields
        };
        await conversation.save();
        
        return res.json({
          success: true,
          response: action.question,
          action: 'needs_info',
          data: { missingFields: action.missingFields }
        });
      }
      
      // If we have all info, confirm before creating
      if (action.confirmationNeeded) {
        conversation.pendingAction = {
          type: action.type,
          data: action.data,
          confirmationNeeded: true
        };
        await conversation.save();
        
        console.log('💾 Pending action saved to conversation:', conversation.pendingAction);
        
        return res.json({
          success: true,
          response: action.confirmationMessage,
          action: 'confirm_action',
          data: action.data
        });
      }
    }

    // If no action or confirmation needed, proceed with normal chat
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    
    // Build conversation history with the LATEST system prompt
    // This ensures even existing users get updated prompt rules
    const conversationHistory = [
      {
        role: 'user',
        parts: [{ text: SYSTEM_PROMPT }]
      },
      ...conversation.messages.map(msg => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }]
      }))
    ];
    
    const chat = model.startChat({
      history: conversationHistory
    });

    // Get response from Gemini with English-only instruction
    const englishInstruction = "\n\nIMPORTANT: You MUST respond in English ONLY, regardless of the language used in the message. If the message is a greeting other than 'Assalam o alaikum', respond with 'Hi'. If it's 'Assalam o alaikum', respond with 'Walaikum Assalam'.";
    const result = await chat.sendMessage(message + englishInstruction);
    const response = await result.response;
    const responseText = response.text();

    // Save assistant's response
    conversation.messages.push({ role: 'assistant', content: responseText });
    await conversation.save();

    // Clean up uploaded files
    if (uploadedFilePath && fs.existsSync(uploadedFilePath)) {
      fs.unlinkSync(uploadedFilePath);
      console.log('🗑️ Cleaned up uploaded file');
    }

    res.json({
      success: true,
      response: responseText,
      transcription: transcription || undefined
    });

  } catch (error) {
    console.error('Error in chat endpoint:', error);
    console.error('\n--- Error in /chat endpoint ---');
    console.error('Error details:', {
      message: error.message,
      stack: error.stack,
      name: error.name,
      code: error.code
    });
    
    // Clean up uploaded files on error
    if (uploadedFilePath && fs.existsSync(uploadedFilePath)) {
      try {
        fs.unlinkSync(uploadedFilePath);
        console.log('🗑️ Cleaned up uploaded file after error');
      } catch (cleanupError) {
        console.error('Error cleaning up file:', cleanupError);
      }
    }
   res.status(500).json({
      success: false,
      message: 'Error processing your request',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get conversation history
router.get('/conversation', auth, async (req, res) => {
  try {
    const conversation = await Conversation.findOne({ userId: req.user.id });
    if (!conversation) {
      return res.json({ messages: [] });
    }
    res.json({ messages: conversation.messages });
  } catch (error) {
    console.error('Error fetching conversation:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching conversation',
      error: error.message
    });
  }
});

// Clear conversation history
router.delete('/conversation', auth, async (req, res) => {
  try {
    await Conversation.deleteOne({ userId: req.user.id });
    res.json({ success: true, message: 'Conversation cleared' });
  } catch (error) {
    console.error('Error clearing conversation:', error);
    res.status(500).json({
      success: false,
      message: 'Error clearing conversation',
      error: error.message
    });
  }
});

// Helper function to use Gemini to intelligently detect user intent and extract details
async function detectActionWithGemini(userMessage, userId, timezoneOffset = 0) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    
    const currentDate = new Date();
    console.log('🌍 Timezone offset for Gemini:', timezoneOffset, 'minutes');
    console.log(`🌍 User timezone: ${timezoneOffset > 0 ? 'UTC-' : 'UTC+'}${Math.abs(timezoneOffset/60)}`);
    
    // IMPORTANT: timezoneOffset is the difference in minutes between UTC and user's local time
    // Returned by JavaScript's new Date().getTimezoneOffset()
    // - Positive values = west of UTC (e.g., EST: +300 = UTC-5)
    // - Negative values = east of UTC (e.g., Pakistan: -300 = UTC+5)
    // - Zero = UTC (e.g., London in winter: 0)
    
    const prompt = `You are an intelligent assistant that analyzes user messages to detect scheduling intents.

CRITICAL: You MUST respond in English ONLY, regardless of the language the user uses. Understand their intent in any language but analyze and respond in English.

Current date and time: ${currentDate.toISOString()} (${currentDate.toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'full', timeStyle: 'short' })})

Analyze this user message: "${userMessage}"

Your task:
1. Detect if the user wants to create a TASK, MEETING, LOCATION reminder, or neither
2. INTELLIGENTLY GENERATE a meaningful title and description based on the user's intent (not just extract words)
3. Calculate the EXACT date and time based on relative terms (tomorrow, next week, etc.)
4. Extract scheduling details (for TASKS: routine patterns; for MEETINGS: just date/time; for LOCATIONS: days)
5. Identify any missing required information

Return a JSON object with this EXACT structure:
{
  "intent": "task" | "meeting" | "location" | "none",
  "data": {
    "title": "GENERATE a clear, concise, professional title that captures the user's intent",
    "description": "GENERATE a helpful description that explains what this is about based on context",
    "date": "YYYY-MM-DD (the date in user's local timezone)",
    "time": "HH:mm (the time in 24-hour format, in user's local timezone)",
    
    // FOR TASKS ONLY (ignore these fields for meetings and locations):
    "isRoutine": boolean (true if daily/weekly/monthly pattern - TASKS ONLY),
    "scheduleType": "one-day" | "routine" | "specific-days" (TASKS ONLY),
    "scheduleDays": ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] (if routine - TASKS ONLY),
    "scheduleTime": {
      "fixedTime": "HH:mm" or null,
      "minutesBeforeStart": number (default 15 for tasks, 10 for meetings)
    },
    
    // FOR LOCATIONS ONLY (ignore these fields for tasks/meetings):
    "locationScheduleDays": [0-6] (array of day numbers: 0=Sunday, 1=Monday, etc. Empty array = daily - REQUIRED for locations, use [] as default)
  },
  "missingFields": ["field1", "field2"] (array of missing required fields),
  "confidence": number (0-100, how confident you are about the detection)
}

IMPORTANT: 
- For MEETINGS, ONLY provide: title, description, date, time, and scheduleTime.minutesBeforeStart
- For LOCATIONS, ONLY provide: title, description, and locationScheduleDays (NO date/time needed!)
- DO NOT include: isRoutine, scheduleType, scheduleDays for meetings
- DO NOT include: date, time, scheduleTime for locations
- For locations, if no specific days mentioned, use locationScheduleDays: [] (empty array means daily)

CRITICAL RULES FOR TITLE & DESCRIPTION:
- CREATE intelligent titles, don't just extract words
- Title should be clear, professional, and action-oriented
- Description should provide context and details about the task/meeting
- Examples:
  * "call John tomorrow" → title: "Call John", description: "Make a phone call to John"
  * "team standup" → title: "Daily Team Standup", description: "Daily team synchronization meeting"
  * "buy groceries" → title: "Buy Groceries", description: "Purchase groceries and household items"
  * "review code" → title: "Code Review", description: "Review and provide feedback on code changes"
  * "gym workout" → title: "Gym Workout Session", description: "Physical fitness and exercise routine"

DATE & TIME CALCULATION RULES:
- IMPORTANT: Return dates and times in the USER'S LOCAL TIMEZONE (not UTC)
- When user says "tomorrow 5pm", calculate tomorrow's date and return time as "17:00"
- The backend will handle timezone conversion to UTC automatically
- If user says "tomorrow", calculate from current date (${currentDate.toLocaleDateString()})
- If user says "tomorrow 5pm" = return date: "${new Date(currentDate.getTime() + 24*60*60*1000).toISOString().split('T')[0]}", time: "17:00"
- If user says "next Monday" = calculate the next Monday from today
- For time: convert "5pm" to "17:00", "9am" to "09:00", "3:30pm" to "15:30"
- Return date as "YYYY-MM-DD" and time as "HH:mm" separately (user's local timezone)
- If no time specified for task, only provide date and use scheduleTime.minutesBeforeStart
- If time IS specified, provide both date and time, and set scheduleTime.fixedTime with HH:mm format
- Mark field as missing ONLY if it's required and truly cannot be inferred

SMART DEFAULTS:
- "team standup" without time → 9:00 AM (typical standup time)
- "lunch meeting" without time → 12:00 PM
- "workout" without time → ask for time (missing field)

MEETINGS ARE SIMPLE:
- Meetings are ALWAYS one-time events
- Only extract: title, description, startDateISO, and notification time
- Example: "meeting tomorrow at 3pm" → just create a simple one-time meeting at 3pm

LOCATIONS ARE FOR PLACE-BASED REMINDERS:
- Detect when user wants to create a location-based reminder for a place
- Keywords: "location for", "location reminder", "remind me at", "when I visit", "when I'm at" or any other phrasing indicating location-based reminder you can detect
- Extract ONLY: title, description, locationScheduleDays (NO date/time/address needed!)
- **NEVER ask for address** - location reminders only need title, description, and optional scheduleDays
- locationScheduleDays format: array of numbers 0-6 (0=Sunday, 1=Monday, etc.), empty array = daily
- **DEFAULT**: If no days specified, use locationScheduleDays: [] (empty array means daily/always active)
- **DO NOT mark any fields as missing** - title and description can be generated from user's message, locationScheduleDays defaults to []
- Examples:
  * "location for ABC shop" → intent: "location", title: "ABC Shop Location", description: "Location reminder for ABC shop", locationScheduleDays: [], missingFields: [] (COMPLETE!)
  * "remind me at walmart" → intent: "location", title: "Walmart Location", description: "Location reminder for Walmart", locationScheduleDays: [], missingFields: []
  * "location reminder for pharmacy on mondays and fridays" → intent: "location", title: "Pharmacy Location", description: "Location reminder for pharmacy", locationScheduleDays: [1, 5], missingFields: []
  * "remind me when I visit the gym daily" → intent: "location", title: "Gym Location", description: "Location reminder for gym", locationScheduleDays: [], missingFields: []

Examples:
"Create task for tomorrow 5pm" → 
  intent: "task", title: "Task", description: "Scheduled task", date: "${new Date(currentDate.getTime() + 24*60*60*1000).toISOString().split('T')[0]}", time: "17:00"

"Meeting next Monday at 2pm" → 
  intent: "meeting", title: "Meeting", description: "Scheduled meeting", calculate next Monday's date, time: "14:00"

"Daily standup at 9am" → 
  intent: "task", title: "Daily Team Standup", description: "Daily team synchronization meeting", isRoutine: true, scheduleType: "routine", scheduleDays: ["MO","TU","WE","TH","FR"], fixedTime: "09:00" (THIS IS A TASK, not a meeting)

"Call client about project tomorrow afternoon" →
  intent: "task", title: "Call Client About Project", description: "Phone call with client to discuss project details and updates", tomorrow at 14:00 (afternoon default)

"Location for ABC shop" →
  intent: "location", title: "ABC Shop Location", description: "Location reminder for ABC shop", locationScheduleDays: [] (NO date/time!)

"Remind me at walmart" →
  intent: "location", title: "Walmart Location", description: "Location reminder for Walmart", locationScheduleDays: []

"Location reminder for pharmacy on mondays" →
  intent: "location", title: "Pharmacy Location", description: "Location reminder for pharmacy", locationScheduleDays: [1]

Return ONLY valid JSON, no markdown, no explanation.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text().trim();
    
    // Remove markdown code blocks if present
    const jsonText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    console.log('🤖 Gemini Intent Detection Response:', jsonText);
    
    const analysis = JSON.parse(jsonText);
    
    // If confidence is too low or no intent detected, return null
    if (analysis.intent === 'none' || analysis.confidence < 50) {
      return null;
    }
    
    // Convert date and time to startDateISO for compatibility with existing code
    if (analysis.data && analysis.data.date) {
      const dateStr = analysis.data.date; // YYYY-MM-DD (user's local date)
      const timeStr = analysis.data.time || '00:00'; // HH:mm (user's local time)
      
      // Parse date and time components
      const [year, month, day] = dateStr.split('-').map(Number);
      const [hours, minutes] = timeStr.split(':').map(Number);
      
      // Create date in user's local timezone
      // timezoneOffset is in minutes: positive for west of UTC, negative for east
      // For GMT+5 (Pakistan): timezoneOffset = -300 (local is 5 hours ahead of UTC)
      // For GMT-5 (EST): timezoneOffset = 300 (local is 5 hours behind UTC)
      
      // To convert from local to UTC: UTC = local - timezoneOffset
      // Example: 10 PM GMT+5 (local) - (-300 min) = 10 PM + 5 hours = 3 AM UTC next day ✓
      const localTimestamp = Date.UTC(year, month - 1, day, hours, minutes, 0, 0);
      const utcTimestamp = localTimestamp - (timezoneOffset * 60 * 1000);
      
      // Convert to ISO string
      analysis.data.startDateISO = new Date(utcTimestamp).toISOString();
      
      console.log(`📅 Converted date/time:`);
      console.log(`   User local: ${dateStr} ${timeStr}`);
      console.log(`   Timezone offset: ${timezoneOffset} minutes`);
      console.log(`   Stored UTC: ${analysis.data.startDateISO}`);
      console.log(`   Verification: ${new Date(analysis.data.startDateISO).toLocaleString('en-US', { timeZone: 'UTC' })}`);
      
      // Clean up temp fields
      delete analysis.data.date;
      delete analysis.data.time;
    }
    
    return analysis;
    
  } catch (error) {
    console.error('Error in Gemini intent detection:', error);
    return null;
  }
}

// Helper function to detect actions in the conversation
async function detectAction(assistantResponse, userMessage, userId, timezoneOffset = 0) {
  console.log('🔍 Detecting action for message:', userMessage);
  console.log('🌍 User timezone offset:', timezoneOffset, 'minutes');
  
  // Use Gemini for intelligent intent detection
  const geminiAnalysis = await detectActionWithGemini(userMessage, userId, timezoneOffset);
  
  if (!geminiAnalysis || geminiAnalysis.intent === 'none') {
    console.log('❌ No action detected by Gemini');
    return null;
  }
  
  console.log('✅ Gemini detected intent:', geminiAnalysis.intent);
  console.log('📊 Extracted data:', JSON.stringify(geminiAnalysis.data, null, 2));
  console.log('⚠️ Missing fields:', geminiAnalysis.missingFields);
  
  // Check if we have missing required fields
  if (geminiAnalysis.missingFields && geminiAnalysis.missingFields.length > 0) {
    const actionType = geminiAnalysis.intent === 'task' ? 'create_task' : 'schedule_meeting';
    
    return {
      type: actionType,
      data: geminiAnalysis.data,
      needsMoreInfo: true,
      missingFields: geminiAnalysis.missingFields,
      question: generateMissingFieldsQuestion(geminiAnalysis.missingFields, geminiAnalysis.data)
    };
  }
  
  // We have all required info, prepare for confirmation
  if (geminiAnalysis.intent === 'task') {
    // Convert scheduleDays from string codes to numbers
    let scheduleDays = geminiAnalysis.data.scheduleDays || [];
    if (scheduleDays.length > 0 && typeof scheduleDays[0] === 'string') {
      const dayMap = {
        'SU': 0, 'MO': 1, 'TU': 2, 'WE': 3, 'TH': 4, 'FR': 5, 'SA': 6
      };
      scheduleDays = scheduleDays.map(d => dayMap[d]).filter(n => n !== undefined);
    }
    
    const taskData = {
      title: geminiAnalysis.data.title,
      description: geminiAnalysis.data.description || userMessage,
      scheduleType: geminiAnalysis.data.scheduleType || 'one-day',
      startDateISO: geminiAnalysis.data.startDateISO,
      scheduleDays: scheduleDays,
      scheduleTime: geminiAnalysis.data.scheduleTime || { minutesBeforeStart: 15, fixedTime: null },
      isRoutine: geminiAnalysis.data.isRoutine || false
    };

    // Check if this task might be a routine activity (playing, studying, workout, etc.)
    const routineCheck = await checkIfRoutineActivity(taskData.title, taskData.description);
    
    if (routineCheck.likelyRoutine && !geminiAnalysis.data.isRoutine) {
      // Ask user if they want to make this a routine task
      return {
        type: 'create_task',
        data: taskData,
        needsRoutineConfirmation: true,
        question: routineCheck.question
      };
    }

    const confirmation = await prepareActionConfirmation('create_task', taskData, userId);

    return {
      type: 'create_task',
      data: confirmation.data,
      confirmationNeeded: true,
      confirmationMessage: confirmation.confirmationMessage
    };
  } 
  
  if (geminiAnalysis.intent === 'meeting') {
    const startDate = new Date(geminiAnalysis.data.startDateISO);
    const endDate = new Date(startDate.getTime() + 30 * 60000); // Default 30 minutes
    
    const meetingData = {
      title: geminiAnalysis.data.title,
      description: geminiAnalysis.data.description || userMessage,
      startTime: geminiAnalysis.data.startDateISO,
      endTime: endDate.toISOString(),
      scheduleTime: geminiAnalysis.data.scheduleTime || { minutesBeforeStart: 10, fixedTime: null }
    };

    const confirmation = await prepareActionConfirmation('schedule_meeting', meetingData, userId);

    return {
      type: 'schedule_meeting',
      data: confirmation.data,
      confirmationNeeded: true,
      confirmationMessage: confirmation.confirmationMessage
    };
  }
  
  if (geminiAnalysis.intent === 'location') {
    const locationData = {
      title: geminiAnalysis.data.title,
      description: geminiAnalysis.data.description || userMessage,
      scheduleDays: geminiAnalysis.data.locationScheduleDays || []
    };

    const confirmation = await prepareActionConfirmation('create_location', locationData, userId);

    return {
      type: 'create_location',
      data: confirmation.data,
      confirmationNeeded: true,
      confirmationMessage: confirmation.confirmationMessage
    };
  }
  
  return null;
}

// Helper function to generate a friendly question for missing fields
function generateMissingFieldsQuestion(missingFields, extractedData) {
  const fieldMap = {
    title: 'a title or name',
    startDateISO: 'a date and time',
    description: 'title description',
    scheduleDays: 'which days of the week?',
    'scheduleTime.fixedTime': 'what time ?',
    locationScheduleDays: 'which days to remind you? (or say "daily" for all days)',
  };
  
  let extracted = [];
  if (extractedData.title) extracted.push(`"${extractedData.title}"`);
  if (extractedData.startDateISO) {
    const date = new Date(extractedData.startDateISO);
    extracted.push(`on ${date.toLocaleDateString()} at ${date.toLocaleTimeString()}`);
  }
  
  const missingList = missingFields.map(f => fieldMap[f] || f).join(' and ');
  
  let message = '';
  if (extracted.length > 0) {
    message = `I understand you want to create ${extracted.join(' ')}. `;
  }
  
  message += `Could you please provide ${missingList}?`;
  
  return message;
}

// Helper function to handle pending actions (confirmations, missing info)
async function handlePendingAction(conversation, message, userId, userObj) {
  const pendingAction = conversation.pendingAction;
  
  console.log('📋 handlePendingAction called with:', {
    pendingActionType: pendingAction?.type,
    confirmationNeeded: pendingAction?.confirmationNeeded,
    needsRoutineConfirmation: pendingAction?.needsRoutineConfirmation,
    message: message,
    userId: userId
  });
  
  // Handle routine confirmation
  if (pendingAction.needsRoutineConfirmation) {
    console.log('🔄 Handling routine confirmation...');
    
    // Check if user wants to cancel
    const cancellationCheck = await detectCancellationIntent(message);
    
    if (cancellationCheck.wantsToCancel) {
      console.log('❌ User wants to cancel reminder creation during routine confirmation');
      conversation.pendingAction = null;
      await conversation.save();
      
      return {
        success: true,
        response: "No problem! I've cancelled the reminder creation. How can I help you today?",
        action: 'reminder_cancelled'
      };
    }
    
    const userIntent = await analyzeUserResponseWithGemini(message, pendingAction.data, pendingAction.type);
    
    if (userIntent.intent === 'confirm') {
      console.log('✅ User wants routine task! Asking for schedule details...');
      
      // User wants to make it a routine, ask for schedule type
      conversation.pendingAction.needsRoutineConfirmation = false;
      conversation.pendingAction.needsRoutineSchedule = true;
      conversation.pendingAction.data.isRoutine = true;
      await conversation.save();
      
      return {
        success: true,
        response: "Great! Would you like this as a:\n1. Daily routine (every day)\n2. Specific days of the week\n\nPlease specify which option you'd like.",
        action: 'needs_routine_schedule',
        data: pendingAction.data
      };
      
    } else if (userIntent.intent === 'reject') {
      console.log('❌ User declined routine. Creating one-time task...');
      
      // User doesn't want routine, create one-time task
      pendingAction.data.isRoutine = false;
      pendingAction.data.scheduleType = 'one-day';
      
      const confirmation = await prepareActionConfirmation('create_task', pendingAction.data, userId);
      
      conversation.pendingAction = {
        type: 'create_task',
        data: pendingAction.data,
        confirmationNeeded: true
      };
      await conversation.save();
      
      return {
        success: true,
        response: confirmation.confirmationMessage,
        action: 'confirm_action',
        data: pendingAction.data
      };
    }
  }
  
  // Handle routine schedule details (daily or specific days)
  if (pendingAction.needsRoutineSchedule) {
    console.log('📅 Handling routine schedule details...');
    
    // Check if user wants to cancel
    const cancellationCheck = await detectCancellationIntent(message);
    
    if (cancellationCheck.wantsToCancel) {
      console.log('❌ User wants to cancel reminder creation during routine schedule');
      conversation.pendingAction = null;
      await conversation.save();
      
      return {
        success: true,
        response: "No problem! I've cancelled the reminder creation. How can I help you today?",
        action: 'reminder_cancelled'
      };
    }
    
    const scheduleDetails = await analyzeRoutineScheduleWithGemini(message);
    
    if (scheduleDetails.scheduleType === 'daily') {
      console.log('🗓️ Daily routine selected');
      
      pendingAction.data.scheduleType = 'routine';
      pendingAction.data.scheduleDays = []; // Empty array means daily
      pendingAction.data.isRoutine = true;
      
      const confirmation = await prepareActionConfirmation('create_task', pendingAction.data, userId);
      
      conversation.pendingAction = {
        type: 'create_task',
        data: pendingAction.data,
        confirmationNeeded: true
      };
      await conversation.save();
      
      return {
        success: true,
        response: confirmation.confirmationMessage,
        action: 'confirm_action',
        data: pendingAction.data
      };
      
    } else if (scheduleDetails.scheduleType === 'specific-days') {
      console.log('📆 Specific days selected, asking for days...');
      
      if (scheduleDetails.days && scheduleDetails.days.length > 0) {
        // Convert day codes to numbers (0-6)
        const dayMap = {
          'SU': 0, 'MO': 1, 'TU': 2, 'WE': 3, 'TH': 4, 'FR': 5, 'SA': 6
        };
        const scheduleDays = scheduleDetails.days.map(d => dayMap[d]).filter(n => n !== undefined);
        
        pendingAction.data.scheduleType = 'routine';
        pendingAction.data.scheduleDays = scheduleDays;
        pendingAction.data.isRoutine = true;
        
        const confirmation = await prepareActionConfirmation('create_task', pendingAction.data, userId);
        
        conversation.pendingAction = {
          type: 'create_task',
          data: pendingAction.data,
          confirmationNeeded: true
        };
        await conversation.save();
        
        return {
          success: true,
          response: confirmation.confirmationMessage,
          action: 'confirm_action',
          data: pendingAction.data
        };
      } else {
        // Ask for specific days
        conversation.pendingAction.needsRoutineSchedule = false;
        conversation.pendingAction.needsSpecificDays = true;
        await conversation.save();
        
        return {
          success: true,
          response: "Please specify which days of the week:\nYou can say days like 'Monday, Wednesday, Friday' or 'weekdays' or 'weekends'",
          action: 'needs_specific_days',
          data: pendingAction.data
        };
      }
    }
  }
  
  // Handle specific days selection
  if (pendingAction.needsSpecificDays) {
    console.log('📋 Handling specific days selection...');
    
    // Check if user wants to cancel
    const cancellationCheck = await detectCancellationIntent(message);
    
    if (cancellationCheck.wantsToCancel) {
      console.log('❌ User wants to cancel reminder creation during specific days selection');
      conversation.pendingAction = null;
      await conversation.save();
      
      return {
        success: true,
        response: "No problem! I've cancelled the reminder creation. How can I help you today?",
        action: 'reminder_cancelled'
      };
    }
    
    const daysAnalysis = await extractDaysFromMessageWithGemini(message);
    
    if (daysAnalysis.days && daysAnalysis.days.length > 0) {
      // Convert day codes to numbers (0-6)
      const dayMap = {
        'SU': 0, 'MO': 1, 'TU': 2, 'WE': 3, 'TH': 4, 'FR': 5, 'SA': 6
      };
      const scheduleDays = daysAnalysis.days.map(d => dayMap[d]).filter(n => n !== undefined);
      
      pendingAction.data.scheduleType = 'routine';
      pendingAction.data.scheduleDays = scheduleDays;
      pendingAction.data.isRoutine = true;
      
      const confirmation = await prepareActionConfirmation('create_task', pendingAction.data, userId);
      
      conversation.pendingAction = {
        type: 'create_task',
        data: pendingAction.data,
        confirmationNeeded: true
      };
      await conversation.save();
      
      return {
        success: true,
        response: confirmation.confirmationMessage,
        action: 'confirm_action',
        data: pendingAction.data
      };
    } else {
      return {
        success: true,
        response: "I couldn't understand the days. Please specify like 'Monday and Wednesday' or 'weekdays' or 'Monday, Tuesday, Friday'",
        action: 'needs_specific_days',
        data: pendingAction.data
      };
    }
  }
  
  // Check if this is a confirmation
  if (pendingAction.confirmationNeeded) {
    console.log('🤔 Analyzing user response with Gemini...');
    
    // Use Gemini to understand user's intent (confirm, reject, or modify)
    const userIntent = await analyzeUserResponseWithGemini(message, pendingAction.data, pendingAction.type);
    
    console.log('🤖 Gemini analyzed user intent:', userIntent.intent);
    
    if (userIntent.intent === 'confirm') {
      console.log('✅ User confirmed! Creating item...');
      // User confirmed, create the item
      try {
        let createdItem;
        let responseMessage;
        
        // Create task or meeting based on type
        if (pendingAction.type === 'create_task') {
          console.log('🔄 Attempting to create task with data:', { 
            data: pendingAction.data,
            userId 
          });
          createdItem = await createTask(pendingAction.data, userId);
          console.log('✅ Task created successfully:', createdItem);
          responseMessage = `✅ Task "${createdItem.title}" has been created successfully!`;
          
        } else if (pendingAction.type === 'schedule_meeting') {
          console.log('🔄 Attempting to create meeting with data:', { 
            data: pendingAction.data,
            userId 
          });
          createdItem = await createMeeting(pendingAction.data, userId);
          console.log('✅ Meeting created successfully:', createdItem);
          responseMessage = `✅ Meeting "${createdItem.title}" has been scheduled successfully!`;
          
        } else if (pendingAction.type === 'create_location') {
          console.log('🔄 Attempting to create location reminder with data:', { 
            data: pendingAction.data,
            userId 
          });
          createdItem = await createLocation(pendingAction.data, userId);
          console.log('✅ Location reminder created successfully:', createdItem);
          responseMessage = `✅ Location reminder "${createdItem.title}" has been created successfully!`;
        }
        
        // Clear pending action
        conversation.pendingAction = null;
        await conversation.save();
        
        return {
          success: true,
          response: responseMessage,
          action: `${pendingAction.type}_success`,
          data: createdItem,
          reminderCreated: true, // Flag to trigger frontend event emission
          reminderType: createdItem.type // Task, Meeting, or Location
        };
        
      } catch (error) {
        console.error('Error creating item:', error);
        return {
          success: false,
          response: `Sorry, I couldn't create that. ${error.message}`,
          action: 'creation_failed'
        };
      }
    } else if (userIntent.intent === 'reject') {
      console.log('❌ User declined the action');
      // User declined
      conversation.pendingAction = null;
      await conversation.save();
      return {
        success: true,
        response: "Okay, I won't create that. Is there anything else I can help with?",
        action: 'action_cancelled'
      };
    } else if (userIntent.intent === 'modify') {
      // User wants to make changes
      console.log('🔧 User wants to make changes:', userIntent.modifications);
      
      // Apply modifications from Gemini
      const updatedData = { ...pendingAction.data, ...userIntent.modifications };
      
      // Update pending action with modified data
      conversation.pendingAction.data = updatedData;
      await conversation.save();
      
      // Re-confirm with updated details
      const confirmation = await prepareActionConfirmation(
        pendingAction.type,
        updatedData,
        userId
      );
      
      return {
        success: true,
        response: `Got it! I've updated the details.\n\n${confirmation.confirmationMessage}`,
        action: 'confirm_action',
        data: updatedData
      };
    } else {
      // Unclear response, re-prompt
      console.log('⚠️ User response unclear, re-prompting for confirmation');
      return {
        success: true,
        response: "I didn't quite catch that. Would you like me to create this? Please say 'yes' to confirm, 'no' to cancel, or tell me what you'd like to change.",
        action: 'awaiting_confirmation',
        data: pendingAction.data
      };
    }
  }
  
  // Handle missing information
  if (pendingAction.missingFields && pendingAction.missingFields.length > 0) {
    console.log('📝 Handling missing fields with Gemini. Missing:', pendingAction.missingFields);
    
    // First check if user wants to cancel the reminder creation
    const cancellationCheck = await detectCancellationIntent(message);
    
    if (cancellationCheck.wantsToCancel) {
      console.log('❌ User wants to cancel reminder creation during missing fields stage');
      conversation.pendingAction = null;
      await conversation.save();
      
      return {
        success: true,
        response: "No problem! I've cancelled the reminder creation. How can I help you today?",
        action: 'reminder_cancelled'
      };
    }
    
    // Use Gemini to extract missing information from user's response
    const extractedInfo = await extractMissingFieldsWithGemini(
      message, 
      pendingAction.missingFields, 
      pendingAction.data,
      pendingAction.type
    );
    
    console.log('🤖 Gemini extracted info:', JSON.stringify(extractedInfo, null, 2));
    
    // Merge extracted data with existing data, handling nested objects properly
    const updatedData = { ...pendingAction.data };
    
    // Handle each extracted field
    for (const [key, value] of Object.entries(extractedInfo.extractedData)) {
      if (key === 'scheduleTime' && typeof value === 'object') {
        // Merge scheduleTime object properly
        updatedData.scheduleTime = {
          ...updatedData.scheduleTime,
          ...value
        };
      } else {
        updatedData[key] = value;
      }
    }
    
    console.log('📦 Updated data after merge:', JSON.stringify(updatedData, null, 2));
    
    if (extractedInfo.allFieldsFilled) {
      console.log('✅ All fields filled! Preparing confirmation...');
      // All missing fields are now filled, confirm before creating
      const action = await prepareActionConfirmation(
        pendingAction.type,
        updatedData,
        userId
      );
      
      conversation.pendingAction = {
        type: pendingAction.type,
        data: updatedData,
        confirmationNeeded: true
      };
      
      await conversation.save();
      
      return {
        success: true,
        response: action.confirmationMessage,
        action: 'confirm_action',
        data: updatedData
      };
    } else {
      console.log('⚠️ Still missing fields:', extractedInfo.remainingFields);
      // Still missing some fields, ask for them
      conversation.pendingAction.data = updatedData;
      conversation.pendingAction.missingFields = extractedInfo.remainingFields;
      await conversation.save();
      
      return {
        success: true,
        response: generateMissingFieldsQuestion(extractedInfo.remainingFields, updatedData),
        action: 'needs_info',
        data: { 
          missingFields: extractedInfo.remainingFields,
          extractedFields: extractedInfo.extractedData
        }
      };
    }
  }
  
  return null;
}

// Helper function to check if a task is likely a routine activity
async function checkIfRoutineActivity(title, description) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    
    const prompt = `You are analyzing if a task is likely a routine/recurring activity.

CRITICAL: You MUST respond in English ONLY. Your analysis and questions must be in English.

Task title: "${title}"
Task description: "${description}"

Determine if this task is typically done as a routine (repeatedly on a schedule) rather than a one-time task.

Common routine activities include:
- Exercise/workout/gym
- Study sessions
- Practice (music, sports, etc.)
- Playing games
- Meditation/yoga
- Reading
- Cleaning/chores
- Morning/evening routines
- Meal prep
- Team standups
- Regular meetings

Return a JSON object with this EXACT structure:
{
  "likelyRoutine": boolean (true if this is typically a routine activity),
  "confidence": number (0-100),
  "question": "Would you like to set this as a routine task? This seems like something you might do regularly."
}

RULES:
- If confidence > 70 that it's a routine activity, set likelyRoutine to true
- Make the question friendly and contextual
- Examples:
  * "Gym workout" → likelyRoutine: true, question: "Would you like to set this as a routine task? Workouts are often done regularly."
  * "Study math" → likelyRoutine: true, question: "Would you like to set this as a routine task? Study sessions are often scheduled regularly."
  * "Buy groceries" → likelyRoutine: true (can be weekly routine)
  * "Call John" → likelyRoutine: false (typically one-time)
  * "Submit report" → likelyRoutine: false (one-time task)

Return ONLY valid JSON, no markdown, no explanation.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text().trim();
    const jsonText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    console.log('🤖 Routine Activity Check:', jsonText);
    
    const analysis = JSON.parse(jsonText);
    return analysis;
    
  } catch (error) {
    console.error('Error checking routine activity:', error);
    return { likelyRoutine: false, confidence: 0, question: '' };
  }
}

// Helper function to analyze routine schedule preference (daily or specific days)
async function analyzeRoutineScheduleWithGemini(userMessage) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    
    const prompt = `You are analyzing a user's response about routine scheduling preferences.

CRITICAL: You MUST respond in English ONLY. Understand the user's input in any language but analyze in English.

User's response: "${userMessage}"

Determine if the user wants:
1. DAILY routine (every day)
2. SPECIFIC DAYS routine (certain days of the week)

Return a JSON object with this EXACT structure:
{
  "scheduleType": "daily" | "specific-days" | "unclear",
  "days": ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] (only if specific days mentioned),
  "confidence": number (0-100)
}

DAY CODES:
- Sunday: SU (0)
- Monday: MO (1)
- Tuesday: TU (2)
- Wednesday: WE (3)
- Thursday: TH (4)
- Friday: FR (5)
- Saturday: SA (6)

RULES:
- If user says "daily", "every day", "all days", "1", etc. → scheduleType: "daily"
- If user says "specific days", "certain days", "2", "weekdays", etc. → scheduleType: "specific-days"
- If user mentions specific days like "Monday Wednesday Friday" → extract them
- "weekdays" = ["MO", "TU", "WE", "TH", "FR"]
- "weekends" = ["SA", "SU"]

Examples:
"Daily" → {"scheduleType": "daily", "days": [], "confidence": 100}
"Every day" → {"scheduleType": "daily", "days": [], "confidence": 100}
"1" → {"scheduleType": "daily", "days": [], "confidence": 100}
"Specific days" → {"scheduleType": "specific-days", "days": [], "confidence": 90}
"2" → {"scheduleType": "specific-days", "days": [], "confidence": 90}
"Monday Wednesday Friday" → {"scheduleType": "specific-days", "days": ["MO", "WE", "FR"], "confidence": 100}
"Weekdays" → {"scheduleType": "specific-days", "days": ["MO", "TU", "WE", "TH", "FR"], "confidence": 100}

Return ONLY valid JSON, no markdown, no explanation.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text().trim();
    const jsonText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    console.log('🤖 Routine Schedule Analysis:', jsonText);
    
    const analysis = JSON.parse(jsonText);
    return analysis;
    
  } catch (error) {
    console.error('Error analyzing routine schedule:', error);
    return { scheduleType: 'unclear', days: [], confidence: 0 };
  }
}

// Helper function to extract days from user message
async function extractDaysFromMessageWithGemini(userMessage) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    
    const prompt = `You are extracting specific days of the week from a user's message.

CRITICAL: You MUST respond in English ONLY. Understand the user's input in any language but extract days in English format.

User's message: "${userMessage}"

Extract which days of the week the user wants.

Return a JSON object with this EXACT structure:
{
  "days": ["MO", "TU", "WE", "TH", "FR", "SA", "SU"],
  "confidence": number (0-100)
}

DAY CODES:
- Sunday: SU (0)
- Monday: MO (1)
- Tuesday: TU (2)
- Wednesday: WE (3)
- Thursday: TH (4)
- Friday: FR (5)
- Saturday: SA (6)

RULES:
- Extract all mentioned days
- "weekdays" = ["MO", "TU", "WE", "TH", "FR"]
- "weekends" = ["SA", "SU"]
- "Monday and Wednesday" = ["MO", "WE"]
- "MWF" or "Mon Wed Fri" = ["MO", "WE", "FR"]
- If unclear or no days mentioned, return empty array

Examples:
"Monday and Wednesday" → {"days": ["MO", "WE"], "confidence": 100}
"Weekdays" → {"days": ["MO", "TU", "WE", "TH", "FR"], "confidence": 100}
"Monday, Tuesday, Friday" → {"days": ["MO", "TU", "FR"], "confidence": 100}
"MWF" → {"days": ["MO", "WE", "FR"], "confidence": 95}
"Weekends" → {"days": ["SA", "SU"], "confidence": 100}
"Every Monday" → {"days": ["MO"], "confidence": 100}

Return ONLY valid JSON, no markdown, no explanation.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text().trim();
    const jsonText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    console.log('🤖 Days Extraction:', jsonText);
    
    const analysis = JSON.parse(jsonText);
    return analysis;
    
  } catch (error) {
    console.error('Error extracting days:', error);
    return { days: [], confidence: 0 };
  }
}

// Helper function to use Gemini to analyze user response (confirm/reject/modify)
async function analyzeUserResponseWithGemini(userMessage, currentData, actionType) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    
    const currentDate = new Date(); // October 25, 2025
    
    const prompt = `You are analyzing a user's response to a confirmation request.

CRITICAL: You MUST respond in English ONLY. Understand the user's input in any language but analyze in English.

Current date and time: ${currentDate.toISOString()} (${currentDate.toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'full', timeStyle: 'short' })})

Action type: ${actionType === 'create_task' ? 'Creating a Task' : 'Scheduling a Meeting'}

Current item details that were presented to user: ${JSON.stringify(currentData, null, 2)}

User's response: "${userMessage}"

Determine if the user wants to:
1. CONFIRM - proceed with creating the item (yes, sure, ok, go ahead, create it, etc.)
2. REJECT - cancel the action (no, cancel, don't, never mind, etc.)
3. MODIFY - make changes to the details (change time, different date, update title, etc.)
4. UNCLEAR - response is ambiguous or unrelated

If user wants to MODIFY, extract what they want to change and provide the updated values.

Return a JSON object with this EXACT structure:
{
  "intent": "confirm" | "reject" | "modify" | "unclear",
  "modifications": {
    // Only if intent is "modify", include fields to update
    "title": "new title if user wants to change it",
    "date": "YYYY-MM-DD (new date in user's local timezone)",
    "time": "HH:mm (new time in 24-hour format, in user's local timezone)",
    "description": "new description if user wants to change it",
    "scheduleTime": {
      "fixedTime": "HH:mm if user specifies new time",
      "minutesBeforeStart": number
    }
    // Only include fields that need to be changed
  },
  "confidence": number (0-100, how confident you are)
}

CRITICAL RULES:
- Be smart about detecting affirmations: "yes", "yeah", "sure", "ok", "proceed", "go ahead", "create it", "confirm", "looks good", "perfect", etc.
- Be smart about rejections: "no", "cancel", "stop", "don't", "never mind", "forget it", "abort", etc.
- For modifications: extract the specific changes requested
- ALL dates/times are in USER'S LOCAL TIMEZONE
- Calculate exact dates for relative terms like "tomorrow", "next week", etc. from ${currentDate.toLocaleDateString()}
- Convert times: "5pm" to "17:00", "9am" to "09:00"
- If user just provides a time like "make it 6pm", provide date from current data and time as "18:00"
- Return date as "YYYY-MM-DD" and time as "HH:mm" separately
- Only include modified fields in modifications object

Examples:
"Yes" → {"intent": "confirm", "modifications": {}, "confidence": 100}
"No thanks" → {"intent": "reject", "modifications": {}, "confidence": 100}
"Change time to 6pm" → {"intent": "modify", "modifications": {"startDateISO": "...with time 18:00"}, "confidence": 95}
"Make it tomorrow instead" → {"intent": "modify", "modifications": {"startDateISO": "tomorrow's date"}, "confidence": 95}
"Update title to Team Meeting" → {"intent": "modify", "modifications": {"title": "Team Meeting"}, "confidence": 95}

Return ONLY valid JSON, no markdown, no explanation.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text().trim();
    
    const jsonText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    console.log('🤖 Gemini User Response Analysis:', jsonText);
    
    const analysis = JSON.parse(jsonText);
    
    // Convert date and time to startDateISO if modifications include them
    if (analysis.modifications && (analysis.modifications.date || analysis.modifications.time)) {
      const dateStr = analysis.modifications.date || '';
      const timeStr = analysis.modifications.time || '';
      
      if (dateStr && timeStr) {
        analysis.modifications.startDateISO = `${dateStr}T${timeStr}:00`;
        delete analysis.modifications.date;
        delete analysis.modifications.time;
      }
    }
    
    return analysis;
    
  } catch (error) {
    console.error('Error in Gemini user response analysis:', error);
    return {
      intent: 'unclear',
      modifications: {},
      confidence: 0
    };
  }
}

// Helper function to use Gemini to detect modifications user wants to make
async function detectModificationsWithGemini(userMessage, currentData, actionType) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    
    const currentDate = new Date(); // October 25, 2025
    
    const prompt = `You are helping detect modifications a user wants to make to a scheduled item.

CRITICAL: You MUST respond in English ONLY. Understand the user's input in any language but analyze in English.

Current date and time: ${currentDate.toISOString()} (${currentDate.toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'full', timeStyle: 'short' })})

Action type: ${actionType === 'create_task' ? 'Task' : 'Meeting'}

Current item details: ${JSON.stringify(currentData, null, 2)}

User's modification request: "${userMessage}"

Analyze what the user wants to change. They might want to:
- Change the title
- Change the date/time
- Change other details

Return a JSON object with this EXACT structure:
{
  "hasChanges": boolean (true if user wants to make changes),
  "updatedData": {
    // Include ALL fields from currentData, with modifications applied
    // Calculate exact dates for relative terms like "change to tomorrow 6pm"
    // Keep unchanged fields as they are
  },
  "changesSummary": "brief description of what was changed"
}

CRITICAL RULES:
- ALL dates/times are in USER'S LOCAL TIMEZONE
- If user says "change time to 6pm", update the time to "18:00"
- If user says "make it tomorrow", calculate tomorrow's date from ${currentDate.toLocaleDateString()}
- If user says "change title to X", update title to "X"
- Keep ALL other fields unchanged from currentData
- For date/time changes, provide them as separate "date" (YYYY-MM-DD) and "time" (HH:mm) fields in updatedData
- If only time changes, keep the date from currentData.startDateISO
- If only date changes, keep the time from currentData.startDateISO
- If you can't detect any specific change request, set hasChanges to false

Examples:
"Change time to 6pm" → update time to "18:00" in updatedData
"Make it tomorrow" → update date to tomorrow's date in updatedData
"Change title to Team Meeting" → update title in updatedData

Return ONLY valid JSON, no markdown, no explanation.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text().trim();
    
    const jsonText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    console.log('🤖 Gemini Modification Detection:', jsonText);
    
    const modifications = JSON.parse(jsonText);
    
    // Convert date and time to startDateISO if updatedData includes them
    if (modifications.updatedData) {
      const dateStr = modifications.updatedData.date;
      const timeStr = modifications.updatedData.time;
      
      if (dateStr && timeStr) {
        modifications.updatedData.startDateISO = `${dateStr}T${timeStr}:00`;
        delete modifications.updatedData.date;
        delete modifications.updatedData.time;
      }
    }
    
    return modifications;
    
  } catch (error) {
    console.error('Error in Gemini modification detection:', error);
    return {
      hasChanges: false,
      updatedData: currentData,
      changesSummary: ''
    };
  }
}

// Helper function to use Gemini to extract missing field information
async function extractMissingFieldsWithGemini(userMessage, missingFields, existingData, actionType) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    
    const currentDate = new Date();
    
    const prompt = `You are helping extract missing information from a user's response.

CRITICAL: You MUST respond in English ONLY. Understand the user's input in any language but extract information in English.

Current date and time: ${currentDate.toISOString()} (${currentDate.toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'full', timeStyle: 'short' })})

Action type: ${actionType === 'create_task' ? 'Creating a Task' : actionType === 'schedule_meeting' ? 'Scheduling a Meeting' : 'Creating Location Reminder'}

Existing data: ${JSON.stringify(existingData, null, 2)}

Missing fields needed: ${JSON.stringify(missingFields)}

User's response: "${userMessage}"

Extract the missing field values from the user's message. Calculate exact dates and times based on relative terms.

**CRITICAL:** Only extract fields that are listed in "Missing fields needed" above. Do NOT extract or include fields that already exist in "Existing data".

Return a JSON object with this EXACT structure:
{
  "extractedData": {
    // Only include the fields that were in "Missing fields needed"
    // Example fields (only include if they are missing):
    "title": "extracted title if missing",
    "scheduleDays": [0, 1, 2, 3, 4, 5, 6] (array of day numbers if missing - for routine tasks),
    "scheduleTime": {
      "fixedTime": "HH:mm" (if user specifies time for routine task)
    },
    "startDateISO": "YYYY-MM-DDTHH:mm:ss.000Z (exact ISO datetime in UTC)",
    "description": "extracted description"
  },
  "allFieldsFilled": boolean (true if all missing fields are now filled),
  "remainingFields": ["field1", "field2"] (fields still missing)
}

CRITICAL RULES FOR EXTRACTING FIELDS:

**For scheduleDays (routine tasks):**
- Extract days of the week as NUMBERS: 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday
- "Saturday, Sunday, Monday" → [6, 0, 1]
- "Monday, Wednesday, Friday" → [1, 3, 5]
- "Weekdays" → [1, 2, 3, 4, 5]
- "Weekends" → [0, 6]
- "Daily" or "every day" → [] (empty array)

**For scheduleTime.fixedTime (routine tasks):**
- Extract time in 24-hour format as "HH:mm"
- "3 PM" or "3 p.m." → "15:00"
- "9 AM" → "09:00"
- "5:30 PM" → "17:30"

**For title:**
- Extract or infer a meaningful title from context
- Keep it concise and action-oriented

**For startDateISO (one-time tasks/meetings):**
- Calculate exact date and time
- "tomorrow 5pm" → calculate tomorrow's date at 17:00 UTC
- Return in ISO format: "YYYY-MM-DDTHH:mm:ss.000Z"

**General Rules:**
- **CRITICAL:** Only include fields in extractedData that were in the "Missing fields needed" list
- **DO NOT** include fields that are already in "Existing data" (like title, description, etc.)
- Be smart and infer reasonable values when possible
- If user provides days AND time for a routine task, extract both scheduleDays and scheduleTime.fixedTime
- Only mark as remaining if truly cannot be extracted or inferred
- **NEVER overwrite existing fields that are not in the missing list**

**Examples:**

User: "Saturday, Sunday and Monday at 3 PM"
Missing: ["scheduleDays", "scheduleTime.fixedTime"]
Existing: {"title": "Playing Cricket", "description": "Play cricket"}
→ {
  "extractedData": {
    "scheduleDays": [6, 0, 1],
    "scheduleTime": {"fixedTime": "15:00"}
  },
  "allFieldsFilled": true,
  "remainingFields": []
}
Note: title is NOT included in extractedData because it was not in missing fields!

User: "Weekdays at 9 AM"
Missing: ["scheduleDays", "scheduleTime.fixedTime"]
→ {
  "extractedData": {
    "scheduleDays": [6, 0, 1],
    "scheduleTime": {"fixedTime": "15:00"}
  },
  "allFieldsFilled": true,
  "remainingFields": []
}

User: "Weekdays at 9 AM"
Missing: ["scheduleDays", "scheduleTime.fixedTime"]
→ {
  "extractedData": {
    "scheduleDays": [1, 2, 3, 4, 5],
    "scheduleTime": {"fixedTime": "09:00"}
  },
  "allFieldsFilled": true,
  "remainingFields": []
}

User: "Playing cricket"
Missing: ["title"]
→ {
  "extractedData": {
    "title": "Playing Cricket"
  },
  "allFieldsFilled": true,
  "remainingFields": []
}

Return ONLY valid JSON, no markdown, no explanation.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text().trim();
    
    const jsonText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    console.log('🤖 Gemini Missing Fields Extraction:', jsonText);
    
    const extraction = JSON.parse(jsonText);
    
    return extraction;
    
  } catch (error) {
    console.error('Error in Gemini field extraction:', error);
    // Fallback: return empty extraction
    return {
      extractedData: {},
      allFieldsFilled: false,
      remainingFields: missingFields
    };
  }
}

// Helper function to prepare action confirmation
async function prepareActionConfirmation(type, data, userId) {
  if (type === 'create_task') {
    // Format the date and time for user-friendly display
    let scheduleInfo = '';
    
    if (data.startDateISO) {
      const startDate = new Date(data.startDateISO);
      const dateStr = startDate.toLocaleDateString('en-US', { 
        weekday: 'long', 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric',
        timeZone: 'UTC'
      });
      
      if (data.scheduleTime?.fixedTime) {
        scheduleInfo = ` on ${dateStr} at ${data.scheduleTime.fixedTime}`;
      } else {
        const timeStr = startDate.toLocaleTimeString('en-US', { 
          hour: 'numeric', 
          minute: '2-digit',
          hour12: true,
          timeZone: 'UTC'
        });
        scheduleInfo = ` on ${dateStr} at ${timeStr}`;
      }
    } else if (data.scheduleTime?.fixedTime) {
      scheduleInfo = ` at ${data.scheduleTime.fixedTime}`;
    }
    
    let reminderInfo = '';
    if (data.scheduleTime?.minutesBeforeStart && !data.scheduleTime.fixedTime) {
      reminderInfo = ` (${data.scheduleTime.minutesBeforeStart} min reminder)`;
    }
    
    // Format routine information with day names
    let routineInfo = '';
    let daysInfo = '';
    
    if (data.isRoutine && data.scheduleDays !== undefined) {
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      
      if (data.scheduleDays.length === 0) {
        // Empty array means daily
        routineInfo = ' (Daily Routine)';
      } else if (data.scheduleDays.length === 7) {
        routineInfo = ' (Daily Routine)';
      } else {
        routineInfo = ' (Routine Task)';
        const dayNamesList = data.scheduleDays.map(d => dayNames[d]).filter(n => n).join(', ');
        daysInfo = `\n• Repeats: ${dayNamesList}`;
      }
    }
    
    let detailedMessage = `📋 Task Details:\n`;
    detailedMessage += `• Title: "${data.title}"\n`;
    if (scheduleInfo) detailedMessage += `• Scheduled:${scheduleInfo}${reminderInfo}\n`;
    if (routineInfo) detailedMessage += `• Type:${routineInfo}`;
    if (daysInfo) detailedMessage += daysInfo;
    if (routineInfo || daysInfo) detailedMessage += `\n`;
    if (data.description && data.description !== data.title) {
      detailedMessage += `• Description: ${data.description}\n`;
    }
    detailedMessage += `\nShould I create this task? (Yes/No, or tell me what to change)`;
      
    return {
      confirmationMessage: detailedMessage,
      data
    };
    
  } else if (type === 'schedule_meeting') {
    // Format meeting date and time (preserve UTC to avoid timezone conversion)
    let scheduleInfo = '';
    
    if (data.startTime) {
      const startDate = new Date(data.startTime);
      
      // Format date in UTC to preserve the intended time
      const dateStr = startDate.toLocaleDateString('en-US', { 
        weekday: 'long', 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric',
        timeZone: 'UTC'
      });
      const timeStr = startDate.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true,
        timeZone: 'UTC'
      });
      scheduleInfo = `${dateStr} at ${timeStr}`;
    }
    
    let detailedMessage = `📅 Meeting Details:\n`;
    detailedMessage += `• Title: "${data.title}"\n`;
    if (scheduleInfo) detailedMessage += `• When: ${scheduleInfo}\n`;
    if (data.description && data.description !== data.title) {
      detailedMessage += `• Description: ${data.description}\n`;
    }
    detailedMessage += `\nShould I schedule this meeting? (Yes/No, or tell me what to change)`;
    
    return {
      confirmationMessage: detailedMessage,
      data
    };
  } else if (type === 'create_location') {
    // Format location reminder details
    let daysInfo = '';
    
    if (data.scheduleDays && data.scheduleDays.length > 0) {
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const dayNamesList = data.scheduleDays.map(d => dayNames[d]).join(', ');
      daysInfo = `• Active Days: ${dayNamesList}\n`;
    } else {
      daysInfo = `• Active Days: Daily\n`;
    }
    
    let detailedMessage = `📍 Location Reminder Details:\n`;
    detailedMessage += `• Title: "${data.title}"\n`;
   
    detailedMessage += daysInfo;
    if (data.description && data.description !== data.title) {
      detailedMessage += `• Description: ${data.description}\n`;
    }
    detailedMessage += `\nShould I create this location reminder? (Yes/No, or tell me what to change)`;
    
    return {
      confirmationMessage: detailedMessage,
      data
    };
  }
  
  return { confirmationMessage: 'Should I proceed with this?', data };
}

// Helper function to create a task in the database
async function createTask(taskData, userId) {
  console.log('📝 Creating task with data:', JSON.stringify({ taskData, userId }, null, 2));
  
  // Prepare reminder data matching the reminderModel schema
  const reminderData = {
    user: userId,
    type: 'Task',
    title: taskData.title,
    description: taskData.description || '',
    startDate: taskData.startDateISO ? new Date(taskData.startDateISO) : null,
    isCompleted: false,
    isManualSchedule: taskData.scheduleType === 'routine' ? true : (taskData.startDateISO ? true : false),
    aiSuggested: true,
    scheduleType: taskData.scheduleType || 'one-day',
    scheduleTime: taskData.scheduleTime || { minutesBeforeStart: 15, fixedTime: null },
    scheduleDays: taskData.scheduleDays || [],
    notificationPreferenceMinutes: taskData.scheduleTime?.minutesBeforeStart || 15,
    icon: 'star'
  };
  
  console.log('💾 Prepared reminder data:', JSON.stringify(reminderData, null, 2));
  
  try {
    const task = new Reminder(reminderData);
    const savedTask = await task.save();
    console.log('✅ Task saved to database with ID:', savedTask._id);
    console.log('✅ Full saved task:', JSON.stringify(savedTask.toObject(), null, 2));
    return savedTask;
  } catch (error) {
    console.error('❌ Error saving task to database:', {
      error: error.message,
      stack: error.stack,
      validationErrors: error.errors,
      reminderData: reminderData
    });
    throw error;
  }
}

// Helper function to create a meeting in the database
async function createMeeting(meetingData, userId) {
  console.log('📅 Creating meeting with data:', JSON.stringify({ meetingData, userId }, null, 2));
  
  try {
    const startDate = meetingData.startTime ? new Date(meetingData.startTime) : new Date();
    const endDate = meetingData.endTime ? new Date(meetingData.endTime) : new Date(startDate.getTime() + 30 * 60000);

    const reminderData = {
      type: 'Meeting',
      user: userId,
      title: meetingData.title,
      description: meetingData.description || '',
      startDate,
      endDate,
      isManualSchedule: true,
      scheduleType: 'one-day',
      scheduleTime: meetingData.scheduleTime || { minutesBeforeStart: 10 },
      notificationPreferenceMinutes: 10,
      aiSuggested: true,
      icon: 'star'
    };

    console.log('💾 Prepared meeting reminder data:', JSON.stringify(reminderData, null, 2));

    const meeting = new Reminder(reminderData);
    const saved = await meeting.save();
    console.log('✅ Meeting saved to database with ID:', saved._id);
    console.log('✅ Full saved meeting:', JSON.stringify(saved.toObject(), null, 2));
    return saved;
  } catch (err) {
    console.error('❌ Meeting Save Error:', {
      error: err.message,
      stack: err.stack,
      validationErrors: err.errors,
      meetingData: meetingData
    });
    throw err;
  }
}

module.exports = router;
async function createTask(taskData, userId) {
  console.log('📝 Creating task with data:', JSON.stringify({ taskData, userId }, null, 2));
  
  // Prepare reminder data matching the reminderModel schema
  const reminderData = {
    user: userId,
    type: 'Task',
    title: taskData.title,
    description: taskData.description || '',
    startDate: taskData.startDateISO ? new Date(taskData.startDateISO) : null,
    isCompleted: false,
    isManualSchedule: taskData.scheduleType === 'routine' ? true : (taskData.startDateISO ? true : false),
    aiSuggested: true,
    scheduleType: taskData.scheduleType || 'one-day',
    scheduleTime: taskData.scheduleTime || { minutesBeforeStart: 15, fixedTime: null },
    scheduleDays: taskData.scheduleDays || [],
    notificationPreferenceMinutes: taskData.scheduleTime?.minutesBeforeStart || 15,
    icon: 'star'
  };
  
  console.log('💾 Prepared reminder data:', JSON.stringify(reminderData, null, 2));
  
  try {
    const task = new Reminder(reminderData);
    const savedTask = await task.save();
    console.log('✅ Task saved to database with ID:', savedTask._id);
    console.log('✅ Full saved task:', JSON.stringify(savedTask.toObject(), null, 2));
    return savedTask;
  } catch (error) {
    console.error('❌ Error saving task to database:', {
      error: error.message,
      stack: error.stack,
      validationErrors: error.errors,
      reminderData: reminderData
    });
    throw error;
  }
}

// Helper function to create a meeting in the database
async function createMeeting(meetingData, userId) {
  console.log('📅 Creating meeting with data:', JSON.stringify({ meetingData, userId }, null, 2));
  
  try {
    const startDate = meetingData.startTime ? new Date(meetingData.startTime) : new Date();
    const endDate = meetingData.endTime ? new Date(meetingData.endTime) : new Date(startDate.getTime() + 30 * 60000);

    const reminderData = {
      type: 'Meeting',
      user: userId,
      title: meetingData.title,
      description: meetingData.description || '',
      startDate,
      endDate,
      isManualSchedule: true,
      scheduleType: 'one-day',
      scheduleTime: { minutesBeforeStart: 10 },
      notificationPreferenceMinutes: 10,
      aiSuggested: true,
      icon: 'star'
    };

    console.log('💾 Prepared meeting reminder data:', JSON.stringify(reminderData, null, 2));

    const meeting = new Reminder(reminderData);
    const saved = await meeting.save();
    console.log('✅ Meeting saved to database with ID:', saved._id);
    console.log('✅ Full saved meeting:', JSON.stringify(saved.toObject(), null, 2));
    return saved;
  } catch (err) {
    console.error('❌ Meeting Save Error:', {
      error: err.message,
      stack: err.stack,
      validationErrors: err.errors,
      meetingData: meetingData
    });
    throw err;
  }
}

// Helper function to create a location reminder in the database
async function createLocation(locationData, userId) {
  console.log('📍 Creating location reminder with data:', JSON.stringify({ locationData, userId }, null, 2));
  
  try {
    const reminderData = {
      type: 'Location',
      user: userId,
      title: locationData.title,
      description: locationData.description || '',
      status: 'active',
      scheduleDays: locationData.scheduleDays || [],
      aiSuggested: true,
      icon: 'map-pin'
    };
    
    

    console.log('💾 Prepared location reminder data:', JSON.stringify(reminderData, null, 2));

    const location = new Reminder(reminderData);
    const saved = await location.save();
    console.log('✅ Location reminder saved to database with ID:', saved._id);
    console.log('✅ Full saved location:', JSON.stringify(saved.toObject(), null, 2));
    return saved;
  } catch (err) {
    console.error('❌ Location Save Error:', {
      error: err.message,
      stack: err.stack,
      validationErrors: err.errors,
      locationData: locationData
    });
    throw err;
  }
}

// Helper function to analyze if user's message is related to pending action or unrelated
async function analyzeUserIntentForPendingAction(userMessage, pendingAction) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    
    const actionType = pendingAction.type === 'create_task' ? 'Task' : 
                       pendingAction.type === 'schedule_meeting' ? 'Meeting' : 'Location Reminder';
    const pendingData = JSON.stringify(pendingAction.data, null, 2);
    
    const prompt = `You are analyzing if a user's message is related to a pending reminder creation or is an unrelated query.

CRITICAL: You MUST respond in English ONLY. You MUST understand user intent regardless of how they express it or what language they use.

Pending Action Type: ${actionType}
Pending Action State: ${JSON.stringify({
  confirmationNeeded: pendingAction.confirmationNeeded,
  needsRoutineConfirmation: pendingAction.needsRoutineConfirmation,
  needsRoutineSchedule: pendingAction.needsRoutineSchedule,
  needsSpecificDays: pendingAction.needsSpecificDays,
  missingFields: pendingAction.missingFields,
  askedAboutPending: pendingAction.askedAboutPending
}, null, 2)}
Pending Reminder Data: ${pendingData}

User's Message: "${userMessage}"

Analyze if the user's message is:
1. **UNRELATED** - User is asking about something completely different (weather, general questions, new task, etc.)
2. **CONTINUE** - User explicitly wants to continue with the pending reminder
3. **CANCEL** - User wants to cancel the pending reminder
4. **DETAILS** - User wants more details about the pending reminder
5. **RELATED** - User is responding to questions about the pending reminder (answering time, date, confirmation, modifications, etc.)

Return a JSON object with this EXACT structure:
{
  "intent": "unrelated" | "continue" | "cancel" | "details" | "related",
  "confidence": number (0-100),
  "reasoning": "brief explanation of why you chose this intent"
}

CRITICAL RULES - UNDERSTAND ALL VARIATIONS:

**CONTINUE Intent** - Recognize ANY affirmative response wanting to proceed:
- Numbers: "1", "one", "first", "option 1", "first one"
- Affirmative: "yes", "yeah", "yep", "yup", "sure", "ok", "okay", "fine", "alright", "go ahead"
- Continue words: "continue", "proceed", "resume", "keep going", "let's continue", "yes continue"
- Confirmations: "let's do it", "let's proceed", "go on", "move forward", "yes let's continue"
- ANY LANGUAGE: "haan", "theek hai", "chalo", "ji haan", "bilkul", "sahi hai" (Urdu/Hindi yes)
- Short: "y", "k", "👍", "✓", "✅"
- **If askedAboutPending is true, ANY affirmative response = "continue"**

**CANCEL Intent** - Recognize ANY negative/cancel response:
- Numbers: "2", "two", "second", "option 2", "second one"
- Cancel words: "no", "nope", "nah", "cancel", "stop", "abort", "forget it", "never mind", "don't"
- Rejections: "not now", "later", "skip it", "let it go", "remove it", "delete it"
- ANY LANGUAGE: "nahi", "nahi chahiye", "ruk jao", "band karo", "chhodo" (Urdu/Hindi no)
- Short: "n", "x", "❌", "🚫"
- **If askedAboutPending is true, ANY negative response = "cancel"**

**DETAILS Intent** - Recognize requests for information:
- Numbers: "3", "three", "third", "option 3", "third one"
- Questions: "what was it?", "tell me", "show me", "details", "info", "information"
- Queries: "what reminder?", "which one?", "what's pending?", "remind me what it was"
- Clarifications: "I forgot", "what did I ask for?", "can you tell me again?"
- ANY LANGUAGE: "kya tha?", "batao", "details do" (Urdu/Hindi)

**UNRELATED Intent** - User asking something completely different:
- New topics: weather, jokes, facts, different questions
- New reminders: "create new task", "set another reminder"
- General chat: greetings (if reminder was already in progress), random questions
- **IMPORTANT**: If user is creating a DIFFERENT reminder while one is pending

**RELATED Intent** - User responding to pending reminder questions:
- Providing information: "tomorrow at 5pm", "call John", "meeting room A"
- Confirming details: "yes" (when confirmation was asked), "looks good", "that's correct"
- Modifying: "change time to 6pm", "make it Monday", "update title"
- Answering questions: responding to "what time?", "which days?", "what title?"

**SMART CONTEXT AWARENESS**:
- If askedAboutPending = true AND user says yes/affirmative → ALWAYS "continue"
- If askedAboutPending = true AND user says no/negative → ALWAYS "cancel"
- If askedAboutPending = true AND user asks question → ALWAYS "details"
- If confirmationNeeded = true AND user says yes → "related" (confirming the reminder)
- If missingFields exist AND user provides info → "related" (filling missing fields)
- If user mentions specific times/dates/details → "related" (providing info)

**BE EXTREMELY FLEXIBLE** - Understand natural human communication:
- "yeah let's do this" → "continue"
- "sure thing" → "continue"
- "go ahead with it" → "continue"
- "yup continue" → "continue"
- "okay yes" → "continue"
- "nah forget it" → "cancel"
- "not interested" → "cancel"
- "skip this" → "cancel"
- "what was that again?" → "details"
- "huh?" (when asked about pending) → "details"

Examples:
"what's the weather?" → {"intent": "unrelated", "confidence": 100, "reasoning": "User asking about weather"}
"yes continue" → {"intent": "continue", "confidence": 100, "reasoning": "User wants to continue"}
"yeah let's do it" → {"intent": "continue", "confidence": 100, "reasoning": "Affirmative, wants to continue"}
"1" → {"intent": "continue", "confidence": 100, "reasoning": "Selected option 1 to continue"}
"sure thing" → {"intent": "continue", "confidence": 100, "reasoning": "Affirmative response"}
"haan chalo" → {"intent": "continue", "confidence": 100, "reasoning": "Yes in Urdu, wants to continue"}
"cancel it" → {"intent": "cancel", "confidence": 100, "reasoning": "User wants to cancel"}
"nah forget it" → {"intent": "cancel", "confidence": 100, "reasoning": "Rejection, wants to cancel"}
"2" → {"intent": "cancel", "confidence": 100, "reasoning": "Selected option 2 to cancel"}
"what was it?" → {"intent": "details", "confidence": 100, "reasoning": "Asking for details"}
"tell me more" → {"intent": "details", "confidence": 100, "reasoning": "Requesting more information"}
"3" → {"intent": "details", "confidence": 100, "reasoning": "Selected option 3 for details"}
"tomorrow at 5pm" → {"intent": "related", "confidence": 100, "reasoning": "Providing time for pending reminder"}
"yes" (if confirmationNeeded) → {"intent": "related", "confidence": 100, "reasoning": "Confirming the reminder"}

Return ONLY valid JSON, no markdown, no explanation.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text().trim();
    const jsonText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    console.log('🤖 User Intent Analysis for Pending Action:', jsonText);
    
    const analysis = JSON.parse(jsonText);
    return analysis;
    
  } catch (error) {
    console.error('Error analyzing user intent for pending action:', error);
    // Default to related to avoid breaking existing flow
    return {
      intent: 'related',
      confidence: 50,
      reasoning: 'Error in analysis, defaulting to related'
    };
  }
}

// Helper function to get a brief summary of pending reminder
function getPendingReminderSummary(pendingAction) {
  const data = pendingAction.data;
  const type = pendingAction.type === 'create_task' ? 'Task' : 
               pendingAction.type === 'schedule_meeting' ? 'Meeting' : 'Location Reminder';
  
  let summary = `${type}: "${data.title || 'Untitled'}"`;
  
  if (data.startDateISO) {
    const date = new Date(data.startDateISO);
    summary += ` on ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`;
    
    if (data.scheduleTime?.fixedTime) {
      summary += ` at ${data.scheduleTime.fixedTime}`;
    } else {
      summary += ` at ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'UTC' })}`;
    }
  }
  
  return summary;
}

// Helper function to get detailed summary of pending reminder
function getPendingReminderDetailedSummary(pendingAction) {
  const data = pendingAction.data;
  const type = pendingAction.type === 'create_task' ? 'Task' : 
               pendingAction.type === 'schedule_meeting' ? 'Meeting' : 'Location Reminder';
  
  let details = `📋 **Type**: ${type}\n`;
  details += `📝 **Title**: ${data.title || 'Not specified'}\n`;
  
  if (data.description) {
    details += `📄 **Description**: ${data.description}\n`;
  }
  
  if (data.startDateISO) {
    const date = new Date(data.startDateISO);
    details += `📅 **Date**: ${date.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })}\n`;
    
    if (data.scheduleTime?.fixedTime) {
      details += `⏰ **Time**: ${data.scheduleTime.fixedTime}\n`;
    } else {
      details += `⏰ **Time**: ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'UTC' })}\n`;
    }
  }
  
  if (data.isRoutine && data.scheduleDays !== undefined) {
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    
    if (data.scheduleDays.length === 0) {
      details += `🔁 **Routine**: Daily\n`;
    } else if (data.scheduleDays.length === 7) {
      details += `🔁 **Routine**: Daily\n`;
    } else {
      const days = data.scheduleDays.map(d => dayNames[d]).filter(n => n).join(', ');
      details += `🔁 **Routine**: ${days}\n`;
    }
  }
  
  if (pendingAction.confirmationNeeded) {
    details += `\n⏳ **Status**: Waiting for your confirmation`;
  } else if (pendingAction.missingFields && pendingAction.missingFields.length > 0) {
    details += `\n⏳ **Status**: Waiting for: ${pendingAction.missingFields.join(', ')}`;
  }
  
  return details;
}

// Helper function to detect if user wants to cancel reminder creation at any point
async function detectCancellationIntent(userMessage) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    
    const prompt = `You are detecting if a user wants to CANCEL or STOP a reminder creation process.

CRITICAL: You MUST respond in English ONLY. Understand user's intent in ANY language.

User's Message: "${userMessage}"

Determine if the user wants to CANCEL/STOP the reminder creation by using your understanding of their intent.

Return a JSON object with this EXACT structure:
{
  "wantsToCancel": boolean (true if user wants to cancel),
  "confidence": number (0-100),
  "reasoning": "brief explanation"
}

CRITICAL RULES:
- Be EXTREMELY sensitive to cancellation phrases
- "leave this", "forget it", "never mind", "stop" → wantsToCancel: true
- "rehne do", "chhod do", "nahi chahiye" → wantsToCancel: true
- If user is providing actual information (time, date, title), → wantsToCancel: false
- Only mark as false if user is clearly providing requested information

Examples:
"leave this" → {"wantsToCancel": true, "confidence": 100, "reasoning": "User wants to stop"}
"forget it" → {"wantsToCancel": true, "confidence": 100, "reasoning": "User wants to cancel"}
"never mind" → {"wantsToCancel": true, "confidence": 100, "reasoning": "User changed mind"}
"cancel this" → {"wantsToCancel": true, "confidence": 100, "reasoning": "Explicit cancellation"}
"rehne do" → {"wantsToCancel": true, "confidence": 100, "reasoning": "Cancel in Urdu"}
"nahi chahiye" → {"wantsToCancel": true, "confidence": 100, "reasoning": "Don't want in Urdu"}
"tomorrow at 5pm" → {"wantsToCancel": false, "confidence": 100, "reasoning": "Providing time information"}
"Call John" → {"wantsToCancel": false, "confidence": 100, "reasoning": "Providing title information"}

Return ONLY valid JSON, no markdown, no explanation.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text().trim();
    const jsonText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    console.log('🤖 Cancellation Intent Detection:', jsonText);
    
    const analysis = JSON.parse(jsonText);
    return analysis;
    
  } catch (error) {
    console.error('Error detecting cancellation intent:', error);
    // Default to false to avoid accidentally cancelling
    return {
      wantsToCancel: false,
      confidence: 0,
      reasoning: 'Error in analysis, defaulting to not cancel'
    };
  }
}

// Helper function to generate message for missing fields
function getMissingFieldsMessage(missingFields, extractedFields = {}) {
  const fieldNames = {
    title: 'title',
    time: 'time',
    date: 'date',
    description: 'description'
  };
  
  const fieldsList = missingFields.map(f => fieldNames[f] || f).join(', ');
  const extractedInfo = [];
  
  // Add any already extracted fields to the message
  if (extractedFields.title) extractedInfo.push(`Title: ${extractedFields.title}`);
  if (extractedFields.time) extractedInfo.push(`Time: ${extractedFields.time}`);
  if (extractedFields.date) extractedInfo.push(`Date: ${extractedFields.date}`);
  
  let message = '';
  if (extractedInfo.length > 0) {
    message += `I have ${extractedInfo.join(', ')}. `;
  }
  
  message += `I need a few more details to create this. Could you please provide the ${fieldsList}?`;
  
  return message;
}

module.exports = router;