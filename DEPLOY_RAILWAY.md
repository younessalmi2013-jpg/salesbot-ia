# 🚀 Déploiement sur Railway

## Étapes en 5 minutes

### 1. Préparer le projet

```bash
# Crée un dépôt Git (si pas encore fait)
git init
git add .
git commit -m "Initial commit - SalesBot IA"
```

### 2. Créer un compte Railway

Aller sur → https://railway.app
Cliquer **Start a New Project** → **Deploy from GitHub repo**

### 3. Connecter GitHub

```bash
# Push sur GitHub
git remote add origin https://github.com/TON_USERNAME/salesbot-ia.git
git push -u origin main
```

### 4. Variables d'environnement sur Railway

Dans Railway > ton projet > **Variables**, ajouter :

| Variable | Valeur |
|---|---|
| `OPENAI_API_KEY` | sk-proj-... |
| `BOT_NAME` | SalesBot |
| `PRODUCT_NAME` | Mon Produit |
| `META_ACCESS_TOKEN` | (si Instagram) |
| `META_VERIFY_TOKEN` | montoken123 |
| `IG_ACCOUNT_ID` | (si Instagram) |
| `TELEGRAM_BOT_TOKEN` | (si Telegram) |
| `EMAIL_USER` | tonemail@gmail.com |
| `EMAIL_PASSWORD` | app-password-gmail |
| `VAPI_API_KEY` | (si appels vocaux) |
| `APP_URL` | https://TON-APP.railway.app |
| `NODE_ENV` | production |

### 5. Déployer

Railway déploie automatiquement après chaque `git push` !

```bash
git add .
git commit -m "Deploy"
git push
```

### 6. Configurer les Webhooks

Après déploiement, ton URL sera quelque chose comme :
`https://salesbot-ia-production.up.railway.app`

**Instagram :** Dans Meta Developer Console → Webhooks :
- URL de callback : `https://TON-APP.railway.app/webhook/instagram`
- Verify token : la valeur de `META_VERIFY_TOKEN`

**Vapi :** Dans Vapi Dashboard → Phone Numbers → Webhook :
- URL : `https://TON-APP.railway.app/webhook/vapi`

### 7. WhatsApp en local (ne tourne PAS sur Railway)

WhatsApp Web.js nécessite un navigateur local. Lance-le séparément :

```bash
# Sur ta machine locale
npm run whatsapp
```

Utilise **ngrok** pour exposer ton port local :
```bash
npx ngrok http 3001
```

---

## Alternative : VPS (DigitalOcean / Hetzner)

```bash
# Sur ton VPS Ubuntu
git clone https://github.com/TON_USERNAME/salesbot-ia.git
cd salesbot-ia
cp .env.example .env
nano .env  # Remplis tes clés
npm install
pm2 start src/server.js --name salesbot
pm2 save
pm2 startup
```

## 📊 URLs disponibles après déploiement

| URL | Description |
|---|---|
| `/` | Dashboard principal |
| `/booking` | Page de réservation |
| `/api/leads` | Liste des leads (JSON) |
| `/api/slots` | Créneaux disponibles |
| `/api/bookings` | Tous les rendez-vous |
| `/api/status` | Statut du système |
