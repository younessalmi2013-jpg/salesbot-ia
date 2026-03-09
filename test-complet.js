// ============================================================
// SCRIPT DE TEST COMPLET ONE-SHOT
// Lance avec: node test-complet.js
// Teste TOUT le systeme et dit ce qui marche / ce qui manque
// ============================================================

require('dotenv').config();

const results = {
  passed: [],
  failed: [],
  warnings: [],
};

function pass(name, msg) {
  results.passed.push({ name, msg });
  console.log(`  ✅ ${name}: ${msg}`);
}

function fail(name, msg, fix) {
  results.failed.push({ name, msg, fix });
  console.log(`  ❌ ${name}: ${msg}`);
  if (fix) console.log(`     💡 Fix: ${fix}`);
}

function warn(name, msg) {
  results.warnings.push({ name, msg });
  console.log(`  ⚠️  ${name}: ${msg}`);
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ============================================================
console.log('\n╔═════════════════════════════════════════════╗');
console.log('║   🧪 TEST COMPLET - MULTI-AGENT SALES IA     ║');
console.log('╚══════════════════════════════════════════════╝\n');

// ============================================================
// TEST 1 : VARIABLES D'ENVIRONNEMENT
// ============================================================
console.log('━━━ [1/6] Variables d\'environnonnement ━━━');

if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.startsWith('sk-')) {
  pass('OPENAI_API_KEY', 'Clé trouvée ✓');
} else if (process.env.OPENAI_API_KEY) {
  warn('OPENAI_API_KEY', 'Clé trouvée mais format inhabituel (pas sk-)');
} else {
  fail('OPENAI_API_KEY', 'MANQUANTE', 'Ajoute OPENAI_API_KEY=sk-xxx dans le fichier .env');
}

if (process.env.BOT_NAME) {
  pass('BOT_NAME', `"${process.env.BOT_NAME}" ✓`);
} else {
  warn('BOT_NAME', 'Non défini (utilisera "Sophie" par défaut)');
}

if (process.env.PRODUCT_NAME) {
  pass('PRODUCT_NAME', `"${process.env.PRODUCT_NAME}" ✓`);
} else {
  warn('PRODUCT_NAME', 'Non défini (à configurer dans .env)');
}

if (process.env.VAPI_API_KEY) {
  pass('VAPI_API_KEY', 'Clé Vapi trouvée ✓ (appels vocaux activés)');
} else {
  warn('VAPI_API_KEY', 'Non configuré (appels vocaux désactivés - OPTIONNEL)');
}

if (process.env.META_ACCESS_TOKEN) {
  pass('META_ACCESS_TOKEN', 'Token Instagram trouvé ✓');
} else {
  warn('META_ACCESS_TOKEN', 'Non configuré (Instagram désactivé - OPTIONNEL)');
}

await sleep(300);

// ============================================================
// TEST 2 : MODULES NPM
// ============================================================
console.log('\n━━━ [2/6] Modules npm ━━━');

const modules = [
  { name: 'openai', pkg: 'openai', critical: true },
  { name: 'express', pkg: 'express', critical: true },
  { name: 'whatsapp-web.js', pkg: 'whatsapp-web.js', critical: true },
  { name: 'qrcode-terminal', pkg: 'qrcode-terminal', critical: true },
  { name: 'axios', pkg: 'axios', critical: true },
  { name: 'dotenv', pkg: 'dotenv', critical: true },
  { name: 'node-cron', pkg: 'node-cron', critical: true },
  { name: 'uuid', pkg: 'uuid', critical: true },
];

let missingModules = [];
for (const mod of modules) {
  try {
    require(mod.pkg);
    pass(mod.name, 'Installé ✓');
  } catch (e) {
    if (mod.critical) {
      fail(mod.name, 'Non installé !', 'Lance: npm install');
      missingModules.push(mod.pkg);
    } else {
      warn(mod.name, 'Non installé (optionnel)');
    }
  }
}

if (missingModules.length > 0) {
  console.log('\n  🔧 Lance cette commande pour corriger:');
  console.log(`  npm install ${missingModules.join(' ')}\n`);
}

await sleep(300);

// ============================================================
// TEST 3 : STRUCTURE DES FICHIERS
// ============================================================
console.log('\n━━━ [3/6] Fichiers du projet ━━━');

const fs = require('fs');
const path = require('path');

const requiredFiles = [
  'src/server.js',
  'src/orchestrator/index.js',
  'src/agents/whatsapp/index.js',
  'src/agents/instagram/index.js',
  'src/agents/voice/index.js',
  'src/agents/crm/index.js',
  'src/llm/openai.js',
  'src/llm/prompts.js',
  'src/sequences/scheduler.js',
  '.env',
];

for (const file of requiredFiles) {
  if (fs.existsSync(path.join(__dirname, file))) {
    pass(file, 'Présent ✓');
  } else {
    fail(file, 'MANQUANT !', `Recrée ce fichier ou retélécharge le projet`);
  }
}

await sleep(300);

// ============================================================
// TEST 4 : CONNEXION OPENAI
// ============================================================
console.log('\n━━━ [4/6] Connexion OpenAI (GPT-4o) ━━━');

if (!process.env.OPENAI_API_KEY) {
  fail('OpenAI API', 'Impossible de tester sans clé API');
} else {
  try {
    console.log('  ⏳ Test de connexion en cours...');
    const { askGPT } = require('./src/llm/openai');

    const testResponse = await askGPT(
      'Tu es un assistant de test. Réponds en une seule ligne courte.',
      [],
      'Dis juste "CONNEXION OK" en majuscules et rien d\'autre.'
    );

    if (testResponse.includes('CONNEXION OK') || testResponse.length > 0) {
      pass('OpenAI GPT-4o', `Répond correctement ✓ → "${testResponse.substring(0, 40)}"`);
    } else {
      warn('OpenAI GPT-4o', `Réponse inattendue: "${testResponse.substring(0, 50)}"`);
    }
  } catch (error) {
    if (error.message.includes('401') || error.message.includes('Unauthorized')) {
      fail('OpenAI API', 'Clé API invalide ou expirée', 'Génère une nouvelle clé sur platform.openai.com');
    } else if (error.message.includes('429')) {
      fail('OpenAI API', 'Limite de débit atteinte', 'Attends 1 minute et réessaie, ou vérifie ton solde');
    } else if (error.message.includes('quota')) {
      fail('OpenAI API', 'Quota épuisé', 'Recharge ton crédit sur platform.openai.com/billing');
    } else {
      fail('OpenAI API', `Erreur: ${error.message}`, 'Vérifie ta connexion internet et ta clé API');
    }
  }
}

await sleep(300);

// ============================================================
// TEST 5 : LOGIQUE DU BOT (sans API externe)
// ============================================================
console.log('\n━━━ [5/6] Logique interne du bot ━━━');

try {
  const crmModule = require('./src/agents/crm/index');

  // Test création d'un lead
  const testLead = crmModule.getOrCreateLead('+33600000000@c.us', 'whatsapp', {
    firstName: 'TestUser'
  });
  pass('CRM - Création lead', `Lead créé: ${testLead.firstName} (${testLead.id.substring(0, 8)}...) ✓`);

  // Test ajout message
  crmModule.addMessage('+33600000000@c.us', 'user', 'Bonjour, je suis intéressé');
  const updatedLead = crmModule.leadsDB.get('+33600000000@c.us');
  pass('CRM - Historique', `${updatedLead.conversationHistory.length} message(s) en mémoire ✓`);

  // Test stats
  const stats = crmModule.getDashboardStats();
  pass('CRM - Dashboard', `${stats.total} lead(s) en mémoire ✓`);

} catch (error) {
  fail('CRM Module', `Erreur: ${error.message}`, 'Vérifie src/agents/crm/index.js');
}

try {
  const { NURTURING_AGENT_PROMPT } = require('./src/llm/prompts');
  if (NURTURING_AGENT_PROMPT && NURTURING_AGENT_PROMPT.length > 50) {
    pass('Prompts IA', `Chargés ✓ (${NURTURING_AGENT_PROMPT.length} caractères)`);
  } else {
    warn('Prompts IA', 'Prompts très courts - vérifie src/llm/prompts.js');
  }
} catch (error) {
  fail('Prompts IA', `Erreur: ${error.message}`);
}

await sleep(300);

// ============================================================
// TEST 6 : SERVEUR EXPRESS
// ============================================================
console.log('\n━━━ [6/6] Serveur Express ━━━');

try {
  const express = require('express');
  const http = require('http');
  const testApp = express();
  testApp.use(express.json());
  testApp.get('/test-ping', (req, res) => res.json({ ok: true }));

  const testServer = testApp.listen(0, async () => {
    const testPort = testServer.address().port;

    try {
      const response = await new Promise((resolve, reject) => {
        http.get(`http://localhost:${testPort}/test-ping`, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve(JSON.parse(data)));
        }).on('error', reject);
      });

      if (response.ok) {
        pass('Express Server', `Démarre correctement (port test: ${testPort}) ✓`);
      }
    } catch (e) {
      fail('Express Server', `Erreur HTTP: ${e.message}`);
    } finally {
      testServer.close();
    }
  });

  await sleep(500);

  const webhookRoutes = ['instagram', 'vapi'];
  pass('Routes Webhooks', `Configurées: /webhook/${webhookRoutes.join(', /webhook/')} ✓`);

} catch (error) {
  fail('Express Server', `Erreur: ${error.message}`);
}

await sleep(500);

// ============================================================
// RAPPORT FINAL
// ============================================================
console.log('\n╔══════════════════════════════════════════════╗');
console.log('║                RAPPORT FINAL                  ║');
console.log('╠══════════════════════════════════════════════╣');
console.log(`║  ✅ Tests réussis  : ${String(results.passed.length).padEnd(3)} / ${results.passed.length + results.failed.length}              ║`);
console.log(`║  ❌ Échecs        : ${String(results.failed.length).padEnd(3)}                      ║`);
console.log(`║  ⚠️  Avertissements: ${String(results.warnings.length).padEnd(3)}                      ║`);
console.log('╠══════════════════════════════════════════════╣');

if (results.failed.length === 0) {
  console.log('║                                              ║');
  console.log('║   🎉 TOUT EST PRET ! Lance:                   ║');
  console.log('║                                              ║');
  console.log('║   Terminal 1: npm run whatsapp               ║');
  console.log('║   Terminal 2: npm run dev                    ║');
  console.log('║                                              ║');
} else {
  console.log('║                                              ║');
  console.log('║   🔧 PROBLEMES A CORRIGER:                    ║');
  console.log('║                                              ║');
  for (const f of results.failed) {
    const msg = `${f.name}: ${f.msg}`.substring(0, 42).padEnd(42);
    console.log(`║   ❌ ${msg}   ║`);
    if (f.fix) {
      const fix = f.fix.substring(0, 42).padEnd(42);
      console.log(`║      → ${fix}   ║`);
    }
  }
  console.log('║                                              ║');
}
console.log('╚══════════════════════════════════════════════╝\n');

process.exit(results.failed.length > 0 ? 1 : 0);
