# Monitoring AC — repères pour Claude

Outil de monitoring des emails d'automatisation ActiveCampaign : collecteur
Node sans dépendances (`scripts/fetch-metrics.mjs`), dashboard statique
autonome (`site/index.html`), relevé horaire + déploiement GitHub Pages via
`.github/workflows/monitor.yml`. Voir le README pour l'architecture complète.

## Préférences de travail (demandées par Sem)

- **Vérifications déléguées** (relectures, contre-vérifications, re-tests après
  correctifs) : utiliser un modèle moins cher aux performances proches
  (ex. `model: "opus"` pour les sous-agents), pas le modèle principal de la
  session. Réserver le modèle principal à la conception et aux correctifs.
- Pas de fan-out massif de vérification par défaut : vérifications ciblées,
  proportionnées au risque. Une passe exhaustive seulement sur demande explicite.

## Commandes utiles

```bash
node scripts/generate-demo-data.mjs   # dataset de démo → site/data/
node scripts/serve-site.mjs           # préviz locale http://127.0.0.1:8930
node scripts/mock-ac-server.mjs       # fausse API AC (port 8931, Api-Token: test)
node scripts/build-artifact.mjs       # dashboard autonome → dist/artifact.html

# Outil séparé (a ses propres dépendances npm, voir tools/mail-editor/README.md)
cd tools/mail-editor && npm test      # réécriture live/direct : extract → propose → review → apply
```

## tools/mail-editor (réécriture live/direct)

- Pipeline en étapes rejouables via `work/*.json` ; `work/` est **ignoré par
  git** (session navigateur AC = cookies, ne jamais le committer).
- Le formatage est préservé en ne touchant qu'aux nœuds texte du DOM (jamais
  de HTML régénéré) ; remplacements multi-nœuds découpés mot à mot (LCS).
- Sélecteurs volontairement génériques (`[contenteditable]` + iframes) :
  non validés contre l'éditeur AC réel, mode assisté par défaut.

## Pièges connus

- Les champs métriques de l'API AC sont des **chaînes** ; « cliqueurs uniques »
  = `subscriberclicks` (pas `uniquelinkclicks`, qui déduplique par lien).
- Les compteurs AC sont cumulés **et peuvent baisser** (suppressions de
  contacts) : le dashboard marque ces périodes `≈`, ne jamais supposer des
  deltas positifs.
- GitHub Pages est impossible sur dépôt privé + plan Free : le job
  `publication` se saute proprement tant que Pages n'est pas activé.
- `site/data/dataset.json` committé = données de démo tant que le vrai relevé
  n'a pas tourné ; le vrai relevé l'écrase.
