# Monitoring emails — ActiveCampaign

Outil de suivi des emails d'automatisation ActiveCampaign, avec dashboard web
consultable par lien public :

- **Taux d'ouverture, taux de clic, CTOR, rebonds durs et doux** — en chiffres
  absolus **et** en taux, partout.
- **Vue par période** : que s'est-il passé sur les dernières 48 h (ou 12 h, 24 h,
  72 h, 7 j, ou n'importe quelle durée personnalisée) ? Chaque période est
  comparée à la précédente.
- **Tendance globale** : cumul de tous les prospects depuis le début du suivi,
  avec mini-courbes d'évolution des taux.
- **Historique** : graphiques et tableau détaillé période par période.

Le tout est 100 % statique : un relevé automatique (GitHub Actions) interroge
l'API ActiveCampaign toutes les heures, enregistre les compteurs, et publie le
dashboard sur GitHub Pages. Aucun serveur à maintenir, aucune dépendance npm.

---

## Mise en route (une fois, ~5 minutes)

### 1. Renseigner les accès ActiveCampaign

Dans ActiveCampaign : **Paramètres → Développeur** → noter l'« URL » et la « Clé ».

Dans GitHub : **Settings → Secrets and variables → Actions → New repository secret** :

| Secret | Valeur |
|---|---|
| `AC_API_URL` | `https://VOTRECOMPTE.api-us1.com` |
| `AC_API_KEY` | la clé API |

### 2. Activer le lien public (GitHub Pages)

⚠️ **GitHub Pages n'est pas disponible sur un dépôt privé avec un compte GitHub
Free.** Deux options :

- **Option A (gratuite)** : passer ce dépôt en public
  (Settings → General → Danger Zone → Change visibility).
- **Option B** : garder le dépôt privé et prendre GitHub Pro (~4 $/mois).

Puis, dans les deux cas : **Settings → Pages → Source : « GitHub Actions »**.

Le dashboard sera servi sur **`https://semirwin.github.io/monitoring-AC/`** —
lien consultable par tout le monde, sans compte. Le workflow détecte tout seul
si Pages est activé : tant qu'il ne l'est pas, les relevés tournent quand même
et seule la publication est sautée.

> 🔓 À savoir : un site GitHub Pages est **public même si le dépôt est privé**.
> Les noms de vos emails/automatisations et leurs statistiques seront visibles
> par quiconque a le lien — c'est le but demandé, mais autant le savoir.

### 3. Premier relevé

Onglet **Actions → « Relevé des métriques AC » → Run workflow**. Ensuite le
relevé tourne tout seul **toutes les heures** (cron `23 * * * *`).

Les vues « par période » se remplissent au fil des relevés : comptez quelques
heures pour les premières périodes de 12 h, deux jours pour une période de 48 h
complète. La vue « cumul » fonctionne dès le premier relevé.

---

## Choisir les emails suivis

Par défaut, **tous les emails envoyés par des automatisations** sont suivis.
Pour restreindre, éditer [`config.json`](config.json) :

```jsonc
{
  "campaignIds": [],          // IDs d'emails précis (vide = pas de filtre)
  "automationIds": [],        // IDs d'automatisations (vide = toutes)
  "automationEmailsOnly": true // false = suivre aussi les campagnes ponctuelles
}
```

L'ID d'un email est visible dans l'URL de son rapport dans ActiveCampaign
(`.../campaign/123/...` → `123`) ; le dashboard permet de toute façon de
sélectionner chaque email, chaque automatisation (agrégée) ou le total.

## Utiliser le dashboard

- **Sélecteur d'email** : un email précis, une automatisation entière (somme de
  ses emails), ou tous les emails suivis.
- **Période** : 12 h / 24 h / 48 h / 72 h / 7 j / « Autre… » (1 à 720 h). Ce
  réglage pilote la section « Période en cours », les graphiques et le tableau.
- La sélection est mémorisée dans l'URL : copiez-collez le lien pour partager
  exactement la même vue.
- Symboles : `°` = période partielle (le suivi a commencé en cours de période) ;
  `≈` = période approximative (historique ancien compacté, ou compteur en baisse
  côté ActiveCampaign).

Les définitions exactes (délivrés, CTOR…) sont dans le dashboard, section
« Méthodologie et définitions ».

## Comment ça marche

```
ActiveCampaign API v3
        │  GET /api/3/campaigns + /api/3/automations (toutes les heures)
        ▼
scripts/fetch-metrics.mjs
        │  ajoute un relevé horodaté des compteurs cumulés par email
        ▼
data/snapshots/<id>.ndjson     (historique brut, compacté : 1 h → 6 h → 24 h)
site/data/dataset.json         (dataset consommé par le dashboard)
        │  commit + push (github-actions[bot])
        ▼
GitHub Pages  →  https://semirwin.github.io/monitoring-AC/
```

Les chiffres d'une période sont la **variation des compteurs** entre deux
relevés : nouveaux envois, nouveaux ouvreurs uniques (`uniqueopens`), nouveaux
cliqueurs uniques (`subscriberclicks`), nouveaux rebonds… Un contact qui ouvre
aujourd'hui un email reçu avant-hier est compté dans la période d'aujourd'hui.
L'API ActiveCampaign ne fournit pas l'historique horodaté des événements — le
suivi commence donc au premier relevé (le cumul « depuis toujours », lui, est
complet dès le premier relevé).

## Développement local

```bash
node scripts/generate-demo-data.mjs   # données de démonstration réalistes
node scripts/serve-site.mjs           # dashboard sur http://127.0.0.1:8930

# Tester le collecteur sans compte AC :
node scripts/mock-ac-server.mjs &
AC_API_URL=http://127.0.0.1:8931 AC_API_KEY=test node scripts/fetch-metrics.mjs

# Vrai relevé en local : copier .env.example en .env, puis
node scripts/fetch-metrics.mjs

# Instantané autonome (un seul fichier HTML, données incluses) :
node scripts/build-artifact.mjs       # → dist/artifact.html
```

## Dépannage

| Symptôme | Cause probable |
|---|---|
| Bandeau « dernier relevé il y a plus de 3 h » | Workflow en échec ou désactivé → onglet Actions. |
| « En attente des premières données » | Secrets absents, ou premier relevé pas encore lancé. |
| Étape Pages sautée (notice dans le log) | Pages pas activé → section « Activer le lien public ». |
| Échec HTTP 403 au relevé | `AC_API_URL` ou `AC_API_KEY` incorrects. |
| Un email n'apparaît pas | Jamais envoyé (0 envoi), ou exclu par `config.json`. |
