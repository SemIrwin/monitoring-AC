# ac-mail-editor — réécrire « live » / « direct » dans une automatisation

Outil semi-automatique pour passer sur **chaque email d'une automatisation
ActiveCampaign** et remplacer les mentions de « live » et « direct » par des
équivalents qui évoquent un moment partagé **sans** affirmer le direct ni
laisser deviner une rediffusion — en **conservant le formatage existant**
(gras, liens, couleurs…).

## Règles de réécriture

| Cas | Remplacement |
|---|---|
| `live` suivi de `vip` | **session** (accords autour : *le live VIP* → *la session VIP*) |
| `live` seul | **rendez-vous** |
| `en direct` (« je suis en direct », « on est en direct »…) | reformulation au cas par cas : *lancement, show, programme, session, événement…* |
| `direct` dans un autre sens (*réponse directe*, *accès direct*) | non modifié (marqué « confiance basse » pour vérification) |

Interdits dans toute réécriture : *live, en direct, rediffusion, replay,
enregistré(ment)* — un filet de sécurité les bloque à chaque étape (moteur de
règles, réponse LLM, interface de revue).

## Principe : rien n'est modifié sans validation

```
API AC (liste des emails de l'automatisation)
        │
        ▼
[extract]  Playwright ouvre chaque email dans l'éditeur AC et extrait les
           nœuds texte de chaque bloc            → work/extraction.json
        ▼
[propose]  moteur de règles + LLM Claude (accords, reformulations)
                                                  → work/proposals.json
        ▼
[review]   UI locale : chaque occurrence est montrée en contexte,
           éditable, approuvée ou rejetée         → work/approved.json
        ▼
[apply]    Playwright réécrit UNIQUEMENT les nœuds texte approuvés
           (jamais le HTML : le formatage est intact par construction),
           email par email, sous tes yeux ; l'enregistrement dans AC
           reste un clic manuel                   → work/applied.json
```

Garde-fous techniques :

- **Formatage préservé par construction** : on ne régénère jamais de HTML,
  on modifie la valeur des nœuds texte du DOM. Un remplacement qui chevauche
  du formatage (« le **live** VIP » → « la **session** VIP ») est découpé
  mot à mot pour que chaque mot remplacé reste dans son nœud (son style).
- **Détection de dérive** : à l'application, chaque nœud est comparé au texte
  extrait ; si l'email a changé entre-temps, le bloc est refusé (rien de
  partiellement écrit).
- **Captures d'écran** avant/après dans `work/screenshots/`.
- L'édition passe par l'éditeur visuel (Playwright) et non par l'API v1
  `message_edit` : modifier le HTML par API désynchroniserait le JSON du
  designer d'ActiveCampaign.

## Installation

```bash
cd tools/mail-editor
npm install
npx playwright install chromium   # si Chromium n'est pas déjà présent
```

Variables (le `.env` à la racine du dépôt est lu automatiquement) :

| Variable | Rôle |
|---|---|
| `AC_API_URL`, `AC_API_KEY` | déjà utilisées par le monitoring (liste des emails) |
| `AC_ACCOUNT_URL` | URL de l'app (`https://compte.activehosted.com`) — déduite de `AC_API_URL` sinon |
| `ANTHROPIC_API_KEY` | facultatif : active les propositions LLM |
| `AC_EDITOR_MODEL` | modèle Claude (défaut `claude-opus-5`) |

## Utilisation

```bash
node cli.mjs login                                # une fois : connexion AC (MFA ok), session conservée
node cli.mjs extract --automation "Ma séquence"   # ou un id, ou l'URL …/series/123
node cli.mjs propose                              # --no-llm pour les heuristiques seules
node cli.mjs review                               # http://127.0.0.1:8940 — valider/éditer
node cli.mjs apply --dry-run                      # récapitulatif sans rien toucher
node cli.mjs apply                                # application, email par email
```

Pour essayer sans compte ActiveCampaign :

```bash
node cli.mjs demo && node cli.mjs propose --no-llm && node cli.mjs review
```

### Navigation dans l'éditeur : assistée par défaut

ActiveCampaign change régulièrement son éditeur et ses URLs. Par défaut,
`extract` et `apply` sont **assistés** : l'outil ouvre le navigateur, te
demande d'afficher l'éditeur de l'email concerné, puis travaille tout seul
(extraction ou remplacement). Si tes URLs d'édition sont stables, passe en
navigation automatique :

```bash
node cli.mjs extract --automation 123 \
  --url-template "https://compte.activehosted.com/app/campaigns/{id}/edit"
```

`apply` réutilise l'URL mémorisée à l'extraction quand elle existe.

### Ce qui reste à valider sur le vrai compte

La découverte des blocs est générique (`[contenteditable]` dans la page et
ses iframes + champs objet/pré-en-tête) et testée contre un éditeur simulé
(`test/fixtures/mock-editor.html`). Elle n'a **pas encore été validée contre
l'éditeur ActiveCampaign réel** : au premier passage, vérifier sur un email
que l'extraction couvre bien tous les blocs (le compte de blocs est affiché),
et faire un `apply` sur un seul email (`--email <id>`) avant la série.

## Tests

```bash
npm test          # moteur de règles + projection sur les nœuds texte
npm run test:e2e  # extraction/application dans un vrai Chromium (fixture)
```

## Sécurité / vie privée

`work/` est ignoré par git : il contient la **session navigateur AC
(cookies)**, les textes extraits et les captures. Ne jamais le committer.
