// ============================================================
// FICHIER: src/llm/test.js
// ROLE: Test rapide pour verifier que OpenAI fonctionne
//       Lance avec: npm run test:openai
// ============================================================

require('dotenv').config();
const { askGPT } = require('./openai');

async function testOpenAI() {
  console.log('🧪 Test de connexion OpenAI...\n');

  if (!process.env.OPENAI_API_KEY) {
    console.error('❌ OPENAI_API_KEY manquant dans le fichier .env');
    process.exit(1);
  }

  try {
    const response = await askGPT(
      'Tu es un assistant de test. Reponds de facon courte.',
      [],
      'Dis juste: "OpenAI fonctionne correctement !" en ajoutant un emoji.'
    );

    console.log('✅ OpenAI repond:', response);
    console.log('\n🎉 Tout fonctionne ! Tu peux demarrer le projet.');
  } catch (error) {
    console.error('❌ Erreur OpenAI:', error.message);
    console.log('\n💡 Verifie que ta cle OPENAI_API_KEY est correcte dans .env');
  }
}

testOpenAI();
