// FICHIER: src/agents/voice/index.js
require('dotenv').config();
const axios = require('axios');
let getVoiceScript, autoSelectScript, VOICE_SCRIPTS;
try {
  ({ getVoiceScript, autoSelectScript, VOICE_SCRIPTS } = require('../../llm/voiceScripts'));
} catch(e) {
  getVoiceScript = (s,v) => `Tu es Sophie, assistante commerciale. Objectif (${s}): aider ${v.leadName}.`;
  autoSelectScript = () => 'prospection';
  VOICE_SCRIPTS = {};
}
const { updateLead, LEAD_STATUS } = require('../crm/index');
const VAPI_KEY = process.env.VAPI_API_KEY;
const VAPI_URL = 'https://api.vapi.ai';

async function makeCall(c) {
  if (!VAPI_KEY || !process.env.VAPI_PHONE_NUMBER_ID) return { callId:null, status:'skipped' };
  const { phone, leadName='prospect', leadContext='', lead } = c;
  const scriptType = c.scriptType || autoSelectScript(lead);
  const systemPrompt = getVoiceScript(scriptType, { leadName, leadContext });
  const phoneNumber = formatPhone(phone);
  try {
    const body = process.env.VAPI_ASSISTANT_ID ? {
      phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
      assistantId: process.env.VAPI_ASSISTANT_ID,
      customer: { number: phoneNumber, name: leadName },
      assistantOverrides: { model: { messages: [{ role:'system', content: systemPrompt }] }, variableValues: { leadName, leadContext, scriptType } }
    } : {
      phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
      customer: { number: phoneNumber, name: leadName },
      assistant: {
        model: { provider:'openai', model:'gpt-4o', messages:[{ role:'system', content: systemPrompt }], temperature:0.7 },
        voice: { provider: process.env.VAPI_VOICE_PROVIDER||'elevenlabs', voiceId: process.env.VAPI_VOICE_ID||'pFZP5JQG7iQjIQuC4Bku' },
        transcriber: { provider:'deepgram', language:'fr' },
        firstMessage: `Bonjour ${leadName} ! C'est Sophie. Vous avez une minute ?`,
        endCallMessage: 'Merci ! Bonne journee !',
        maxDurationSeconds: 900, backgroundSound:'office',
        voicemailDetection: { provider:'twilio' }, endCallFunctionEnabled: true
      }
    };
    const res = await axios.post(`${VAPI_URL}/call`, body, { headers: { Authorization:`Bearer ${VAPI_KEY}`, 'Content-Type':'application/json' }, timeout:15000 });
    console.log('[Voice] Appel lance:', res.data.id);
    return { callId: res.data.id, status:'initiated', scriptType };
  } catch(err) {
    console.error('[Voice] Erreur:', err.response?.data || err.message);
    return { callId:null, status:'error', error: err.message };
  }
}

async function handleVapiWebhook(req, res) {
  res.sendStatus(200);
  const { type } = req.body.message || {};
  if (type === 'call-ended') {
    const { call={}, analysis={} } = req.body.message;
    console.log('[Voice] Appel termine. Resume:', analysis.summary);
    if (call.metadata?.leadId) {
      await updateLead(call.metadata.leadId, {
        status: analysis.successEvaluation==='true' ? LEAD_STATUS.QUALIFIED : LEAD_STATUS.CONTACTED,
        lastCallId: call.id, lastCallSummary: analysis.summary||'', lastContactAt: new Date().toISOString()
      }).catch(e => console.error('[Voice] CRM:', e.message));
    }
  }
}

async function getCallDetails(id) {
  if (!VAPI_KEY) return null;
  try { return (await axios.get(`${VAPI_URL}/call/${id}`, { headers: { Authorization:`Bearer ${VAPI_KEY}` } })).data; } catch(e) { return null; }
}

async function getCallHistory(limit=20) {
  if (!VAPI_KEY) return [];
  try { return (await axios.get(`${VAPI_URL}/call`, { headers: { Authorization:`Bearer ${VAPI_KEY}` }, params: { limit } })).data||[]; } catch(e) { return []; }
}

function formatPhone(p) {
  let n = (p||'').replace(/[^\d+]/g,'');
  if (n.startsWith('0')) n = '+33' + n.substring(1);
  if (!n.startsWith('+')) n = '+33' + n;
  return n;
}

function listScripts() {
  const scripts = ['prospection','qualification','prise_rdv','relance','suivi_post_rdv','recuperation','no_show','urgence','confirmation_rdv','upsell'];
  const desc = { prospection:'Premier contact cold', qualification:'Qualifier lead entrant (BANT)', prise_rdv:'Planifier un RDV', relance:'Lead froid silencieux', suivi_post_rdv:'Suivi apres demo', recuperation:'Recuperer client perdu', no_show:'Prospect absent RDV', urgence:'Lead tres chaud urgent', confirmation_rdv:'Confirmer RDV (J-1)', upsell:'Upsell client actif' };
  return scripts.map(k => ({ key:k, description:desc[k]||k }));
}

module.exports = { makeCall, handleVapiWebhook, getCallDetails, getCallHistory, listScripts, formatPhone };
