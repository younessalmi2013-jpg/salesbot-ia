'use strict';
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const EventEmitter = require('events');
const path = require('path');
const { execSync } = require('child_process');

function getChromiumPath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  const candidates = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
  for (const bin of candidates) {
    try {
      const p = execSync('which ' + bin, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
      if (p) return p;
    } catch (e) {}
  }
  return undefined;
}

class WhatsAppAgent extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.qrData = null;
    this.isReady = false;
    this.isInitializing = false;
    this.phoneNumber = null;
  }

  async initialize() {
    if (this.isInitializing || this.isReady) return;
    this.isInitializing = true;
    console.log('[WhatsApp] Initialisation...');
    try {
      this.client = new Client({
        authStrategy: new LocalAuth({ dataPath: path.join(process.cwd(), '.wwebjs_auth') }),
        puppeteer: {
          headless: true,
          executablePath: getChromiumPath(),
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-first-run',
            '--no-zygote',
            '--single-process'
          ]
        }
      });

      this.client.on('qr', async (qr) => {
        try {
          this.qrData = await qrcode.toDataURL(qr, { width: 256 });
          this.isReady = false;
          console.log('[WhatsApp] QR Code genere - scannez le!');
          this.emit('qr', this.qrData);
        } catch (e) {
          console.error('[WhatsApp] Erreur generation QR:', e.message);
        }
      });

      this.client.on('authenticated', () => {
        console.log('[WhatsApp] Authentifie!');
        this.qrData = null;
        this.emit('authenticated');
      });

      this.client.on('ready', async () => {
        this.isReady = true;
        this.isInitializing = false;
        this.qrData = null;
        try {
          const info = this.client.info;
          this.phoneNumber = info ? info.wid.user : null;
          console.log('[WhatsApp] Pret! Numero:', this.phoneNumber);
        } catch(e) {}
        this.emit('ready');
      });

      this.client.on('auth_failure', (msg) => {
        console.error('[WhatsApp] Echec authentification:', msg);
        this.isReady = false;
        this.isInitializing = false;
        this.emit('auth_failure', msg);
      });

      this.client.on('disconnected', (reason) => {
        console.log('[WhatsApp] Deconnecte:', reason);
        this.isReady = false;
        this.isInitializing = false;
        this.qrData = null;
        this.emit('disconnected', reason);
      });

      this.client.on('message', async (msg) => {
        if (!msg.fromMe) {
          await this._handleIncoming(msg);
        }
      });

      await this.client.initialize();
    } catch (e) {
      this.isInitializing = false;
      console.error('[WhatsApp] Erreur initialisation:', e.message);
    }
  }

  async _handleIncoming(msg) {
    try {
      const { generateAIResponse } = require('../../llm/openai');
      const crmAgent = require('../crm');
      const contact = await msg.getContact();
      const name = contact.pushname || contact.name || msg.from.split('@')[0];
      const phone = msg.from.replace('@c.us', '');
      let lead = await crmAgent.findLeadByPhone(phone);
      if (!lead) {
        lead = await crmAgent.createLead({
          name: name,
          phone: phone,
          channel: 'whatsapp',
          status: 'new',
          lastMessage: msg.body
        });
      } else {
        await crmAgent.updateLead(lead._id || lead.id, {
          lastMessage: msg.body,
          lastContact: new Date().toISOString()
        });
      }
      const response = await generateAIResponse({
        message: msg.body,
        channel: 'whatsapp',
        leadName: name,
        leadStatus: lead ? lead.status : 'new',
        history: lead ? lead.messages || [] : []
      });
      if (response) {
        await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
        await msg.reply(response);
        if (lead) {
          await crmAgent.addMessage(lead._id || lead.id, {
            from: 'bot',
            text: response,
            timestamp: new Date().toISOString()
          });
        }
      }
    } catch (e) {
      console.error('[WhatsApp] Erreur traitement message:', e.message);
    }
  }

  getQR() { return this.qrData; }

  getStatus() {
    return {
      connected: this.isReady,
      initializing: this.isInitializing,
      hasQR: !!this.qrData,
      phone: this.phoneNumber
    };
  }

  async sendMessage(phone, text) {
    if (!this.isReady) throw new Error('WhatsApp non connecte');
    const chatId = phone.includes('@c.us') ? phone : phone.replace(/\D/g, '') + '@c.us';
    return await this.client.sendMessage(chatId, text);
  }

  async logout() {
    if (this.client) {
      await this.client.logout();
      this.isReady = false;
      this.qrData = null;
    }
  }
}

const agent = new WhatsAppAgent();
module.exports = agent;
