// checker1_fast_fixed.js - Complete Ready to Run Code
const { Telegraf } = require('telegraf');
const {
  makeWASocket,
  useMultiFileAuthState,
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  delay,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const http = require('http');

// For Render.com health checks
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('🤖 WhatsApp Checker Bot is Running!\n');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

const BOT_TOKEN = process.env.BOT_TOKEN || '7390288812:AAGsGZriy4dprHYmQoRUZltMCmvTUitpz4I';
const ADMIN_ID = parseInt(process.env.ADMIN_ID) || 5624278091;
const AUTH_FOLDER = 'auth_info';
const CONCURRENCY = 100;
const USER_DATA_FILE = 'users.json';

let sock = null;
let isConnected = false;
let qrTimeout = null;

// User management system
let allowedUsers = new Set();
let pendingUsers = new Set();
let userNames = new Map();

// Load users from file
function loadUsers() {
  try {
    if (fs.existsSync(USER_DATA_FILE)) {
      const data = fs.readFileSync(USER_DATA_FILE, 'utf8');
      const users = JSON.parse(data);
      allowedUsers = new Set(users.allowedUsers || [ADMIN_ID]);
      pendingUsers = new Set(users.pendingUsers || []);
      userNames = new Map(users.userNames || []);
    } else {
      allowedUsers = new Set([ADMIN_ID]);
    }
  } catch (error) {
    console.error('Error loading users:', error);
    allowedUsers = new Set([ADMIN_ID]);
    pendingUsers = new Set();
    userNames = new Map();
  }
}

function saveUsers() {
  try {
    const data = {
      allowedUsers: Array.from(allowedUsers),
      pendingUsers: Array.from(pendingUsers),
      userNames: Array.from(userNames)
    };
    fs.writeFileSync(USER_DATA_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Error saving users:', error);
  }
}

function storeUserName(userId, name) {
  userNames.set(userId, name);
  saveUsers();
}

function isUserAllowed(userId) {
  return allowedUsers.has(userId);
}

loadUsers();

// WhatsApp Connection
async function getBaileysVersionSafe() {
  try {
    const { version } = await fetchLatestBaileysVersion();
    return version;
  } catch {
    return [2, 2209, 1];
  }
}

async function disconnectWA() {
  if (sock) {
    try { await sock.ws.close(); } catch {}
  }
  sock = null;
  isConnected = false;
  if (qrTimeout) clearTimeout(qrTimeout);
}

async function createWhatsAppConnection(ctx = null) {
  try {
    const authExists = fs.existsSync(AUTH_FOLDER);
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const version = await getBaileysVersionSafe();

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: Browsers.macOS('Safari'),
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (u) => {
      const { connection, qr, lastDisconnect } = u;

      if (qr) {
        if (ctx) {
          try {
            const qrImage = await QRCode.toBuffer(qr, { width: 350 });
            await ctx.replyWithPhoto({ source: qrImage }, { caption: '📲 Scan QR to link WhatsApp\n\n⏰ QR expires in 90 seconds' });
          } catch (error) {
            await ctx.reply(`📲 QR Code: ${qr}\n\n⏰ QR expires in 90 seconds`);
          }
        }
        qrTimeout = setTimeout(() => {
          if (!isConnected) {
            ctx?.reply('❌ QR expired. Send /connect again.');
            disconnectWA();
          }
        }, 90000);
      }

      if (connection === 'open') {
        isConnected = true;
        if (qrTimeout) clearTimeout(qrTimeout);
        console.log('✅ WhatsApp connected!');
        if (ctx) {
          await ctx.reply('✅ WhatsApp connected! Now you can send numbers to check.');
        }
      }

      if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode;
        isConnected = false;
        sock = null;
        if (reason === DisconnectReason.loggedOut) {
          if (ctx) {
            await ctx.reply('❌ Logged out from WhatsApp. Send /connect again.');
          }
          try {
            fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
          } catch (error) {
            console.error('Error removing auth folder:', error);
          }
        } else {
          console.log('🔁 Reconnecting WhatsApp...');
          await delay(5000);
          await createWhatsAppConnection(ctx);
        }
      }
    });
  } catch (e) {
    console.error('Connection error:', e);
    if (ctx) {
      await ctx.reply('❌ Failed to connect WhatsApp. Please try /connect again.');
    }
  }
}

// Auto reconnect if auth exists
(async () => {
  if (fs.existsSync(AUTH_FOLDER)) {
    console.log('🔄 Auth found → auto connecting WhatsApp...');
    await createWhatsAppConnection();
  } else {
    console.log('ℹ️ No auth found. Use /connect first time.');
  }
})();

// Telegram Bot
const bot = new Telegraf(BOT_TOKEN);

// Middleware to check user access and store names
bot.use(async (ctx, next) => {
  const userId = ctx.from.id;
  const userName = ctx.from.first_name || 'Unknown User';
  
  // Store user name
  if (!userNames.has(userId)) {
    storeUserName(userId, userName);
  }
  
  // Always allow start command
  if (ctx.message && ctx.message.text && ctx.message.text.startsWith('/start')) {
    return next();
  }
  
  // Always allow admin
  if (userId === ADMIN_ID) {
    return next();
  }
  
  // Check if user is allowed
  if (!isUserAllowed(userId)) {
    if (ctx.message) {
      await ctx.reply('❌ You are not authorized to use this bot. Please wait for admin approval.');
      
      // Add to pending and notify admin if not already pending
      if (!pendingUsers.has(userId)) {
        pendingUsers.add(userId);
        saveUsers();
        
        const userInfo = `🆕 New User Request:\n\n👤 Name: ${userName}\n🆔 ID: ${userId}\n📱 Username: @${ctx.from.username || 'N/A'}`;
        
        try {
          await bot.telegram.sendMessage(
            ADMIN_ID, 
            userInfo,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: '✅ Allow User', callback_data: `allow_${userId}` },
                    { text: '❌ Deny User', callback_data: `deny_${userId}` }
                  ]
                ]
              }
            }
          );
        } catch (error) {
          console.error('Error notifying admin:', error);
        }
      }
    }
    return;
  }
  
  await next();
});

// Handle callback queries (Allow/Deny buttons)
bot.on('callback_query', async (ctx) => {
  const callbackData = ctx.callbackQuery.data;
  const adminId = ctx.callbackQuery.from.id;
  
  if (adminId !== ADMIN_ID) {
    return ctx.answerCbQuery('❌ Only admin can use this!');
  }
  
  if (callbackData.startsWith('allow_')) {
    const userId = parseInt(callbackData.split('_')[1]);
    allowedUsers.add(userId);
    pendingUsers.delete(userId);
    saveUsers();
    
    await ctx.answerCbQuery('✅ User allowed!');
    await ctx.editMessageText(`✅ User ${userNames.get(userId) || userId} has been allowed to use the bot.`);
    
    // Notify the user
    try {
      await bot.telegram.sendMessage(userId, '🎉 Your access has been approved by admin! You can now use the bot.\n\nSend /connect to link WhatsApp and then send numbers to check.');
    } catch (error) {
      console.error('Could not notify user:', error);
    }
    
  } else if (callbackData.startsWith('deny_')) {
    const userId = parseInt(callbackData.split('_')[1]);
    pendingUsers.delete(userId);
    allowedUsers.delete(userId);
    saveUsers();
    
    await ctx.answerCbQuery('❌ User denied!');
    await ctx.editMessageText(`❌ User ${userNames.get(userId) || userId} has been denied access.`);
    
    // Notify the user
    try {
      await bot.telegram.sendMessage(userId, '❌ Your access request has been denied by admin.');
    } catch (error) {
      console.error('Could not notify user:', error);
    }
  } else if (callbackData.startsWith('toggle_')) {
    const userId = parseInt(callbackData.split('_')[1]);
    const userName = userNames.get(userId) || `User ${userId}`;
    
    if (allowedUsers.has(userId)) {
      allowedUsers.delete(userId);
      await ctx.answerCbQuery('❌ User access removed!');
      await ctx.editMessageText(`❌ ${userName}'s access has been disabled.`);
      
      // Notify the user
      try {
        await bot.telegram.sendMessage(userId, '❌ Your access to the bot has been disabled by admin.');
      } catch (error) {
        console.error('Could not notify user:', error);
      }
    } else {
      allowedUsers.add(userId);
      pendingUsers.delete(userId);
      await ctx.answerCbQuery('✅ User access granted!');
      await ctx.editMessageText(`✅ ${userName}'s access has been enabled.`);
      
      // Notify the user
      try {
        await bot.telegram.sendMessage(userId, '🎉 Your access to the bot has been enabled by admin.');
      } catch (error) {
        console.error('Could not notify user:', error);
      }
    }
    saveUsers();
  }
});

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const userName = ctx.from.first_name || 'User';
  
  if (userId === ADMIN_ID) {
    await ctx.reply(
      `👋 Welcome Admin ${userName}!\n\n` +
      `📋 Available Commands:\n` +
      `/connect - Link WhatsApp\n` +
      `/users - Manage users\n` +
      `/pending - Show pending requests\n` +
      `/stats - Show bot statistics\n` +
      `/status - Check bot status\n\n` +
      `🔧 Simply send numbers to check after connecting WhatsApp.`
    );
  } else if (isUserAllowed(userId)) {
    await ctx.reply(
      `👋 Welcome ${userName}!\n\n` +
      `📝 How to use:\n` +
      `1. Send /connect to link WhatsApp (first time only)\n` +
      `2. After connection, send numbers to check\n` +
      `3. You can send multiple numbers at once\n\n` +
      `📞 Supported formats:\n` +
      `7828124894\n` +
      `+18257976152\n` +
      `+1 (902) 912-2670\n` +
      `8257862503, 8733638775`
    );
  } else {
    await ctx.reply(
      `👋 Welcome ${userName}!\n\n` +
      `📨 Your access request has been sent to admin.\n` +
      `Please wait for approval. You will be notified when approved.\n\n` +
      `⏳ Status: Waiting for admin approval...`
    );
    
    // Add to pending and notify admin if not already pending
    if (!pendingUsers.has(userId)) {
      pendingUsers.add(userId);
      storeUserName(userId, userName);
      saveUsers();
      
      const userInfo = `🆕 New User Request:\n\n👤 Name: ${userName}\n🆔 ID: ${userId}\n📱 Username: @${ctx.from.username || 'N/A'}`;
      
      try {
        await bot.telegram.sendMessage(
          ADMIN_ID, 
          userInfo,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '✅ Allow User', callback_data: `allow_${userId}` },
                  { text: '❌ Deny User', callback_data: `deny_${userId}` }
                ]
              ]
            }
          }
        );
      } catch (error) {
        console.error('Error notifying admin:', error);
      }
    }
  }
});

bot.command('connect', async (ctx) => {
  if (!isUserAllowed(ctx.from.id) && ctx.from.id !== ADMIN_ID) {
    return ctx.reply('❌ You are not authorized to use this bot. Wait for admin approval.');
  }
  
  if (isConnected) {
    return ctx.reply('✅ WhatsApp is already connected! You can send numbers to check now.');
  }
  
  await ctx.reply('🔄 Connecting to WhatsApp... Please wait.');
  await createWhatsAppConnection(ctx);
});

// Admin commands
bot.command('users', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply('❌ Admin only command!');
  }
  
  const allowedList = Array.from(allowedUsers).filter(id => id !== ADMIN_ID);
  const pendingList = Array.from(pendingUsers);

  if (allowedList.length === 0 && pendingList.length === 0) {
    return ctx.reply('👥 No users found.');
  }

  let message = `👥 User Management\n\n`;
  
  if (allowedList.length > 0) {
    message += `✅ Allowed Users (${allowedList.length}):\n`;
    allowedList.forEach(userId => {
      const userName = userNames.get(userId) || `User ${userId}`;
      message += `• ${userName} (ID: ${userId})\n`;
    });
    message += `\n`;
  }
  
  if (pendingList.length > 0) {
    message += `⏳ Pending Requests (${pendingList.length}):\n`;
    pendingList.forEach(userId => {
      const userName = userNames.get(userId) || `User ${userId}`;
      message += `• ${userName} (ID: ${userId})\n`;
    });
  }

  // Create keyboard with toggle buttons for all users
  const keyboard = [];
  
  // Allowed users toggle buttons
  allowedList.forEach(userId => {
    const userName = userNames.get(userId) || `User ${userId}`;
    keyboard.push([
      { 
        text: `❌ Disable ${userName}`, 
        callback_data: `toggle_${userId}` 
      }
    ]);
  });
  
  // Pending users action buttons
  pendingList.forEach(userId => {
    const userName = userNames.get(userId) || `User ${userId}`;
    keyboard.push([
      { text: `✅ Allow ${userName}`, callback_data: `allow_${userId}` },
      { text: `❌ Deny ${userName}`, callback_data: `deny_${userId}` }
    ]);
  });

  await ctx.reply(message, {
    reply_markup: {
      inline_keyboard: keyboard
    }
  });
});

bot.command('pending', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply('❌ Admin only command!');
  }
  
  const pendingList = Array.from(pendingUsers).slice(0, 20);

  if (pendingList.length === 0) {
    return ctx.reply('✅ No pending user requests.');
  }

  let message = `⏳ Pending Requests: ${pendingList.length}\n\n`;
  const keyboard = [];

  for (const userId of pendingList) {
    const userName = userNames.get(userId) || `User ${userId}`;
    message += `👤 ${userName}\n🆔 ${userId}\n\n`;
    
    keyboard.push([
      { text: `✅ Allow ${userName}`, callback_data: `allow_${userId}` },
      { text: `❌ Deny ${userName}`, callback_data: `deny_${userId}` }
    ]);
  }

  await ctx.reply(message, {
    reply_markup: {
      inline_keyboard: keyboard
    }
  });
});

bot.command('stats', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply('❌ Admin only command!');
  }
  
  const stats = {
    totalUsers: allowedUsers.size - 1,
    pendingUsers: pendingUsers.size,
    whatsappStatus: isConnected ? 'Connected' : 'Disconnected',
    authExists: fs.existsSync(AUTH_FOLDER),
    uptime: Math.floor(process.uptime() / 60) + ' minutes'
  };
  
  await ctx.reply(
    `📊 Bot Statistics:\n\n` +
    `👥 Allowed Users: ${stats.totalUsers}\n` +
    `⏳ Pending Requests: ${stats.pendingUsers}\n` +
    `📱 WhatsApp: ${stats.whatsappStatus}\n` +
    `🔐 Auth: ${stats.authExists ? 'Exists' : 'Not Found'}\n` +
    `⏰ Uptime: ${stats.uptime}\n` +
    `🖥️ Server: Render.com`
  );
});

bot.command('status', async (ctx) => {
  const statusMessage = `
🤖 Bot Status:

📱 WhatsApp: ${isConnected ? '✅ Connected' : '❌ Disconnected'}
⏰ Uptime: ${Math.floor(process.uptime() / 60)} minutes
💾 Memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB
👥 Allowed Users: ${allowedUsers.size - 1}
⏳ Pending Requests: ${pendingUsers.size}
🔗 Server: Render.com
🆔 Your ID: ${ctx.from.id}
  `;
  
  await ctx.reply(statusMessage);
});

// Number checking function
function extractNumbers(text) {
  const numbers = Array.from(
    new Set(
      (text.match(/[\+]?[1]?[-\s\.]?[(]?(\d{3})[)]?[-\s\.]?(\d{3})[-\s\.]?(\d{4})|\d{10,15}/g) || []).map((n) => {
        // Remove all non-digit characters first
        const cleanDigits = n.replace(/\D/g, '');
        
        // If number is 10 digits, add +1 (US/Canada)
        if (cleanDigits.length === 10) {
          return '+1' + cleanDigits;
        }
        // If number is 11 digits and starts with 1, add +
        else if (cleanDigits.length === 11 && cleanDigits.startsWith('1')) {
          return '+' + cleanDigits;
        }
        // For other lengths, just add +
        else {
          return '+' + cleanDigits;
        }
      })
    )
  );
  
  return numbers.filter(n => n.length >= 12); // Filter valid numbers (at least +1XXXXXXXXXX)
}

async function checkNumbers(ctx, numbers) {
  if (!isConnected || !sock) {
    return ctx.reply('❌ WhatsApp is not connected. Please send /connect first.');
  }

  const processingMsg = await ctx.reply(`🔍 Checking ${numbers.length} numbers...\n\n⏳ Please wait, this may take a few seconds.`);

  const results = [];
  for (let i = 0; i < numbers.length; i += CONCURRENCY) {
    const chunk = numbers.slice(i, i + CONCURRENCY);
    const promises = chunk.map(async (num) => {
      try {
        const clean = num.replace(/\D/g, '');
        const res = await sock.onWhatsApp(clean);
        // FIXED: Always treat empty array as "Fresh"
        const exists = Array.isArray(res) && res.length > 0 && res[0]?.exists === true;
        return { num, exists };
      } catch (error) {
        console.error(`Error checking ${num}:`, error);
        return { num, exists: null };
      }
    });
    const settled = await Promise.all(promises);
    results.push(...settled);
    
    // Small delay between chunks to avoid rate limiting
    if (i + CONCURRENCY < numbers.length) {
      await delay(1000);
    }
  }

  const lalBaba = results.filter((r) => r.exists === true).map((r) => r.num);
  const fresh = results.filter((r) => r.exists === false).map((r) => r.num);
  const errorNums = results.filter((r) => r.exists === null).map((r) => r.num);

  // Delete processing message
  try {
    await ctx.deleteMessage(processingMsg.message_id);
  } catch (error) {
    console.error('Error deleting message:', error);
  }

  // Send results
  if (lalBaba.length > 0) {
    await ctx.reply(`🚫 Lal Baba (${lalBaba.length})\n${lalBaba.join('\n')}`);
  } else {
    await ctx.reply('✅ No Lal Baba numbers found.');
  }

  if (fresh.length > 0) {
    await ctx.reply(`✅ Fresh Numbers (${fresh.length})\n${fresh.join('\n')}`);
  } else {
    await ctx.reply('ℹ️ No Fresh numbers found.');
  }

  if (errorNums.length > 0) {
    await ctx.reply(`⚠️ Failed to check ${errorNums.length} numbers. Please try again.`);
  }
}

// Handle text messages (number checking)
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  
  // Ignore commands
  if (text.startsWith('/')) return;
  
  const nums = extractNumbers(text);
  if (nums.length === 0) {
    return ctx.reply('❌ No valid numbers found in your message.\n\n📞 Supported formats:\n7828124894\n+18257976152\n+1 (902) 912-2670');
  }
  
  await checkNumbers(ctx, nums);
});

// Start bot
bot.launch().then(() => {
  console.log('🤖 Bot started successfully on Render!');
  console.log('📱 Bot is ready to receive messages');
}).catch(err => {
  console.error('❌ Bot failed to start:', err);
});

// Keep alive system for 24/7
process.on('uncaughtException', (error) => {
  console.error('🔄 Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🔄 Unhandled Rejection at:', promise, 'reason:', reason);
});

// Auto-restart WhatsApp if disconnected
setInterval(() => {
  if (!isConnected && fs.existsSync(AUTH_FOLDER)) {
    console.log('🔄 Auto-reconnecting WhatsApp...');
    createWhatsAppConnection();
  }
}, 30000); // 30 seconds

// Status monitor
setInterval(() => {
  const status = {
    whatsapp: isConnected ? '✅ Connected' : '❌ Disconnected',
    uptime: Math.floor(process.uptime() / 60) + ' minutes',
    memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + ' MB',
    users: allowedUsers.size - 1
  };
  
  console.log('📊 Status:', status);
}, 300000); // 5 minutes

console.log('🚀 WhatsApp Number Checker Bot Started!');
console.log('💡 Send /start to begin');
console.log('🔧 Admin ID:', ADMIN_ID);
