'use strict';

const path = require('path');
const fs   = require('fs');

const WhatsAppBot = require('./bot');

// userId (number) → WhatsAppBot instance
const instances = new Map();

// Base data directory
const DATA_BASE = process.env.DATA_BASE || path.join(__dirname, '..', 'data', 'users');

function getUserDataDir(userId) {
  return path.join(DATA_BASE, String(userId), 'bot');
}

function ensureUserDirs(userId) {
  const base = getUserDataDir(userId);
  ['rm-media', 'flow-audio', 'camp-media', 'auth'].forEach(d => {
    fs.mkdirSync(path.join(base, d), { recursive: true });
  });
  return base;
}

// Get or create bot instance for a user
function getInstance(userId, io) {
  if (instances.has(userId)) return instances.get(userId);

  const dataDir = ensureUserDirs(userId);
  const bot = new WhatsAppBot(io, dataDir);
  instances.set(userId, bot);
  console.log(`[BOT-MANAGER] Instância criada para usuário ${userId} → ${dataDir}`);
  return bot;
}

// Get existing instance without creating
function getInstanceIfExists(userId) {
  return instances.get(userId) || null;
}

// Destroy instance (on account deletion)
async function destroyInstance(userId) {
  const bot = instances.get(userId);
  if (!bot) return;
  try { await bot.stop(); } catch {}
  instances.delete(userId);
  console.log(`[BOT-MANAGER] Instância destruída para usuário ${userId}`);
}

function listInstances() {
  return Array.from(instances.entries()).map(([uid, bot]) => ({
    userId: uid,
    status: bot.status,
    sessions: Object.keys(bot.userSessions || {}).length,
  }));
}

module.exports = { getInstance, getInstanceIfExists, destroyInstance, listInstances, getUserDataDir, ensureUserDirs };
