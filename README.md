# FaceVideo – Studio IA

Application web 100 % navigateur : script -> voix off (Fish Audio) -> clips (Magic Hour) -> montage (FFmpeg.wasm) -> export.

## Lancer
Les modules JavaScript ne fonctionnent pas en double-clic (`file://`). Il faut un petit serveur local :
- Windows : double-cliquer `lancer.bat` (Python requis)
- Mac/Linux : `./lancer.sh`
Puis ouvrir http://localhost:8080

## Structure
- `index.html` : interface
- `css/style.css` : thèmes jour/nuit
- `js/config.js` : URL/clé publique Supabase, endpoints API
- `js/app.js` : logique (script, TTS, pipeline IA, FFmpeg, export)
- `vendor/` : wrapper FFmpeg.wasm 0.12 et Supabase (le moteur FFmpeg de 32 Mo est chargé depuis unpkg/jsdelivr)

Tailwind, Font Awesome et Google Fonts restent chargés par CDN (connexion internet requise pour l'affichage).

## Corrections par rapport à la version monofichier
- Édition d'un segment et bouton "écouter" : ne fonctionnaient pas (variable hors portée du HTML inline).
- Échappement HTML des segments, titres de projets et messages (risque d'injection).
- Export WebM sans audio : échouait (copie H.264 vers WebM). Désormais ré-encodé en VP9.
- Vérification du code retour de FFmpeg, repli en ré-encodage si la concaténation directe échoue.
- Annulation réelle (arrêt de FFmpeg et de l'attente Magic Hour), délai maximum par clip.
- Lecture du lien de téléchargement Magic Hour (`downloads[0].url` ou `download_url`).
- Téléchargements propres (revokeObjectURL), format .webm correct en mode démo.
- Export/import des projets en JSON.

## Points à vérifier de votre côté
- Les paramètres exacts de l'API Magic Hour (`end_seconds`, `resolution`, modèle `ltx-2.5`) et l'en-tête `model` de Fish Audio n'ont pas pu être testés ici sans vos clés.
- Le téléchargement des clips Magic Hour depuis le navigateur dépend des en-têtes CORS de leur CDN.
- Le filigrane du plan gratuit n'apparaît que dans l'aperçu, pas incrusté dans la vidéo exportée.
- Les restrictions de plan (HD réservée à Creator) sont appliquées côté navigateur uniquement : à doubler côté serveur si vous monétisez.
