const { google } = require('googleapis');
const { OAuth2 } = google.auth;
const Calendar = require('../models/calendarModel');
const User = require('../models/userModel');
const Reminder = require('../models/reminderModel');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const jwt = require('jsonwebtoken');

// Initialize Google OAuth2 client
const oauth2Client = new OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// ✅ Generate Google OAuth URL
const getAuthUrl = catchAsync(async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    throw new AppError('Please provide a valid token', 401);
  }

  const token = authHeader.split(' ')[1];

  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events'
    ],
    include_granted_scopes: true,
    prompt: 'consent',
    state: token
  });

  res.status(200).json({ status: 'success', data: { url } });
});

// ✅ Handle Google OAuth callback
const handleCallback = catchAsync(async (req, res, next) => {
  const { code, state: token } = req.query;
  if (!code) return next(new AppError('Authorization code is required', 400));
  if (!token) return res.status(400).send(`<p>Missing token</p>`);

  let user;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    user = await User.findById(decoded.id);
    if (!user) return res.status(400).send(`<p>User not found</p>`);
  } catch {
    return res.status(400).send(`<p>Invalid or expired token</p>`);
  }

  // Exchange code for tokens
  const { tokens } = await oauth2Client.getToken(code);
  if (!tokens.access_token) throw new Error('Failed to obtain access token');

  oauth2Client.setCredentials(tokens);

  // Fetch initial events
  const calendarApi = google.calendar({ version: 'v3', auth: oauth2Client });
  let events = [];
  try {
    const eventsResponse = await calendarApi.events.list({
      calendarId: 'primary',
      timeMin: new Date(new Date().setFullYear(new Date().getFullYear() - 1)).toISOString(),
      maxResults: 250,
      singleEvents: true,
      orderBy: 'startTime'
    });
    events = eventsResponse.data.items || [];
  } catch (err) {
    console.warn('Could not fetch initial events:', err.message);
  }

  // Save calendar data
  await Calendar.findOneAndUpdate(
    { user: user._id },
    {
      user: user._id,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenExpiry: new Date(tokens.expiry_date),
      events,
      lastSynced: new Date()
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return res.status(200).send(`<p>Google Calendar connected successfully. You can close this window.</p>`);
});

// ✅ Sync calendar events
const syncCalendar = catchAsync(async (req, res, next) => {
  const { user } = req;
  const calendar = await Calendar.findOne({ user: user._id });
  if (!calendar) return next(new AppError('Please connect Google Calendar first', 400));

  oauth2Client.setCredentials({
    access_token: calendar.accessToken,
    refresh_token: calendar.refreshToken,
    expiry_date: calendar.tokenExpiry?.getTime()
  });

  // Refresh token if expired
  if (calendar.tokenExpiry && new Date() > calendar.tokenExpiry) {
    const { token } = await oauth2Client.getAccessToken();
    if (token) calendar.accessToken = token;
    calendar.tokenExpiry = new Date(Date.now() + 55 * 60 * 1000); // 55 min safety window
    await calendar.save();
  }

  const calendarApi = google.calendar({ version: 'v3', auth: oauth2Client });
  const allEvents = [];
  let pageToken;
  const timeMin = new Date(new Date().setFullYear(new Date().getFullYear() - 1)).toISOString();

  do {
    const resp = await calendarApi.events.list({
      calendarId: 'primary',
      timeMin,
      maxResults: 2500,
      singleEvents: true,
      orderBy: 'startTime',
      pageToken
    });
    if (resp.data.items?.length) allEvents.push(...resp.data.items);
    pageToken = resp.data.nextPageToken;
  } while (pageToken);

  calendar.events = allEvents;
  
  // Note: Google Tasks integration removed. We only sync Calendar events now.

  calendar.lastSynced = new Date();
  await calendar.save();

  res.status(200).json({ status: 'success', data: { events: calendar.events, lastSynced: calendar.lastSynced } });
});

// ✅ Get unified calendar items (events + tasks + reminders)
const getCalendarItems = catchAsync(async (req, res) => {
  const { user } = req;
  
  // Parallel fetching for better performance
  const [calendar, reminders] = await Promise.all([
    Calendar.findOne({ user: user._id })
      .select('events lastSynced')
      .lean(), // Use lean() for faster queries
    Reminder.find({ user: user._id })
      .select('type title description icon startDate endDate location isCompleted aiSuggested isManualSchedule scheduleType scheduleTime scheduleDays createdAt')
      .sort({ startDate: -1 }) // Sort by most recent first
      .limit(500) // Limit to prevent excessive data transfer
      .lean() // Use lean() for faster queries
  ]);

  // Filter and map in a single pass for better performance
  const tasks = [];
  const meetings = [];
  
  for (const r of reminders) {
    if (r.type === 'Task') {
      tasks.push({
        id: r._id,
        title: r.title,
        description: r.description,
        icon: r.icon,
        startTime: r.startDate,
        endTime: r.endDate,
        location: r.location?.name || '',
        status: r.isCompleted ? 'completed' : 'pending',
        isCompleted: r.isCompleted,
        aiSuggested: r.aiSuggested,
        isManualSchedule: r.isManualSchedule,
        scheduleType: r.scheduleType,
        scheduleTime: r.scheduleTime,
        scheduleDays: r.scheduleDays,
        createdAt: r.createdAt
      });
    } else if (r.type === 'Meeting') {
      meetings.push({
        id: r._id,
        title: r.title,
        description: r.description,
        icon: r.icon,
        startTime: r.startDate,
        endTime: r.endDate,
        location: r.location?.name || '',
        aiSuggested: r.aiSuggested,
        createdAt: r.createdAt
      });
    }
  }

  // Limit events to reasonable timeframe (1 year past, 1 year future)
  const now = new Date();
  const oneYearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
  const oneYearAhead = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());
  
  const filteredEvents = calendar?.events 
    ? calendar.events.filter(ev => {
        const eventDate = new Date(ev.start?.dateTime || ev.start?.date);
        return eventDate >= oneYearAgo && eventDate <= oneYearAhead;
      })
    : [];

  res.status(200).json({
    status: 'success',
    data: {
      events: filteredEvents,
      tasks,
      meetings,
      lastSynced: calendar?.lastSynced || null
    }
  });
});

// ✅ Get only calendar events
const getCalendarEvents = catchAsync(async (req, res, next) => {
  const { user } = req;
  const calendar = await Calendar.findOne({ user: user._id }).select('events lastSynced');
  if (!calendar) return next(new AppError('No calendar found. Please sync Google Calendar first.', 404));

  res.status(200).json({ status: 'success', data: { events: calendar.events, lastSynced: calendar.lastSynced } });
});

module.exports = {
  getAuthUrl,
  handleCallback,
  syncCalendar,
  getCalendarEvents,
  getCalendarItems
};
