// utils.ts
// Fonctions utilitaires
export function isValidUrl(str: string): boolean {
  if (str.length > 2048) return false;
  try {
    const url = new URL(str);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}