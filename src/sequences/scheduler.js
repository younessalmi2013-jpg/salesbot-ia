// ============================================================
// FICHIER: src/sequences/scheduler.js
// ROLE: Planificateur automatique de relances
//       Verifie toutes les heures si des leads ont besoin de relance
//       et les envoie automatiquement
// ============================================================

require('dotenv').config();
const cron = require('node-cron');
const { getLeadsNeedingFollowup } = require('../agents/crm/index');
const { sendFollowup } = require('../orchestrator/index');

let isRunning = false;

/**
 * Demarre le planificateur de relances
 * Tourne toutes les heures de 9h a 20h du lundi au samedi
 */
function startScheduler() {
  console.log('⏰ Planificateur de relances demarre');

  // Verifie toutes les heures entre 9h et 20h (lundi-samedi)
  cron.schedule('0 9-20 * * 1-6', async () => {
    await checkAndSendFollowups();
  }, {
    timezone: 'Europe/Paris',  // Adapte a ton fuseau horaire
  });

  // Pour tester: verifie aussi toutes les 30 minutes
  // cron.schedule('*/30 * * * *', async () => {
  //   await checkAndSendFollowups();
  // });

  console.log('✅ Relances automatiques: Lun-Sam, 9h-20h (Paris)');
}

/**
 * Verifie et envoie les relances necessaires
 */
async function checkAndSendFollowups() {
  // Evite d'executer en parallele si la derniere execution est encore en cours
  if (isRunning) {
    console.log('⏭️  Planificateur: execution precedente encore en cours, skip');
    return;
  }

  isRunning = true;

  try {
    const followupsNeeded = getLeadsNeedingFollowup();

    if (followupsNeeded.length === 0) {
      console.log('✅ Planificateur: aucune relance necessaire pour l\'instant');
      isRunning = false;
      return;
    }

    console.log(`\n¯Planificateur: ${followupsNeeded.length} relance(s) a envoyer`);

    for (const { lead, followupNumber } of followupsNeeded) {
      console.log(`📤 Relance #${followupNumber} pour ${lead.firstName} (${lead.contactId})`);

      // Attends 2 secondes entre chaque relance pour ne pas saturer les APIs
      await new Promise(resolve => setTimeout(resolve, 2000));

      await sendFollowup(lead, followupNumber);
    }

    console.log(`✅ Planificateur: ${followupsNeeded.length} relance(s) envoyee(s)`);

  } catch (error) {
    console.error('❌ Erreur planificateur:', error.message);
  } finally {
    isRunning = false;
  }
}

module.exports = { startScheduler, checkAndSendFollowups };
