// Configuration publique de FaceVideo.
// La clé "anon" Supabase est publique par conception (protégée par les règles RLS côté base).
// NE JAMAIS mettre ici la clé "service_role" ni vos clés Magic Hour / Fish Audio.
export const SUPABASE_URL = 'https://gxjhkjpxpahgoiezdzxl.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd4amhranB4cGFoZ29pZXpkenhsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ3NTU2NzIsImV4cCI6MjExMDMzMTY3Mn0.yL2PldZ4b9KFC9DzXPBwti-CQnpNLPKD1wUHhDWcr1c';

// Durée d'un segment/clip en secondes
export const SEGMENT_SECONDS = 5;

// Endpoints API
export const FISH_TTS_URL = 'https://api.fish.audio/v1/tts';
export const FISH_MODEL = 's2.1-pro-free';
export const MAGIC_HOUR_BASE = 'https://api.magichour.ai/v1';
export const MAGIC_HOUR_MODEL = 'ltx-2.5';
